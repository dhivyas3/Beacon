import { FetchError, type FetchHop, type SafeClient } from '@beacon/net';
import { sleep } from '../util/async.js';
import type { HostThrottle } from '../util/rate-limit.js';
import { type RateLimiter } from '../util/rate-limit.js';

export interface UrlCheckResult {
  url: string;
  /** Final HTTP status, or null when no response was received. */
  status: number | null;
  finalUrl: string | null;
  hops: number;
  chain: FetchHop[];
  redirectLimitReached: boolean;
  error: { code: string; message: string } | null;
  /** Method that produced the final status. */
  method: 'HEAD' | 'GET';
  durationMs: number;
}

export interface BackoffOptions {
  /** Retries after a 429 or 503. Default 3. */
  maxRetries: number;
  /** First wait when the server sends no Retry-After. Doubles each retry. */
  baseMs: number;
  /** Upper bound for any single wait. */
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { maxRetries: 3, baseMs: 1000, maxMs: 15_000 };

export interface UrlCheckerOptions {
  client: SafeClient;
  limiter: RateLimiter;
  hostThrottle: HostThrottle;
  signal: AbortSignal;
  backoff?: BackoffOptions;
  timeoutMs?: number;
}

/** HEAD is refused by many servers even when GET works, so these statuses trigger a GET. */
const HEAD_REJECTED = new Set([403, 405, 501]);
const BACKOFF_STATUSES = new Set([429, 503]);

/** Parses `Retry-After`, either seconds or an HTTP date. Returns milliseconds or null. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Verifies that a URL answers, the way a link checker should:
 * HEAD first, GET when the server rejects HEAD, redirects followed and counted, and a polite
 * back-off when the target answers 429 or 503. Every request goes through the SSRF-safe client, the
 * per-scan rate limiter, and, for external hosts, a per-host delay.
 */
export class UrlChecker {
  private readonly backoff: BackoffOptions;

  constructor(private readonly options: UrlCheckerOptions) {
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
  }

  async check(url: string, opts: { external: boolean }): Promise<UrlCheckResult> {
    const started = Date.now();
    const { signal } = this.options;
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      // The client reports the invalid URL below.
    }

    let lastError: FetchError | null = null;
    for (let attempt = 0; ; attempt++) {
      await this.options.limiter.take(signal);
      if (opts.external) await this.options.hostThrottle.wait(host, signal);
      if (signal.aborted) return this.failed(url, started, 'aborted', 'The scan was stopped.');

      try {
        let method: 'HEAD' | 'GET' = 'HEAD';
        let response = await this.request(url, 'HEAD');
        if (HEAD_REJECTED.has(response.status)) {
          method = 'GET';
          response = await this.request(url, 'GET');
        }

        if (BACKOFF_STATUSES.has(response.status) && attempt < this.backoff.maxRetries) {
          this.options.limiter.penalize();
          const wait = Math.min(
            this.backoff.maxMs,
            parseRetryAfter(response.headers['retry-after']) ?? this.backoff.baseMs * 2 ** attempt,
          );
          await sleep(wait, signal);
          continue;
        }

        return {
          url,
          status: response.status,
          finalUrl: response.url,
          hops: response.chain.length,
          chain: response.chain,
          redirectLimitReached: response.redirectLimitReached,
          error: null,
          method,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        lastError = error instanceof FetchError ? error : new FetchError(String(error), 'other');
        const transient = lastError.code === 'timeout' || lastError.code === 'connect';
        if (transient && attempt < 1 && !signal.aborted) continue; // one retry for network blips
        return this.failed(url, started, lastError.code, lastError.message);
      }
    }
  }

  private request(url: string, method: 'HEAD' | 'GET') {
    return this.options.client.fetch(url, {
      method,
      signal: this.options.signal,
      timeoutMs: this.options.timeoutMs ?? 15_000,
      // A GET only needs the status line, so read at most a little of the body.
      ...(method === 'GET' ? { maxBytes: 1 } : {}),
    });
  }

  private failed(url: string, started: number, code: string, message: string): UrlCheckResult {
    return {
      url,
      status: null,
      finalUrl: null,
      hops: 0,
      chain: [],
      redirectLimitReached: false,
      error: { code, message },
      method: 'HEAD',
      durationMs: Date.now() - started,
    };
  }
}

/** Scan-wide cache so a resource shared by many pages is only requested once. */
export class ResourceProbe {
  private readonly cache = new Map<string, Promise<UrlCheckResult>>();

  constructor(private readonly checker: UrlChecker) {}

  check(url: string, opts: { external: boolean }): Promise<UrlCheckResult> {
    let pending = this.cache.get(url);
    if (!pending) {
      pending = this.checker.check(url, opts);
      this.cache.set(url, pending);
    }
    return pending;
  }
}
