import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { blockedReason } from './ip.js';

export class UrlBlockedError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'UrlBlockedError';
  }
}

/** Resolves a hostname to every IP address it points at. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const systemResolver: HostResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

export interface GuardOptions {
  resolver?: HostResolver;
  /**
   * Test-only escape hatch that permits loopback and private addresses so the local fixture site
   * can be scanned. Scheme checks still apply.
   */
  allowLocal?: boolean;
}

const LOCAL_NAMES = /(^|\.)localhost$/i;

/**
 * Throws `UrlBlockedError` unless the URL is http(s) and every address its host resolves to is a
 * public address.
 *
 * Call this before every outbound request and again for each redirect target. For long-lived
 * connections use a pinned lookup as well (see `safeFetch`), so DNS cannot change between this
 * check and the connection.
 */
export async function assertPublicUrl(rawUrl: string, options: GuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlBlockedError('The URL is not valid.', 'invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlBlockedError('Only http and https URLs are allowed.', 'scheme not allowed');
  }
  if (url.username !== '' || url.password !== '') {
    throw new UrlBlockedError('URLs with embedded credentials are not allowed.', 'credentials');
  }

  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  if (hostname === '') throw new UrlBlockedError('The URL has no host.', 'no host');

  if (options.allowLocal) return url;

  if (LOCAL_NAMES.test(hostname)) {
    throw new UrlBlockedError('That host is not a public address.', 'localhost');
  }

  const addresses = isIP(hostname) !== 0 ? [hostname] : await resolveOrThrow(hostname, options);
  for (const address of addresses) {
    const reason = blockedReason(address);
    if (reason !== null) {
      throw new UrlBlockedError(
        `${hostname} resolves to a non-public address (${reason}).`,
        reason,
      );
    }
  }
  return url;
}

async function resolveOrThrow(hostname: string, options: GuardOptions): Promise<string[]> {
  const resolver = options.resolver ?? systemResolver;
  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new UrlBlockedError(`Could not resolve ${hostname}.`, 'dns failure');
  }
  if (addresses.length === 0) {
    throw new UrlBlockedError(`Could not resolve ${hostname}.`, 'dns failure');
  }
  return addresses;
}
