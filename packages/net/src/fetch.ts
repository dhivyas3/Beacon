import { lookup as systemLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { Agent, request, type Dispatcher } from 'undici';
import { isBlockedAddress } from './ip.js';
import {
  assertPublicUrl,
  systemResolver,
  UrlBlockedError,
  type GuardOptions,
  type HostResolver,
} from './ssrf.js';

export type FetchErrorCode =
  'timeout' | 'dns' | 'connect' | 'tls' | 'blocked' | 'aborted' | 'too_large' | 'other';

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly code: FetchErrorCode,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface FetchHop {
  url: string;
  status: number;
}

export interface SafeResponse {
  status: number;
  /** URL of the final response, after redirects. */
  url: string;
  headers: Record<string, string>;
  /** Every redirect followed, in order. `chain.length` is the number of hops. */
  chain: FetchHop[];
  /** True when the redirect limit was reached and the last response is still a redirect. */
  redirectLimitReached: boolean;
  /** Decoded response body. Null for HEAD requests and redirects. */
  body: Buffer | null;
  /** True when the body was cut at `maxBytes`. */
  truncated: boolean;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  /** Sent with a POST. A POST never follows redirects, so the body goes only where it was aimed. */
  body?: string | Buffer;
  timeoutMs?: number;
  /** Body is truncated beyond this size. Default 2 MB. */
  maxBytes?: number;
  /** Set to 0 to return the first response as is. Default 10. */
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeClientOptions extends GuardOptions {
  userAgent: string;
  defaultTimeoutMs?: number;
}

export interface SafeClient {
  fetch(url: string, options?: SafeFetchOptions): Promise<SafeResponse>;
  close(): Promise<void>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 10;

/** One request/response exchange without redirect handling. Injected so tests can fake it. */
export type HopFn = (
  url: string,
  options: Required<Pick<SafeFetchOptions, 'method' | 'headers' | 'maxBytes'>> & {
    signal: AbortSignal;
    body?: string | Buffer | undefined;
  },
) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
  truncated: boolean;
}>;

/**
 * Follows redirects by hand so the SSRF guard runs again for every hop. A redirect from a public
 * site to `http://169.254.169.254/` is refused before any request is made.
 */
export async function followRedirects(
  startUrl: string,
  hop: HopFn,
  guard: (url: string) => Promise<unknown>,
  options: SafeFetchOptions & { signal: AbortSignal },
): Promise<SafeResponse> {
  const method = options.method ?? 'GET';
  // Replaying a POST body at a redirect target would send data somewhere nobody chose.
  const maxRedirects = method === 'POST' ? 0 : (options.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
  const chain: FetchHop[] = [];
  const seen = new Set<string>();
  let url = startUrl;

  for (;;) {
    try {
      await guard(url);
    } catch (error) {
      if (error instanceof UrlBlockedError) throw new FetchError(error.message, 'blocked');
      throw error;
    }

    const response = await hop(url, {
      method,
      headers: options.headers ?? {},
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      signal: options.signal,
      body: options.body,
    });

    const location = response.headers.location;
    const redirects = REDIRECT_STATUSES.has(response.status) && location !== undefined;
    if (!redirects || maxRedirects === 0) {
      return { ...response, url, chain, redirectLimitReached: false };
    }

    chain.push({ url, status: response.status });
    seen.add(url);

    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      return { ...response, url, chain, redirectLimitReached: false };
    }
    if (chain.length >= maxRedirects || seen.has(next)) {
      return { ...response, url, chain, redirectLimitReached: true };
    }
    url = next;
  }
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
  try {
    switch (encoding?.toLowerCase()) {
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(body);
      case 'deflate':
        return inflateSync(body);
      case 'br':
        return brotliDecompressSync(body);
      default:
        return body;
    }
  } catch {
    return body;
  }
}

function classify(error: unknown, external: AbortSignal | undefined): FetchError {
  if (error instanceof FetchError) return error;
  if (error instanceof UrlBlockedError) return new FetchError(error.message, 'blocked');

  const err = error as { code?: string; name?: string; message?: string; cause?: unknown };
  const cause = err.cause as { code?: string; message?: string } | undefined;
  if (err.cause instanceof UrlBlockedError) {
    return new FetchError(err.cause.message, 'blocked');
  }
  const code = err.code ?? cause?.code ?? '';
  const message = err.message ?? 'Request failed';

  if (external?.aborted) return new FetchError('The request was cancelled.', 'aborted');
  if (
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ETIMEDOUT'
  ) {
    return new FetchError('The request timed out.', 'timeout');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') {
    return new FetchError('The domain name could not be resolved.', 'dns');
  }
  if (/CERT|SELF_SIGNED|ERR_TLS|SSL|UNABLE_TO_VERIFY/i.test(code) || /certificate/i.test(message)) {
    return new FetchError(`The TLS certificate is not valid (${code || message}).`, 'tls');
  }
  if (/^(ECONN|EHOST|ENET|EPIPE|UND_ERR_SOCKET)/.test(code)) {
    return new FetchError(`The connection failed (${code}).`, 'connect');
  }
  return new FetchError(message, 'other');
}

function pinnedLookup(options: SafeClientOptions) {
  const resolver: HostResolver = options.resolver ?? systemResolver;
  return (
    hostname: string,
    lookupOptions: { all?: boolean; family?: number },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    if (options.allowLocal && options.resolver === undefined) {
      systemLookup(hostname, lookupOptions as never, callback as never);
      return;
    }
    resolver(hostname)
      .then((addresses) => {
        if (!options.allowLocal) {
          const blocked = addresses.find((address) => isBlockedAddress(address));
          if (blocked !== undefined || addresses.length === 0) {
            throw new UrlBlockedError(
              `${hostname} resolves to a non-public address.`,
              'blocked at connect',
            );
          }
        }
        const entries: LookupAddress[] = addresses.map((address) => ({
          address,
          family: isIP(address) === 6 ? 6 : 4,
        }));
        if (lookupOptions.all) callback(null, entries);
        else callback(null, entries[0]?.address ?? '', entries[0]?.family);
      })
      .catch((error: unknown) => callback(error as NodeJS.ErrnoException, ''));
  };
}

/**
 * HTTP client for everything that touches a user-supplied URL.
 *
 * - Refuses non-http(s) schemes and any host that resolves to a private, loopback, link-local or
 *   metadata address, before the request and again for every redirect hop.
 * - Resolves DNS once per connection and connects to exactly the addresses it validated, so a
 *   hostname cannot switch to a private address between the check and the connection.
 * - Bounds time and size, decompresses bodies, and never follows more than `maxRedirects` hops.
 */
export function createSafeClient(options: SafeClientOptions): SafeClient {
  const agent = new Agent({
    connect: { lookup: pinnedLookup(options) as never, timeout: 10_000 },
    keepAliveTimeout: 10_000,
    connections: 32,
  });

  const hop: HopFn = async (url, hopOptions) => {
    const dispatcher: Dispatcher = agent;
    const response = await request(url, {
      method: hopOptions.method,
      dispatcher,
      signal: hopOptions.signal,
      ...(hopOptions.body === undefined ? {} : { body: hopOptions.body }),
      headers: {
        'user-agent': options.userAgent,
        accept: '*/*',
        'accept-encoding': 'identity',
        ...hopOptions.headers,
      },
    });

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue;
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    if (hopOptions.method === 'HEAD' || REDIRECT_STATUSES.has(response.statusCode)) {
      await response.body.dump();
      return { status: response.statusCode, headers, body: null, truncated: false };
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    for await (const chunk of response.body) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      chunks.push(buffer);
      if (size > hopOptions.maxBytes) {
        truncated = true;
        break;
      }
    }
    if (truncated) await response.body.dump();
    const raw = Buffer.concat(chunks);
    const body = decode(
      truncated ? raw.subarray(0, hopOptions.maxBytes) : raw,
      headers['content-encoding'],
    );
    return { status: response.statusCode, headers, body, truncated };
  };

  return {
    async fetch(url, fetchOptions = {}) {
      const timeoutMs = fetchOptions.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (fetchOptions.signal) signals.push(fetchOptions.signal);
      const signal = AbortSignal.any(signals);
      try {
        return await followRedirects(url, hop, (target) => assertPublicUrl(target, options), {
          ...fetchOptions,
          signal,
        });
      } catch (error) {
        throw classify(error, fetchOptions.signal);
      }
    },
    close: () => agent.close(),
  };
}
