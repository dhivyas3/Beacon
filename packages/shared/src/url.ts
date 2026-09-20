import { TRACKING_PARAMS } from './constants.js';

const NON_PAGE_EXTENSIONS = new Set([
  '7z',
  'avi',
  'css',
  'csv',
  'doc',
  'docx',
  'eot',
  'gif',
  'gz',
  'ico',
  'jpeg',
  'jpg',
  'js',
  'json',
  'map',
  'mov',
  'mp3',
  'mp4',
  'ogg',
  'otf',
  'pdf',
  'png',
  'ppt',
  'pptx',
  'rar',
  'svg',
  'tar',
  'ttf',
  'wav',
  'webm',
  'webp',
  'woff',
  'woff2',
  'xls',
  'xlsx',
  'xml',
  'zip',
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAMS.some((entry) =>
    entry.endsWith('*') ? lower.startsWith(entry.slice(0, -1)) : lower === entry,
  );
}

/**
 * Normalises a URL so equivalent addresses compare equal.
 *
 * Lowercases scheme and host, removes default ports, fragments and tracking parameters, sorts the
 * remaining query parameters and strips the trailing slash from non-root paths. Returns null for
 * anything that is not a valid http or https URL.
 */
export function normalizeUrl(input: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '') return null;

  url.hash = '';
  url.username = '';
  url.password = '';

  const kept: [string, string][] = [];
  for (const [name, value] of url.searchParams.entries()) {
    if (!isTrackingParam(name)) kept.push([name, value]);
  }
  kept.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  url.search = '';
  for (const [name, value] of kept) url.searchParams.append(name, value);

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  }
  return url.toString();
}

export function hostnameOf(input: string): string | null {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isSameHost(a: string, b: string): boolean {
  const hostA = hostnameOf(a);
  return hostA !== null && hostA === hostnameOf(b);
}

/** True when the URL path looks like a document rather than an asset or download. */
export function looksLikePageUrl(input: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(input).pathname;
  } catch {
    return false;
  }
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot === -1) return true;
  return !NON_PAGE_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

/**
 * Allowed-domain matching. `*.example.com` matches the apex and every subdomain. Any other entry
 * matches only that exact hostname.
 */
export function hostnameMatchesEntry(hostname: string, entry: string): boolean {
  const host = hostname.toLowerCase();
  const pattern = entry.trim().toLowerCase();
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern;
}

export function isHostAllowed(hostname: string, entries: readonly string[]): boolean {
  return entries.some((entry) => hostnameMatchesEntry(hostname, entry));
}

/**
 * Matches a hostname against a staging pattern.
 *
 * - `.netlify.app` (leading dot) matches any hostname ending in that suffix.
 * - `staging.` (trailing dot) matches when `staging.` starts the hostname or any label boundary.
 * - anything else (`localhost`) matches that hostname or any subdomain of it.
 */
export function matchesStagingPattern(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (pattern === '') return false;
    if (pattern.startsWith('.')) return host.endsWith(pattern) || host === pattern.slice(1);
    if (pattern.endsWith('.')) return host.startsWith(pattern) || host.includes(`.${pattern}`);
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}
