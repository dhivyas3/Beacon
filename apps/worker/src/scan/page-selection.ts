import type { Db } from '@beacon/db';
import { isHostAllowed, normalizeUrl } from '@beacon/shared';
import { DiscoveryError, type DiscoveredPage, type DiscoveryResult } from './discovery.js';

export interface SampleInput {
  /** Every page discovery found. */
  pages: readonly string[];
  /** The front page. Always checked. */
  homepage: string | null;
  /** Pages the owner wants checked every time, whether or not discovery found them. */
  pinned: readonly string[];
  /** How many pages to check in total, homepage and pinned pages included. */
  size: number;
  /** When each page was last checked for this website, as epoch milliseconds. */
  lastChecked: ReadonlyMap<string, number>;
  /** A number in [0, 1). Injected so tests are deterministic. */
  random: () => number;
}

/** Fisher-Yates, without touching the input. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

/**
 * Chooses the pages of one check. The homepage and pinned pages are always in. The remaining places
 * go to pages this website has never been checked on, picked at random. Only when those run out
 * does it repeat pages, oldest check first, so every run is a fresh sample and coverage grows from
 * one check to the next until the whole site has been seen.
 *
 * The size is a floor for the mandatory pages: a homepage and twelve pinned pages are all checked
 * even if the size is 5.
 */
export function selectSample(input: SampleInput): string[] {
  const chosen: string[] = [];
  const taken = new Set<string>();
  const take = (url: string): void => {
    if (!taken.has(url)) {
      taken.add(url);
      chosen.push(url);
    }
  };

  if (input.homepage !== null) take(input.homepage);
  for (const url of input.pinned) take(url);

  const remaining = Math.max(0, input.size - chosen.length);
  const pool = input.pages.filter((url) => !taken.has(url));
  const unseen = shuffle(
    pool.filter((url) => !input.lastChecked.has(url)),
    input.random,
  );
  // Shuffle before the stable sort, so pages checked at the same moment come out in random order.
  const seen = shuffle(
    pool.filter((url) => input.lastChecked.has(url)),
    input.random,
  ).sort((a, b) => (input.lastChecked.get(a) ?? 0) - (input.lastChecked.get(b) ?? 0));

  for (const url of [...unseen, ...seen].slice(0, remaining)) take(url);
  return chosen;
}

/** When each page of a website was last checked, from its earlier scans. */
export async function loadLastChecked(
  db: Db,
  websiteId: string,
  beforeScanId: string,
): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<{ url: string; checked: Date }[]>`
    SELECT p."url", MAX(s."createdAt") AS checked
    FROM "ScanPage" p
    JOIN "Scan" s ON s."id" = p."scanId"
    WHERE s."websiteId" = ${websiteId} AND s."id" <> ${beforeScanId} AND p."status" = 'done'
    GROUP BY p."url"`;
  return new Map(rows.map((row) => [row.url, row.checked.getTime()]));
}

function normaliseAll(urls: readonly string[]): string[] {
  return [...new Set(urls.map((url) => normalizeUrl(url)).filter((url) => url !== null))];
}

/**
 * The page list for a `static_list` scan: exactly what the owner listed, with no discovery. Every
 * page must be on the site's own origin, and that host must still be allowed.
 */
export function staticPages(input: {
  url: string;
  pages: readonly string[];
  allowedEntries: readonly string[];
}): DiscoveryResult {
  const rootUrl = normalizeUrl(input.url);
  if (rootUrl === null) throw new DiscoveryError(`${input.url} is not a valid address.`);
  const origin = new URL(rootUrl).origin;
  if (!isHostAllowed(new URL(rootUrl).hostname, input.allowedEntries)) {
    throw new DiscoveryError(
      `${new URL(rootUrl).hostname} is not on the allowed domains list. Add it in Settings.`,
    );
  }

  const pages = normaliseAll(input.pages);
  const foreign = pages.filter((page) => new URL(page).origin !== origin);
  if (foreign.length > 0) {
    throw new DiscoveryError(
      `These pages are not on ${origin}: ${foreign.slice(0, 3).join(', ')}. Edit the list of pages.`,
    );
  }
  if (pages.length === 0) {
    throw new DiscoveryError('There are no pages to check. Add pages to the list.');
  }

  return {
    rootUrl,
    origin,
    pages: pages.map((url) => ({ url, inSitemap: false, foundByCrawl: false })),
    sitemapFound: false,
    sitemapUrls: [],
    robots: { found: false, disallowAll: false, sitemaps: [] },
    truncated: false,
  };
}

/** Narrows a full discovery to a sample of its pages, keeping the site-wide findings. */
export function sampledDiscovery(
  discovery: DiscoveryResult,
  options: {
    size: number;
    pinned: readonly string[];
    lastChecked: ReadonlyMap<string, number>;
    random: () => number;
  },
): DiscoveryResult {
  const byUrl = new Map(discovery.pages.map((page) => [page.url, page]));
  const pinned = normaliseAll(options.pinned).filter((url) => {
    try {
      return new URL(url).origin === discovery.origin;
    } catch {
      return false;
    }
  });
  const chosen = selectSample({
    pages: discovery.pages.map((page) => page.url),
    homepage: discovery.rootUrl,
    pinned,
    size: options.size,
    lastChecked: options.lastChecked,
    random: options.random,
  });
  const pages: DiscoveredPage[] = chosen.map(
    (url) => byUrl.get(url) ?? { url, inSitemap: false, foundByCrawl: false },
  );
  return { ...discovery, pages };
}
