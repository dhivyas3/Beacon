import { gunzipSync } from 'node:zlib';
import { FetchError, type SafeClient } from '@qa-hub/net';
import { looksLikePageUrl, normalizeUrl } from '@qa-hub/shared';
import type { Logger } from '../logger.js';
import { runPool } from '../util/async.js';
import type { RateLimiter } from '../util/rate-limit.js';

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

export interface DiscoveredPage {
  url: string;
  inSitemap: boolean;
  /** Reached by following a link on the site. */
  foundByCrawl: boolean;
}

export interface RobotsInfo {
  found: boolean;
  /** `Disallow: /` under `User-agent: *`. Everything is blocked for crawlers. */
  disallowAll: boolean;
  sitemaps: string[];
}

export interface DiscoveryResult {
  /** The start URL after redirects, normalised. */
  rootUrl: string;
  origin: string;
  pages: DiscoveredPage[];
  sitemapFound: boolean;
  sitemapUrls: string[];
  robots: RobotsInfo;
  /** More pages exist than `maxPages`. */
  truncated: boolean;
}

export interface DiscoveryOptions {
  startUrl: string;
  maxPages: number;
  client: SafeClient;
  limiter: RateLimiter;
  concurrency: number;
  signal: AbortSignal;
  log: Logger;
  /** Called with the number of pages found so far. */
  onProgress: (found: number) => void;
  /** The start URL may redirect. The final host must pass this check. */
  isHostAllowed: (hostname: string) => boolean;
}

const MAX_SITEMAP_FILES = 50;
const MAX_SITEMAP_DEPTH = 3;
const MAX_QUERY_PARAMS = 3;

/** Extracts `<loc>` values from a sitemap or sitemap index. Handles CDATA and XML entities. */
export function parseSitemap(xml: string): { kind: 'index' | 'urlset'; locations: string[] } {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset';
  const locations: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    locations.push(
      raw
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'"),
    );
  }
  return { kind, locations };
}

/** Reads the parts of robots.txt that matter: sitemap locations and a blanket `Disallow: /`. */
export function parseRobots(text: string): { disallowAll: boolean; sitemaps: string[] } {
  const sitemaps: string[] = [];
  let disallowAll = false;
  let appliesToAll = false;
  let inGroupHeader = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if (field === 'user-agent') {
      // Consecutive user-agent lines form one group.
      appliesToAll = inGroupHeader ? appliesToAll || value === '*' : value === '*';
      inGroupHeader = true;
    } else {
      inGroupHeader = false;
      if (field === 'disallow' && appliesToAll && value === '/') disallowAll = true;
    }
  }
  return { disallowAll, sitemaps };
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

/** The value of an href attribute inside one opening tag, or null. */
const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;

/**
 * Pulls link targets out of HTML, honouring `<base href>`. Deliberately a tolerant scan rather than
 * a strict parse: real pages have unclosed tags, nested anchors and stray angle brackets, and a
 * crawler must still find every link. Script, style and comment blocks are ignored.
 */
export function extractLinks(html: string, pageUrl: string): string[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');

  let base = pageUrl;
  const baseTag = /<base\b[^>]*>/i.exec(cleaned)?.[0];
  const baseHref = baseTag ? HREF.exec(baseTag) : null;
  const baseValue = baseHref?.[1] ?? baseHref?.[2] ?? baseHref?.[3];
  if (baseValue) {
    try {
      base = new URL(decodeEntities(baseValue), pageUrl).toString();
    } catch {
      // Ignore an invalid <base>.
    }
  }

  const links: string[] = [];
  for (const tag of cleaned.matchAll(/<a\b[^>]*>/gi)) {
    const match = HREF.exec(tag[0]);
    const raw = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!raw) continue;
    try {
      links.push(new URL(decodeEntities(raw.trim()), base).toString());
    } catch {
      // Not a valid URL, so nothing to crawl.
    }
  }
  return links;
}

function safeNormalize(url: string, base?: string): string | null {
  const normalized = normalizeUrl(url, base);
  if (normalized === null) return null;
  const parsed = new URL(normalized);
  if ([...parsed.searchParams.keys()].length > MAX_QUERY_PARAMS) return null;
  return normalized;
}

function textOf(body: Buffer | null, url: string): string {
  if (!body) return '';
  const isGzip = body.length > 2 && body[0] === 0x1f && body[1] === 0x8b;
  if (isGzip || url.endsWith('.gz')) {
    try {
      return gunzipSync(body).toString('utf8');
    } catch {
      return body.toString('utf8');
    }
  }
  return body.toString('utf8');
}

/**
 * Finds every page of a site: sitemap.xml (following sitemap indexes) supplemented by a
 * breadth-first, same-origin crawl from the homepage. The result is capped at `maxPages`.
 */
