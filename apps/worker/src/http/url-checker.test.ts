import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChecker, startSites, type Sites } from '../test/harness.js';
import { parseRetryAfter } from './url-checker.js';

let sites: Sites;

beforeAll(async () => {
  sites = await startSites();
});

afterAll(async () => {
  await sites.close();
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('0')).toBe(0);
    const now = Date.parse('2026-09-18T10:00:00Z');
    expect(parseRetryAfter('Fri, 18 Sep 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Fri, 18 Sep 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});

describe('UrlChecker', () => {
  it('returns the status of a healthy and a broken url', async () => {
    const { checker, client } = createChecker();
    try {
      const ok = await checker.check(`${sites.site.url}/about`, { external: false });
      expect(ok).toMatchObject({ status: 200, hops: 0, error: null, method: 'HEAD' });

      const missing = await checker.check(`${sites.site.url}/missing-page`, { external: false });
      expect(missing.status).toBe(404);
    } finally {
      await client.close();
    }
  });

  it('falls back to GET when the server rejects HEAD with 405 or 403', async () => {
    const { checker, client } = createChecker();
    try {
      sites.site.reset();
      const no405 = await checker.check(`${sites.site.url}/no-head`, { external: false });
      expect(no405).toMatchObject({ status: 200, method: 'GET' });
      const no403 = await checker.check(`${sites.site.url}/forbidden-head`, { external: false });
      expect(no403).toMatchObject({ status: 200, method: 'GET' });

      const methods = sites.site.requests
        .filter((request) => request.path === '/no-head')
        .map((request) => request.method);
      expect(methods).toEqual(['HEAD', 'GET']);
    } finally {
      await client.close();
    }
  });

  it('counts redirect hops and reports the final url', async () => {
    const { checker, client } = createChecker();
    try {
      const chain = await checker.check(`${sites.site.url}/redirect-chain/1`, { external: false });
      expect(chain).toMatchObject({ status: 200, hops: 4, redirectLimitReached: false });
      expect(chain.finalUrl).toBe(`${sites.site.url}/about`);

      const single = await checker.check(`${sites.site.url}/old-page`, { external: false });
      expect(single).toMatchObject({ status: 200, hops: 1 });
    } finally {
      await client.close();
    }
  });

  it('backs off on 429 and succeeds once the site recovers', async () => {
    const { checker, client } = createChecker();
    try {
      sites.site.reset();
      const result = await checker.check(`${sites.site.url}/busy-internal`, { external: false });
      expect(result.status).toBe(200);
      const hits = sites.site.requests.filter((request) => request.path === '/busy-internal');
      expect(hits).toHaveLength(3); // two 429 responses, then the good one
    } finally {
      await client.close();
    }
  });

  it('gives up after the retry limit and reports the 429', async () => {
    const { checker, client } = createChecker({ maxRetries: 0 });
    try {
      sites.external.reset();
      // The external /busy path answers 429 twice, and no retries are allowed.
      const result = await checker.check(`${sites.external.url}/busy`, { external: true });
      expect(result.status).toBe(429);
      expect(sites.external.requests.filter((request) => request.path === '/busy')).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('reports unreachable hosts and refused connections as errors, not statuses', async () => {
    const { checker, client } = createChecker();
    try {
      const unknown = await checker.check('https://staging.acme-fixture.test/pricing', {
        external: true,
      });
      expect(unknown.status).toBeNull();
      expect(unknown.error).toMatchObject({ code: 'dns' });

      const refused = await checker.check('http://127.0.0.1:1/', { external: false });
      expect(refused.status).toBeNull();
      expect(refused.error?.code).toBe('connect');
    } finally {
      await client.close();
    }
  });

  it('identifies itself as BeaconBot', async () => {
    const { checker, client } = createChecker();
    try {
      sites.site.reset();
      await checker.check(`${sites.site.url}/about`, { external: false });
      expect(sites.site.requests[0]?.userAgent).toContain('BeaconBot/1.0');
    } finally {
      await client.close();
    }
  });

  it('stops promptly when the scan is cancelled', async () => {
    const controller = new AbortController();
    const { checker, client } = createChecker({ signal: controller.signal });
    try {
      controller.abort();
      const result = await checker.check(`${sites.site.url}/about`, { external: false });
      expect(result.error?.code).toBe('aborted');
    } finally {
      await client.close();
    }
  });

  it('shares one request between callers through the probe cache', async () => {
    const { probe, client } = createChecker();
    try {
      sites.site.reset();
      const url = `${sites.site.url}/images/ok.svg`;
      await Promise.all([1, 2, 3, 4].map(() => probe.check(url, { external: false })));
      expect(
        sites.site.requests.filter((request) => request.path === '/images/ok.svg'),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
