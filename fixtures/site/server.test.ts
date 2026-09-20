import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startExternalSite, startFixtureSite, type FixtureSite } from './server.js';

let site: FixtureSite;
let external: FixtureSite;

beforeAll(async () => {
  external = await startExternalSite();
  site = await startFixtureSite({ externalUrl: external.url });
});

afterAll(async () => {
  await site.close();
  await external.close();
});

const get = (path: string, init?: RequestInit) =>
  fetch(`${site.url}${path}`, { redirect: 'manual', ...init });

describe('fixture site', () => {
  it('serves pages with the origin and external url filled in', async () => {
    const html = await (await get('/')).text();
    expect(html).toContain(`href="${site.url}/"`);
    expect(html).toContain(`${external.url}/gone`);
    expect(html).toContain('id="lazy-broken"');
    expect(html).not.toContain('{{');
  });

  it('has a sitemap index that points at a nested sitemap', async () => {
    const index = await (await get('/sitemap.xml')).text();
    expect(index).toContain('<sitemapindex');
    const nested = await (await get('/sitemap-pages.xml')).text();
    expect(nested).toContain(`${site.url}/sitemap-only`);
    expect(nested).not.toContain('/orphan');
  });

  it('breaks the things it says it breaks', async () => {
    expect((await get('/missing-page')).status).toBe(404);
    expect((await get('/images/hero-missing.jpg')).status).toBe(404);
    expect((await get('/api/broken')).status).toBe(500);
    expect((await get('/old-page')).status).toBe(301);
    expect((await get('/no-head', { method: 'HEAD' })).status).toBe(405);
    expect((await get('/no-head')).status).toBe(200);
    expect((await get('/forbidden-head', { method: 'HEAD' })).status).toBe(403);
  });

  it('has a redirect chain of four hops', async () => {
    let path = '/redirect-chain/1';
    let hops = 0;
    for (;;) {
      const res = await get(path);
      if (res.status < 300 || res.status > 399) break;
      hops += 1;
      path = res.headers.get('location') ?? '';
    }
    expect(hops).toBe(4);
    expect(path).toBe('/about');
  });

  it('records form submissions and answers the three endpoints differently', async () => {
    site.reset();
    const post = (path: string) => get(path, { method: 'POST', body: 'email=a%40b.c' });
    expect((await post('/api/forms/good')).status).toBe(200);
    expect((await post('/api/forms/broken')).status).toBe(200);
    expect((await post('/api/forms/500')).status).toBe(500);
    expect(site.submissions.map((s) => s.path)).toEqual([
      '/api/forms/good',
      '/api/forms/broken',
      '/api/forms/500',
    ]);
  });

  it('external site rate limits then recovers, and blocks bots', async () => {
    const hit = (path: string) => fetch(`${external.url}${path}`);
    expect((await hit('/busy')).status).toBe(429);
    expect((await hit('/busy')).status).toBe(429);
    expect((await hit('/busy')).status).toBe(200);
    expect((await hit('/blocked')).status).toBe(403);
    expect((await hit('/gone')).status).toBe(404);
  });
});
