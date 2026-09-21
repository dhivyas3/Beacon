import { describe, expect, it } from 'vitest';
import { DiscoveryError, type DiscoveryResult } from './discovery.js';
import { sampledDiscovery, selectSample, shuffle, staticPages } from './page-selection.js';

/** A small deterministic generator, so a "random" sample is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const HOME = 'https://www.example.com/';
const pages = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `https://www.example.com/page-${i + 1}`);
const NONE = new Map<string, number>();

describe('shuffle', () => {
  it('keeps every item, does not change the input, and depends on the generator', () => {
    const input = pages(20);
    const copy = [...input];
    const a = shuffle(input, seeded(1));
    expect(input).toEqual(copy);
    expect([...a].sort()).toEqual([...input].sort());
    expect(a).not.toEqual(input);
    expect(shuffle(input, seeded(1))).toEqual(a);
    expect(shuffle(input, seeded(2))).not.toEqual(a);
  });
});

describe('selectSample', () => {
  const sample = (overrides: Partial<Parameters<typeof selectSample>[0]> = {}) =>
    selectSample({
      pages: [HOME, ...pages(30)],
      homepage: HOME,
      pinned: [],
      size: 8,
      lastChecked: NONE,
      random: seeded(7),
      ...overrides,
    });

  it('picks exactly the size, with the homepage first, and no repeats', () => {
    const chosen = sample();
    expect(chosen).toHaveLength(8);
    expect(chosen[0]).toBe(HOME);
    expect(new Set(chosen).size).toBe(8);
  });

  it('always includes pinned pages, even ones discovery did not find', () => {
    const chosen = sample({
      pinned: ['https://www.example.com/contact', 'https://www.example.com/hidden'],
      pages: [HOME, 'https://www.example.com/contact', ...pages(30)],
    });
    expect(chosen.slice(0, 3)).toEqual([
      HOME,
      'https://www.example.com/contact',
      'https://www.example.com/hidden',
    ]);
    expect(chosen).toHaveLength(8);
  });

  it('checks every mandatory page even when they exceed the size', () => {
    const pinned = pages(12);
    const chosen = sample({ pinned, size: 5 });
    expect(chosen).toHaveLength(13);
    expect(chosen).toEqual([HOME, ...pinned]);
  });

  it('checks the whole site when it is smaller than the size', () => {
    const chosen = sample({ pages: [HOME, ...pages(3)], size: 10 });
    expect(chosen.sort()).toEqual([HOME, ...pages(3)].sort());
  });

  it('works without a homepage, and with a size of one', () => {
    expect(sample({ homepage: null, size: 3 })).toHaveLength(3);
    expect(sample({ size: 1 })).toEqual([HOME]);
  });

  it('is a fresh sample each time the generator differs', () => {
    const first = sample({ random: seeded(1) });
    const second = sample({ random: seeded(2) });
    expect(first).not.toEqual(second);
  });

  it('prefers pages that have never been checked over ones that have', () => {
    const all = pages(30);
    const lastChecked = new Map(all.slice(0, 25).map((url) => [url, 1000]));
    const chosen = sample({ lastChecked, size: 8 });
    // Only page-26..page-30 are new, so they are all in, plus the homepage and two repeats.
    for (const url of all.slice(25)) expect(chosen).toContain(url);
    expect(chosen).toHaveLength(8);
  });

  it('repeats the pages checked longest ago first once everything has been seen', () => {
    const all = pages(10);
    const lastChecked = new Map(all.map((url, index) => [url, (index + 1) * 1000]));
    const chosen = sample({ pages: [HOME, ...all], lastChecked, size: 4 });
    expect(chosen).toEqual([
      HOME,
      'https://www.example.com/page-1',
      'https://www.example.com/page-2',
      'https://www.example.com/page-3',
    ]);
  });

  it('covers the whole site over successive runs before repeating anything', () => {
    const all = pages(30);
    const lastChecked = new Map<string, number>();
    const everChecked = new Set<string>();
    const random = seeded(99);
    // The homepage and 4 others each run: 30 pages need ceil(30 / 4) = 8 runs.
    for (let run = 1; run <= 8; run += 1) {
      const chosen = selectSample({
        pages: [HOME, ...all],
        homepage: HOME,
        pinned: [],
        size: 5,
        lastChecked,
        random,
      });
      const fresh = chosen.filter((url) => url !== HOME && !everChecked.has(url));
      if (everChecked.size < 30 - 4) expect(fresh).toHaveLength(4);
      for (const url of chosen) {
        everChecked.add(url);
        lastChecked.set(url, run);
      }
    }
    expect(everChecked.size).toBe(31);
  });
});

describe('sampledDiscovery', () => {
  const discovery = (): DiscoveryResult => ({
    rootUrl: HOME,
    origin: 'https://www.example.com',
    pages: [HOME, ...pages(20)].map((url, index) => ({
      url,
      inSitemap: index % 2 === 0,
      foundByCrawl: true,
    })),
    sitemapFound: true,
    sitemapUrls: ['https://www.example.com/sitemap.xml'],
    robots: { found: true, disallowAll: false, sitemaps: [] },
    truncated: false,
  });

  it('narrows the pages and keeps the site-wide findings and each page flags', () => {
    const result = sampledDiscovery(discovery(), {
      size: 6,
      pinned: [],
      lastChecked: NONE,
      random: seeded(3),
    });
    expect(result.pages).toHaveLength(6);
    expect(result.pages[0]?.url).toBe(HOME);
    expect(result.sitemapFound).toBe(true);
    expect(result.sitemapUrls).toEqual(['https://www.example.com/sitemap.xml']);
    const original = new Map(discovery().pages.map((page) => [page.url, page]));
    for (const page of result.pages) expect(page).toEqual(original.get(page.url));
  });

  it('adds a pinned page that discovery did not find, and drops one on another site', () => {
    const result = sampledDiscovery(discovery(), {
      size: 4,
      pinned: [
        'https://www.example.com/secret?utm_source=x',
        'https://evil.test/page',
        'not a url',
      ],
      lastChecked: NONE,
      random: seeded(3),
    });
    const urls = result.pages.map((page) => page.url);
    expect(urls).toContain('https://www.example.com/secret');
    expect(urls.some((url) => url.includes('evil.test'))).toBe(false);
    expect(result.pages.find((page) => page.url.endsWith('/secret'))).toEqual({
      url: 'https://www.example.com/secret',
      inSitemap: false,
      foundByCrawl: false,
    });
  });
});

describe('staticPages', () => {
  const ALLOWED = ['*.example.com'];
  const build = (pagesList: string[], url = 'https://www.example.com/') =>
    staticPages({ url, pages: pagesList, allowedEntries: ALLOWED });

  it('uses exactly the listed pages, normalised and without repeats, and skips discovery', () => {
    const result = build([
      'https://www.example.com/',
      'https://www.example.com/contact/?utm_source=x',
      'https://www.example.com/contact',
    ]);
    expect(result.pages.map((page) => page.url)).toEqual([
      'https://www.example.com/',
      'https://www.example.com/contact',
    ]);
    expect(result).toMatchObject({
      rootUrl: 'https://www.example.com/',
      origin: 'https://www.example.com',
      sitemapFound: false,
      truncated: false,
      robots: { found: false },
    });
  });

  it('refuses pages on another origin, an empty list, and a host that is no longer allowed', () => {
    expect(() => build(['https://other.example.org/x'])).toThrow(DiscoveryError);
    expect(() => build(['http://www.example.com/insecure'])).toThrow(
      /not on https:\/\/www\.example\.com/,
    );
    expect(() => build([])).toThrow(/no pages to check/);
    expect(() =>
      staticPages({
        url: 'https://www.example.com/',
        pages: ['https://www.example.com/'],
        allowedEntries: [],
      }),
    ).toThrow(/not on the allowed domains/);
    expect(() => build(['https://www.example.com/'], 'not a url')).toThrow(DiscoveryError);
  });
});