export async function discoverPages(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const { client, limiter, signal, log } = options;

  const get = async (url: string, maxBytes = 2 * 1024 * 1024) => {
    await limiter.take(signal);
    return client.fetch(url, { maxBytes, signal, timeoutMs: 20_000 });
  };

  // 1. The start page. Its final URL, after redirects, defines the site.
  let start;
  try {
    start = await get(options.startUrl);
  } catch (error) {
    const reason = error instanceof FetchError ? error.message : String(error);
    throw new DiscoveryError(`Could not reach ${options.startUrl}. ${reason}`);
  }
  const rootUrl = safeNormalize(start.url) ?? start.url;
  const rootParsed = new URL(rootUrl);
  if (!options.isHostAllowed(rootParsed.hostname)) {
    throw new DiscoveryError(
      `${options.startUrl} redirects to ${rootParsed.hostname}, which is not on the allowed domains list. Add it in Settings or scan that address directly.`,
    );
  }
  const origin = rootParsed.origin;
  const sameSite = (url: string): boolean => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  const found = new Map<string, DiscoveredPage>();
  let truncated = false;
  const add = (url: string, source: 'sitemap' | 'crawl'): boolean => {
    if (!sameSite(url) || !looksLikePageUrl(url)) return false;
    const existing = found.get(url);
    if (existing) {
      if (source === 'sitemap') existing.inSitemap = true;
      else existing.foundByCrawl = true;
      return false;
    }
    if (found.size >= options.maxPages) {
      truncated = true;
      return false;
    }
    found.set(url, { url, inSitemap: source === 'sitemap', foundByCrawl: source === 'crawl' });
    options.onProgress(found.size);
    return true;
  };
  add(rootUrl, 'crawl');

  // 2. robots.txt
  const robots: RobotsInfo = { found: false, disallowAll: false, sitemaps: [] };
  try {
    const response = await get(`${origin}/robots.txt`, 512 * 1024);
    if (response.status === 200 && response.body) {
      const parsed = parseRobots(response.body.toString('utf8'));
      Object.assign(robots, { found: true, ...parsed });
    }
  } catch (error) {
    if (signal.aborted) throw error;
    log.debug({ err: error }, 'robots.txt could not be read');
  }

  // 3. Sitemaps, breadth first through any indexes.
  const sitemapUrls: string[] = [];
  let sitemapFound = false;
  const queue: { url: string; depth: number }[] = [
    ...new Set([...robots.sitemaps, `${origin}/sitemap.xml`]),
  ].map((url) => ({ url, depth: 0 }));
  const seenSitemaps = new Set<string>();
  while (queue.length > 0 && seenSitemaps.size < MAX_SITEMAP_FILES && !signal.aborted) {
    const item = queue.shift() as { url: string; depth: number };
    if (seenSitemaps.has(item.url)) continue;
    seenSitemaps.add(item.url);
    try {
      const response = await get(item.url, 10 * 1024 * 1024);
      if (response.status !== 200 || !response.body) continue;
      const { kind, locations } = parseSitemap(textOf(response.body, item.url));
      if (kind === 'index') {
        if (item.depth < MAX_SITEMAP_DEPTH) {
          for (const location of locations) queue.push({ url: location, depth: item.depth + 1 });
        }
        continue;
      }
      sitemapUrls.push(item.url);
      for (const location of locations) {
        const normalized = safeNormalize(location);
        if (normalized) add(normalized, 'sitemap');
      }
      if (locations.length > 0) sitemapFound = true;
    } catch (error) {
      if (signal.aborted) throw error;
      log.debug({ err: error, url: item.url }, 'sitemap could not be read');
    }
  }

  // 4. Crawl from the homepage. Sitemap pages are crawled too, so links only they carry are found.
  const crawled = new Set<string>();
  const crawlQueue: string[] = [...found.keys()];
  const crawlPage = async (url: string): Promise<void> => {
    let response;
    try {
      response = await get(url);
    } catch (error) {
      if (signal.aborted) throw error;
      log.debug({ err: error, url }, 'crawl request failed');
      return;
    }
    const type = response.headers['content-type'] ?? '';
    if (response.status >= 400 || !type.includes('html') || !response.body) return;
    let links: string[];
    try {
      links = extractLinks(response.body.toString('utf8'), response.url);
    } catch {
      return;
    }
    for (const link of links) {
      const normalized = safeNormalize(link);
      // add() also marks an already known page as reachable by crawling.
      if (normalized && add(normalized, 'crawl')) crawlQueue.push(normalized);
    }
  };

  while (!signal.aborted) {
    const batch = crawlQueue.splice(0, 50).filter((url) => !crawled.has(url));
    if (batch.length === 0) break;
    for (const url of batch) crawled.add(url);
    await runPool(batch, options.concurrency, crawlPage, {
      signal,
      onError: (error) => log.debug({ err: error }, 'crawl worker failed'),
    });
  }
  if (signal.aborted) throw new DiscoveryError('The scan was stopped during discovery.');

  return {
    rootUrl,
    origin,
    pages: [...found.values()],
    sitemapFound,
    sitemapUrls,
    robots,
    truncated,
  };
}
