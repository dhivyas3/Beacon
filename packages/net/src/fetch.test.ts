import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSafeClient,
  FetchError,
  followRedirects,
  type HopFn,
  type SafeClient,
} from './index.js';
import { assertPublicUrl, type HostResolver } from './ssrf.js';

let server: Server;
let base: string;
let client: SafeClient;
let seenUserAgent = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seenUserAgent = String(req.headers['user-agent']);
    switch (url.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(req.method === 'HEAD' ? undefined : 'hello');
        return;
      case '/redirect':
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      case '/chain/1':
        res.writeHead(301, { location: '/chain/2' });
        res.end();
        return;
      case '/chain/2':
        res.writeHead(302, { location: '/chain/3' });
        res.end();
        return;
      case '/chain/3':
        res.writeHead(307, { location: '/ok' });
        res.end();
        return;
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      case '/gzip':
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
        res.end(gzipSync('compressed text'));
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(50_000));
        return;
      case '/slow':
        setTimeout(() => {
          res.writeHead(200);
          res.end('late');
        }, 2000);
        return;
      default:
        res.writeHead(404);
        res.end('nope');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = createSafeClient({ allowLocal: true, userAgent: 'QAHubBot/1.0-test' });
});

afterAll(async () => {
  await client.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('createSafeClient (local targets allowed)', () => {
  it('fetches a body and identifies itself with the QAHubBot user agent', async () => {
    const res = await client.fetch(`${base}/ok`);
    expect(res.status).toBe(200);
    expect(res.body?.toString()).toBe('hello');
    expect(res.chain).toEqual([]);
    expect(seenUserAgent).toBe('QAHubBot/1.0-test');
  });

  it('HEAD returns headers without a body', async () => {
    const res = await client.fetch(`${base}/ok`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers['content-type']).toBe('text/plain');
  });

  it('records every redirect hop and the final url', async () => {
    const res = await client.fetch(`${base}/chain/1`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.url).toBe(`${base}/ok`);
    expect(res.chain.map((hop) => hop.status)).toEqual([301, 302, 307]);
    expect(res.chain.map((hop) => new URL(hop.url).pathname)).toEqual([
      '/chain/1',
      '/chain/2',
      '/chain/3',
    ]);
    expect(res.redirectLimitReached).toBe(false);
  });

  it('can return the first response without following redirects', async () => {
    const res = await client.fetch(`${base}/redirect`, { maxRedirects: 0 });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/ok');
    expect(res.chain).toEqual([]);
  });

  it('stops at a redirect loop and reports it', async () => {
    const res = await client.fetch(`${base}/loop`, { method: 'HEAD' });
    expect(res.redirectLimitReached).toBe(true);
    expect(res.status).toBe(302);
  });

  it('honours the redirect limit', async () => {
    const res = await client.fetch(`${base}/chain/1`, { method: 'HEAD', maxRedirects: 2 });
    expect(res.redirectLimitReached).toBe(true);
    expect(res.chain).toHaveLength(2);
  });

  it('decompresses gzip bodies', async () => {
    const res = await client.fetch(`${base}/gzip`);
    expect(res.body?.toString()).toBe('compressed text');
  });

  it('truncates bodies larger than maxBytes', async () => {
    const res = await client.fetch(`${base}/big`, { maxBytes: 1000 });
    expect(res.truncated).toBe(true);
    expect(res.body?.length).toBe(1000);
  });

  it('times out slow responses with a typed error', async () => {
    const error = await client.fetch(`${base}/slow`, { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).code).toBe('timeout');
  });

  it('reports a cancelled request as aborted', async () => {
    const controller = new AbortController();
    const pending = client.fetch(`${base}/slow`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const error = await pending.catch((e: unknown) => e);
    expect((error as FetchError).code).toBe('aborted');
  });

  it('reports a refused connection', async () => {
    const error = await client.fetch('http://127.0.0.1:1/').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).code).toBe('connect');
  });

  it('returns 404 responses normally', async () => {
    const res = await client.fetch(`${base}/missing`);
    expect(res.status).toBe(404);
  });
});

describe('createSafeClient (SSRF guard on)', () => {
  it('refuses a local server outright', async () => {
    const guarded = createSafeClient({ userAgent: 'QAHubBot/1.0-test' });
    try {
      const error = await guarded.fetch(`${base}/ok`).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FetchError);
      expect((error as FetchError).code).toBe('blocked');
    } finally {
      await guarded.close();
    }
  });

  it('refuses the cloud metadata address without connecting', async () => {
    const guarded = createSafeClient({ userAgent: 'QAHubBot/1.0-test' });
    try {
      const error = await guarded
        .fetch('http://169.254.169.254/latest/meta-data/')
        .catch((e: unknown) => e);
      expect((error as FetchError).code).toBe('blocked');
    } finally {
      await guarded.close();
    }
  });

  it('pins DNS: a host that turns private between the check and the connection is refused', async () => {
    let calls = 0;
    // The first lookup (the pre-flight check) sees a public address, every later one a private one.
    const rebinding: HostResolver = async () => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
    const guarded = createSafeClient({ userAgent: 'QAHubBot/1.0-test', resolver: rebinding });
    try {
      const error = await guarded
        .fetch(`http://rebind.example:${new URL(base).port}/ok`)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FetchError);
      expect((error as FetchError).code).toBe('blocked');
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      await guarded.close();
    }
  });
});

describe('followRedirects', () => {
  const resolver: HostResolver = async () => ['93.184.216.34'];
  const guard = (url: string) => assertPublicUrl(url, { resolver });
  const signal = new AbortController().signal;

  it('re-checks every hop: a redirect to a private address is refused before it is requested', async () => {
    const requested: string[] = [];
    const hop: HopFn = async (url) => {
      requested.push(url);
      return {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        body: null,
        truncated: false,
      };
    };
    const error = await followRedirects('https://public.example/start', hop, guard, {
      signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).code).toBe('blocked');
    expect(requested).toEqual(['https://public.example/start']);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    const hop: HopFn = async () => ({
      status: 301,
      headers: { location: 'file:///etc/passwd' },
      body: null,
      truncated: false,
    });
    const error = await followRedirects('https://public.example/', hop, guard, { signal }).catch(
      (e: unknown) => e,
    );
    expect((error as FetchError).code).toBe('blocked');
  });

  it('resolves relative locations against the current url', async () => {
    const redirect: Record<string, string> = { location: '../c' };
    const none: Record<string, string> = {};
    const hop: HopFn = async (url) =>
      url.endsWith('/a/b')
        ? { status: 301, headers: redirect, body: null, truncated: false }
        : { status: 200, headers: none, body: Buffer.from('done'), truncated: false };
    const res = await followRedirects('https://public.example/a/b', hop, guard, { signal });
    expect(res.url).toBe('https://public.example/c');
    expect(res.chain).toHaveLength(1);
  });
});
