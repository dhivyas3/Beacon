import { createSafeClient, type SafeClient } from '@qa-hub/net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { offlineResolver, silentLog, startSites, type Sites } from '../test/harness.js';
import { RateLimiter } from '../util/rate-limit.js';
import {
  discoverPages,
  DiscoveryError,
  extractLinks,
  parseRobots,
  parseSitemap,
  type DiscoveryOptions,
} from './discovery.js';

describe('parseSitemap', () => {
  it('reads urlset locations, decoding entities and CDATA', () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://x.com/a?x=1&amp;y=2</loc></url>
        <url><loc>
          https://x.com/b
        </loc></url>
        <url><loc><![CDATA[https://x.com/c?d=1&e=2]]></loc></url>
      </urlset>`;
    expect(parseSitemap(xml)).toEqual({
      kind: 'urlset',
      locations: ['https://x.com/a?x=1&y=2', 'https://x.com/b', 'https://x.com/c?d=1&e=2'],
    });
  });

  it('recognises a sitemap index', () => {
    const xml = `<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({ kind: 'index', locations: ['https://x.com/s1.xml'] });
  });

  it('returns nothing for garbage', () => {
    expect(parseSitemap('not xml at all').locations).toEqual([]);
  });
});

describe('parseRobots', () => {
  it('collects sitemaps and spots a blanket Disallow for everyone', () => {
    const robots = parseRobots(
      ['# comment', 'User-agent: *', 'Disallow: /', 'Sitemap: https://x.com/sitemap.xml'].join(
        '\n',
      ),
    );
    expect(robots).toEqual({ disallowAll: true, sitemaps: ['https://x.com/sitemap.xml'] });
  });

  it('ignores Disallow: / for other bots and partial disallows', () => {
    expect(parseRobots('User-agent: BadBot\nDisallow: /').disallowAll).toBe(false);
    expect(parseRobots('User-agent: *\nDisallow: /admin').disallowAll).toBe(false);
    expect(parseRobots('User-agent: *\nDisallow:').disallowAll).toBe(false);
  });

  it('handles grouped user agents and CRLF line endings', () => {
    const text = 'User-agent: BadBot\r\nUser-agent: *\r\nDisallow: /\r\n';
    expect(parseRobots(text).disallowAll).toBe(true);
  });
});

describe('extractLinks', () => {
  it('resolves relative links against the page and honours <base>', () => {
    const html = `<html><head><base href="/docs/"></head><body>
      <a href="guide">guide</a> <a href="/root">root</a> <a href="https://other.com/x">x</a>
      <a href="#frag">frag</a> <a>no href</a></body></html>`;
    const links = extractLinks(html, 'https://x.com/index');
    expect(links).toContain('https://x.com/docs/guide');
    expect(links).toContain('https://x.com/root');
    expect(links).toContain('https://other.com/x');
    expect(links).toHaveLength(4);
  });

  it('survives broken markup and script blocks that contain angle brackets', () => {
    const html = `<a href="/one">1<script>if (a < b) { document.write('<a href="/nope">') }</script>
      <a href="/two">2`;
    const links = extractLinks(html, 'https://x.com/');
    expect(links).toContain('https://x.com/one');
    expect(links).toContain('https://x.com/two');
  });
});

describe('discoverPages against the fixture site', () => {
  let sites: Sites;
  let client: SafeClient;

  beforeAll(async () => {
    sites = await startSites();
    client = createSafeClient({
      allowLocal: true,
      resolver: offlineResolver,
      userAgent: 'QAHubBot/1.0-test',
    });
  });

  afterAll(async () => {
    await client.close();
    await sites.close();
  });

  function options(overrides: Partial<DiscoveryOptions> = {}): DiscoveryOptions {
    return {
      startUrl: `${sites.site.url}/`,
      maxPages: 100,
      client,
      limiter: new RateLimiter(200),
      concurrency: 4,
      signal: new AbortController().signal,
      log: silentLog,
      onProgress: () => undefined,
      isHostAllowed: () => true,
      ...overrides,
    };
  }

  it('combines sitemap pages (following the index) with crawled pages', async () => {
    const found: number[] = [];
    const result = await discoverPages(options({ onProgress: (n) => found.push(n) }));
    const urls = new Set(result.pages.map((page) => page.url));
    const at = (path: string) => `${sites.site.url}${path}`;

    // Only the sitemap reveals this one, and it sits in a nested sitemap behind an index.
    expect(urls).toContain(at('/sitemap-only'));
    // Only a link on /about reveals this one.
    expect(urls).toContain(at('/orphan'));
    expect(urls).toContain(at('/products/1'));
    expect(urls).toContain(at('/missing-page'));
    expect(urls).toContain(at('/old-page'));

    // Assets and downloads are not pages.
    expect(urls).not.toContain(at('/download.pdf'));
    expect(urls).not.toContain(at('/images/ok.svg'));
    // Other origins, mailto and tel links and in-page anchors are ignored.
    expect([...urls].every((url) => url.startsWith(sites.site.url))).toBe(true);

    expect(result.sitemapFound).toBe(true);
    expect(result.sitemapUrls).toEqual([`${sites.site.url}/sitemap-pages.xml`]);
    expect(result.robots).toMatchObject({ found: true, disallowAll: false });
    expect(result.truncated).toBe(false);
    expect(result.rootUrl).toBe(`${sites.site.url}/`);

    // Progress only ever counts up.
    expect(found.length).toBeGreaterThan(5);
    expect([...found].sort((a, b) => a - b)).toEqual(found);
  });

  it('records where each page came from', async () => {
    const result = await discoverPages(options());
    const byUrl = new Map(result.pages.map((page) => [page.url, page]));
    const at = (path: string) => byUrl.get(`${sites.site.url}${path}`);

    expect(at('/sitemap-only')).toMatchObject({ inSitemap: true, foundByCrawl: false });
    expect(at('/orphan')).toMatchObject({ inSitemap: false, foundByCrawl: true });
    expect(at('/about')).toMatchObject({ inSitemap: true, foundByCrawl: true });
  });

  it('normalises urls so each page is listed once', async () => {
    const result = await discoverPages(options());
    const urls = result.pages.map((page) => page.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.some((url) => url.includes('#'))).toBe(false);
    expect(
      urls.some((url) => url.length > 1 && url.endsWith('/') && new URL(url).pathname !== '/'),
    ).toBe(false);
  });

  it('never returns more than maxPages and says so', async () => {
    const result = await discoverPages(options({ maxPages: 5 }));
    expect(result.pages).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('fails clearly when the start page cannot be reached', async () => {
    const error = await discoverPages(options({ startUrl: 'http://127.0.0.1:1/' })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as DiscoveryError).message).toMatch(/Could not reach http:\/\/127\.0\.0\.1:1\//);
  });

  it('refuses a site whose redirect leaves the allowed domains', async () => {
    const error = await discoverPages(options({ isHostAllowed: () => false })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as DiscoveryError).message).toMatch(/not on the allowed domains list/);
  });

  it('stops when the scan is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await discoverPages(options({ signal: controller.signal })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(Error);
  });

  it('identifies itself and paces its requests', async () => {
    sites.site.reset();
    await discoverPages(options());
    expect(sites.site.requests.length).toBeGreaterThan(10);
    expect(sites.site.requests.every((request) => request.userAgent.includes('QAHubBot'))).toBe(
      true,
    );
  });
});
