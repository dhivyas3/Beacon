import { computeNextCheckAt, type Website } from '@beacon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestApp,
  errorOf,
  insertPage,
  insertScan,
  type TestApp,
} from '../test/helpers.js';

let ctx: TestApp;
let admin: string;
let writer: string;
let reader: string;
let submitter: string;
let counter = 0;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await ctx.adminCookie();
  await ctx.allowDomain('*.example.com');
  writer = (await ctx.createApiKey(['scans:read', 'scans:write'], 'n8n writer')).key;
  reader = (await ctx.createApiKey(['scans:read'], 'reader')).key;
  submitter = (await ctx.createApiKey(['scans:read', 'scans:write', 'forms:submit'], 'submitter'))
    .key;
});

afterAll(async () => {
  await ctx.close();
});

const fresh = () => {
  counter += 1;
  return { host: `web${counter}.example.com`, url: `https://web${counter}.example.com` };
};

function post(path: string, payload: Record<string, unknown>, key = writer) {
  return ctx.app.inject({ method: 'POST', url: `/api/v1${path}`, headers: bearer(key), payload });
}
function patch(path: string, payload: Record<string, unknown>, key = writer) {
  return ctx.app.inject({ method: 'PATCH', url: `/api/v1${path}`, headers: bearer(key), payload });
}
function get(path: string, key = reader) {
  return ctx.app.inject({ method: 'GET', url: `/api/v1${path}`, headers: bearer(key) });
}
function del(path: string, key = writer) {
  return ctx.app.inject({ method: 'DELETE', url: `/api/v1${path}`, headers: bearer(key) });
}

async function createWebsite(overrides: Record<string, unknown> = {}, key = writer) {
  const site = fresh();
  const res = await post(
    '/websites',
    { name: `Site ${counter}`, url: site.url, ...overrides },
    key,
  );
  return { res, site, website: res.statusCode === 201 ? res.json<Website>() : null };
}

describe('POST /websites', () => {
  it('registers a website with sensible defaults and plans the first check', async () => {
    const before = Date.now();
    const { res, site } = await createWebsite();
    expect(res.statusCode).toBe(201);
    const website = res.json<Website>();
    expect(website).toMatchObject({
      hostname: site.host,
      url: `${site.url}/`,
      checkFrequency: 'weekly',
      scheduleDayOfWeek: 1,
      scheduleDayOfMonth: null,
      scheduleHourUtc: 6,
      pageSelectionMode: 'random_sample',
      sampleSize: 10,
      formMode: 'validate_only',
      isActive: true,
      latest: null,
      pagesEverChecked: 0,
      activeScanId: null,
      recipients: [],
    });
    expect(website.id).toMatch(/^web_[0-9A-Za-z]{12}$/);
    expect(website.enabledChecks).toHaveLength(6);
    expect(website.owner).not.toBeNull();

    const next = new Date(website.nextCheckAt as string);
    expect(next.getTime()).toBeGreaterThan(before);
    expect(next.getUTCDay()).toBe(1);
    expect(next.getUTCHours()).toBe(6);
  });

  it('accepts a monthly schedule, a sample with a pinned page, and recipients', async () => {
    const site = fresh();
    const { website } = await createWebsite({
      url: site.url,
      name: 'Estates',
      checkFrequency: 'monthly',
      scheduleDayOfMonth: 31,
      scheduleHourUtc: 9,
      sampleSize: 8,
      pinnedPageUrls: [`${site.url}/contact/?utm_source=x`],
      enabledChecks: ['images', 'seo'],
      recipients: [
        { email: 'Owner@Example.com', name: 'Sam' },
        { email: 'owner@example.com' },
        { email: 'second@example.com' },
      ],
    });
    // The second "owner" is a duplicate once case is ignored.
    expect(website?.recipients.map((r) => r.email)).toEqual([
      'owner@example.com',
      'second@example.com',
    ]);
    expect(website).toMatchObject({
      checkFrequency: 'monthly',
      scheduleDayOfWeek: null,
      scheduleDayOfMonth: 31,
      scheduleHourUtc: 9,
      sampleSize: 8,
      enabledChecks: ['images', 'seo'],
    });
    // Tracking parameters are removed so the pinned page matches what discovery finds.
    expect(website?.pinnedPageUrls).toEqual([`${site.url}/contact`]);
    expect(website?.nextCheckAt).toBe(
      computeNextCheckAt(
        {
          checkFrequency: 'monthly',
          scheduleDayOfWeek: null,
          scheduleDayOfMonth: 31,
          scheduleHourUtc: 9,
        },
        new Date(website?.createdAt as string),
      )?.toISOString(),
    );
  });

  it('plans nothing for a manual or paused website', async () => {
    const manual = await createWebsite({ checkFrequency: 'manual' });
    expect(manual.website?.nextCheckAt).toBeNull();
    const paused = await createWebsite({ isActive: false });
    expect(paused.website).toMatchObject({ isActive: false, nextCheckAt: null });
  });

  it('refuses inconsistent configuration with every problem in the message', async () => {
    const site = fresh();
    const res = await post('/websites', {
      name: 'Bad',
      url: site.url,
      pageSelectionMode: 'static_list',
      staticPageUrls: ['https://other.example.org/x'],
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('validation_error');
    expect(JSON.stringify(res.json())).toContain('Every page must be on');
  });

  it('refuses a hostname that is not allowed', async () => {
    const res = await post('/websites', { name: 'Nope', url: 'https://www.not-allowed.test' });
    expect(res.statusCode).toBe(422);
    expect(errorOf(res).code).toBe('domain_not_allowed');
  });

  it('allows one website per hostname', async () => {
    const { website, site } = await createWebsite({ name: 'First' });
    const res = await post('/websites', { name: 'Second', url: `${site.url}/other` });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).message).toContain('already registered as First');
    expect((errorOf(res).details as { websiteId: string }).websiteId).toBe(website?.id);
  });

  it('needs forms:submit to save a website that submits forms', async () => {
    const denied = await createWebsite({ formMode: 'submit' });
    expect(denied.res.statusCode).toBe(403);
    expect(errorOf(denied.res).details).toEqual({ requiredScope: 'forms:submit' });
    const allowed = await createWebsite({ formMode: 'submit' }, submitter);
    expect(allowed.res.statusCode).toBe(201);
  });

  it('needs the write scope and a login', async () => {
    const { res } = await createWebsite({}, reader);
    expect(res.statusCode).toBe(403);
    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/websites',
      payload: { name: 'x', url: 'https://x.example.com' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('is owned by the signed-in user when created from the dashboard', async () => {
    const site = fresh();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/websites',
      headers: { cookie: admin },
      payload: { name: 'Mine', url: site.url },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Website>().owner?.name).toBe('Admin');
  });
});

describe('GET /websites', () => {
  it('lists alphabetically with a cursor, and filters by text and state', async () => {
    const names = ['Zebra Shop', 'Alpha Shop', 'Mango Shop'];
    for (const name of names) await createWebsite({ name });
    await createWebsite({ name: 'Paused Shop', isActive: false });

    const first = await get('/websites?q=shop&limit=2');
    const page1 = first.json<{ items: Website[]; nextCursor: string | null }>();
    expect(page1.items.map((w) => w.name)).toEqual(['Alpha Shop', 'Mango Shop']);
    expect(page1.nextCursor).not.toBeNull();

    const second = await get(`/websites?q=shop&limit=2&cursor=${page1.nextCursor as string}`);
    const page2 = second.json<{ items: Website[]; nextCursor: string | null }>();
    expect(page2.items.map((w) => w.name)).toEqual(['Paused Shop', 'Zebra Shop']);
    expect(page2.nextCursor).toBeNull();

    const active = await get('/websites?q=shop&isActive=true');
    expect(active.json<{ items: Website[] }>().items.map((w) => w.name)).not.toContain(
      'Paused Shop',
    );
  });

  it('shows the latest check with its score change, pages checked so far, and a running check', async () => {
    const { website, site } = await createWebsite();
    const id = (website as Website).id;

    const older = await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 1,
      websiteId: id,
      healthScore: 70,
      createdAt: new Date('2026-08-01T06:00:00Z'),
      finishedAt: new Date('2026-08-01T06:05:00Z'),
      triggeredByType: 'scheduled',
    });
    const newer = await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 2,
      websiteId: id,
      healthScore: 82,
      criticalCount: 1,
      warningCount: 4,
      pagesTotal: 8,
      previousScanId: older,
      createdAt: new Date('2026-09-01T06:00:00Z'),
      finishedAt: new Date('2026-09-01T06:05:00Z'),
      triggeredByType: 'manual_ui',
    });
    // Pages seen across both checks: /a and /b twice, /c once.
    for (const [scan, paths] of [
      [older, ['/a', '/b']],
      [newer, ['/a', '/b', '/c']],
    ] as const) {
      for (const path of paths) await insertPage(ctx.db, scan, `${site.url}${path}`);
    }

    let detail = (await get(`/websites/${id}`)).json<Website>();
    expect(detail.latest).toMatchObject({
      scanId: newer,
      runNumber: 2,
      status: 'completed',
      healthScore: 82,
      critical: 1,
      warnings: 4,
      pages: 8,
      scoreChange: 12,
      triggeredByType: 'manual_ui',
    });
    expect(detail.pagesEverChecked).toBe(3);
    expect(detail.activeScanId).toBeNull();

    const running = await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 3,
      websiteId: id,
      status: 'running',
    });
    detail = (await get(`/websites/${id}`)).json<Website>();
    expect(detail.activeScanId).toBe(running);
    expect(detail.latest?.scanId).toBe(newer);
  });

  it('answers 404 for an unknown website', async () => {
    const res = await get('/websites/web_doesnotexist');
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
  });
});

describe('PATCH /websites/:id', () => {
  it('renaming keeps the planned time, so editing never postpones a check', async () => {
    const { website } = await createWebsite();
    const res = await patch(`/websites/${(website as Website).id}`, { name: 'Renamed' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Website>()).toMatchObject({
      name: 'Renamed',
      nextCheckAt: (website as Website).nextCheckAt,
    });
  });

  it('plans again when the schedule changes', async () => {
    const { website } = await createWebsite();
    const res = await patch(`/websites/${(website as Website).id}`, {
      checkFrequency: 'daily',
      scheduleHourUtc: 3,
    });
    const updated = res.json<Website>();
    expect(updated.checkFrequency).toBe('daily');
    expect(updated.scheduleDayOfWeek).toBeNull();
    expect(new Date(updated.nextCheckAt as string).getUTCHours()).toBe(3);
  });

  it('pausing clears the next check and resuming plans it from now', async () => {
    const { website } = await createWebsite();
    const id = (website as Website).id;
    const paused = (await patch(`/websites/${id}`, { isActive: false })).json<Website>();
    expect(paused).toMatchObject({ isActive: false, nextCheckAt: null });

    await ctx.db.website.update({ where: { id }, data: { lastRunError: 'It could not start.' } });
    const resumed = (await patch(`/websites/${id}`, { isActive: true })).json<Website>();
    expect(resumed.isActive).toBe(true);
    expect(new Date(resumed.nextCheckAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(resumed.lastRunError).toBeNull();
  });

  it('checks the combination once merged with what is stored', async () => {
    const { website } = await createWebsite();
    const res = await patch(`/websites/${(website as Website).id}`, {
      pageSelectionMode: 'static_list',
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).message).toContain('Add at least one page');

    const weekly = await patch(`/websites/${(website as Website).id}`, {
      checkFrequency: 'monthly',
    });
    // The default day of month is 1 for a new website, but a patch cannot invent one.
    expect(weekly.statusCode).toBe(400);
    expect(errorOf(weekly).message).toContain('day of the month');
  });

  it('keeps the website on its hostname', async () => {
    const { website } = await createWebsite();
    const res = await patch(`/websites/${(website as Website).id}`, {
      url: 'https://another.example.com/',
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).message).toContain('must stay on');
  });

  it('needs forms:submit to switch to submitting forms', async () => {
    const { website } = await createWebsite();
    const denied = await patch(`/websites/${(website as Website).id}`, { formMode: 'submit' });
    expect(denied.statusCode).toBe(403);
    const ok = await patch(
      `/websites/${(website as Website).id}`,
      { formMode: 'submit' },
      submitter,
    );
    expect(ok.statusCode).toBe(200);
  });
});

describe('DELETE /websites/:id', () => {
  it('removes the website and its recipients but keeps its checks as one-off scans', async () => {
    const { website, site } = await createWebsite({ recipients: [{ email: 'a@example.com' }] });
    const id = (website as Website).id;
    const scan = await insertScan(ctx.db, { hostname: site.host, websiteId: id });

    const res = await del(`/websites/${id}`);
    expect(res.statusCode).toBe(204);
    expect((await get(`/websites/${id}`)).statusCode).toBe(404);
    expect(await ctx.db.websiteRecipient.count({ where: { websiteId: id } })).toBe(0);
    expect((await ctx.db.scan.findUniqueOrThrow({ where: { id: scan } })).websiteId).toBeNull();
    expect((await del(`/websites/${id}`)).statusCode).toBe(404);
  });
});

describe('recipients', () => {
  it('adds, refuses duplicates, and removes', async () => {
    const { website } = await createWebsite();
    const id = (website as Website).id;

    const added = await post(`/websites/${id}/recipients`, {
      email: 'New@Example.com',
      name: 'New',
    });
    expect(added.statusCode).toBe(201);
    const recipient = added.json<{ id: string; email: string; name: string; isActive: boolean }>();
    expect(recipient).toMatchObject({ email: 'new@example.com', name: 'New', isActive: true });
    expect(recipient.id).toMatch(/^rcp_/);

    const duplicate = await post(`/websites/${id}/recipients`, { email: 'new@example.com' });
    expect(duplicate.statusCode).toBe(409);

    const invalid = await post(`/websites/${id}/recipients`, { email: 'nope' });
    expect(invalid.statusCode).toBe(400);

    expect((await get(`/websites/${id}`)).json<Website>().recipients).toHaveLength(1);
    expect((await del(`/websites/${id}/recipients/${recipient.id}`)).statusCode).toBe(204);
    expect((await get(`/websites/${id}`)).json<Website>().recipients).toHaveLength(0);
    expect((await del(`/websites/${id}/recipients/${recipient.id}`)).statusCode).toBe(404);
  });

  it('cannot remove a recipient through another website', async () => {
    const a = await createWebsite({ recipients: [{ email: 'a@example.com' }] });
    const b = await createWebsite();
    const recipientId = (a.website as Website).recipients[0]?.id as string;
    const res = await del(`/websites/${(b.website as Website).id}/recipients/${recipientId}`);
    expect(res.statusCode).toBe(404);
    expect(
      (await get(`/websites/${(a.website as Website).id}`)).json<Website>().recipients,
    ).toHaveLength(1);
  });

  it('answers 404 for an unknown website', async () => {
    expect(
      (await post('/websites/web_none/recipients', { email: 'a@example.com' })).statusCode,
    ).toBe(404);
  });
});

describe('GET /websites/:id/history', () => {
  it('lists completed checks newest first, for charting', async () => {
    const { website, site } = await createWebsite();
    const id = (website as Website).id;
    const scores = [60, 70, 85];
    for (const [index, score] of scores.entries()) {
      await insertScan(ctx.db, {
        hostname: site.host,
        runNumber: index + 1,
        websiteId: id,
        healthScore: score,
        createdAt: new Date(Date.UTC(2026, 5 + index, 1)),
        finishedAt: new Date(Date.UTC(2026, 5 + index, 1, 0, 5)),
        triggeredByType: index === 1 ? 'n8n' : 'scheduled',
      });
    }
    await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 4,
      websiteId: id,
      status: 'failed',
    });
    await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 5,
      websiteId: id,
      status: 'running',
    });

    const res = await get(`/websites/${id}/history?limit=2`);
    const page = res.json<{
      items: { healthScore: number; triggeredByType: string; runNumber: number }[];
      nextCursor: string | null;
    }>();
    expect(page.items.map((item) => item.healthScore)).toEqual([85, 70]);
    expect(page.items[1]?.triggeredByType).toBe('n8n');
    const rest = await get(`/websites/${id}/history?limit=2&cursor=${page.nextCursor as string}`);
    expect(
      rest.json<{ items: { healthScore: number }[] }>().items.map((i) => i.healthScore),
    ).toEqual([60]);
    expect((await get('/websites/web_none/history')).statusCode).toBe(404);
  });
});

describe('POST /websites/:id/check-now', () => {
  it('starts a check with the website configuration, marked as a manual API check', async () => {
    const site = fresh();
    const { website } = await createWebsite({
      url: site.url,
      checkFrequency: 'monthly',
      scheduleDayOfMonth: 1,
      pageSelectionMode: 'static_list',
      staticPageUrls: [`${site.url}/`, `${site.url}/contact/`],
      enabledChecks: ['seo', 'forms'],
      formMode: 'detect',
    });
    const before = (
      await ctx.db.website.findUniqueOrThrow({ where: { id: (website as Website).id } })
    ).nextCheckAt;

    const res = await post(`/websites/${(website as Website).id}/check-now`, {});
    expect(res.statusCode).toBe(202);
    const { id, reportUrl } = res.json<{ id: string; reportUrl: string }>();
    expect(reportUrl).toBe(`http://qa.test/scans/${id}`);

    const row = await ctx.db.scan.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      websiteId: (website as Website).id,
      hostname: site.host,
      triggeredByType: 'manual_api',
      pageSelectionMode: 'static_list',
      checks: ['seo', 'forms'],
      formMode: 'detect',
      status: 'queued',
    });
    expect(row.staticPageUrls).toEqual([`${site.url}/`, `${site.url}/contact`]);

    // The schedule is left alone.
    const after = await ctx.db.website.findUniqueOrThrow({
      where: { id: (website as Website).id },
    });
    expect(after.nextCheckAt).toEqual(before);
  });

  it('is marked as n8n or monday when the key says so, and as a dashboard check for a person', async () => {
    const source = async (payload: Record<string, unknown>, useSession = false) => {
      const { website } = await createWebsite();
      const res = useSession
        ? await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/websites/${(website as Website).id}/check-now`,
            headers: { cookie: admin },
            payload,
          })
        : await post(`/websites/${(website as Website).id}/check-now`, payload);
      expect(res.statusCode).toBe(202);
      const row = await ctx.db.scan.findUniqueOrThrow({
        where: { id: res.json<{ id: string }>().id },
      });
      return row;
    };
    expect((await source({ source: 'n8n' })).triggeredByType).toBe('n8n');
    expect((await source({ source: 'monday' })).triggeredByType).toBe('monday');
    expect((await source({})).triggeredByType).toBe('manual_api');
    // A person in the dashboard cannot claim to be n8n.
    expect((await source({ source: 'n8n' }, true)).triggeredByType).toBe('manual_ui');
  });

  it('passes a callback url and metadata to the scan', async () => {
    const { website } = await createWebsite();
    const res = await post(`/websites/${(website as Website).id}/check-now`, {
      source: 'n8n',
      callbackUrl: 'https://n8n.example.com/webhook/beacon',
      metadata: { mondayItemId: '42' },
    });
    const row = await ctx.db.scan.findUniqueOrThrow({
      where: { id: res.json<{ id: string }>().id },
    });
    expect(row.callbackUrl).toBe('https://n8n.example.com/webhook/beacon');
    expect(row.metadata).toEqual({ mondayItemId: '42' });
  });

  it('accepts no body at all', async () => {
    const { website } = await createWebsite();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/websites/${(website as Website).id}/check-now`,
      headers: bearer(writer),
    });
    expect(res.statusCode, res.body).toBe(202);
  });

  it('answers 409 with the running check, 404 for an unknown website, 403 without write access', async () => {
    const { website } = await createWebsite();
    const id = (website as Website).id;
    const first = await post(`/websites/${id}/check-now`, {});
    const second = await post(`/websites/${id}/check-now`, {});
    expect(second.statusCode).toBe(409);
    expect((errorOf(second).details as { scan: { id: string } }).scan.id).toBe(
      first.json<{ id: string }>().id,
    );
    expect((await post('/websites/web_none/check-now', {})).statusCode).toBe(404);
    expect((await post(`/websites/${id}/check-now`, {}, reader)).statusCode).toBe(403);
  });

  it('still runs for a paused website', async () => {
    const { website } = await createWebsite({ isActive: false });
    expect((await post(`/websites/${(website as Website).id}/check-now`, {})).statusCode).toBe(202);
  });
});

describe('POST /scans with a website', () => {
  it('inherits from the website, lets the request override, and needs no url', async () => {
    const site = fresh();
    const { website } = await createWebsite({
      url: site.url,
      pageSelectionMode: 'random_sample',
      sampleSize: 6,
      pinnedPageUrls: [`${site.url}/contact/`],
      enabledChecks: ['images', 'seo'],
      formMode: 'validate_only',
    });
    const res = await post('/scans', {
      websiteId: (website as Website).id,
      checks: ['links'],
      sampleSize: 3,
    });
    expect(res.statusCode).toBe(202);
    const row = await ctx.db.scan.findUniqueOrThrow({
      where: { id: res.json<{ id: string }>().id },
    });
    expect(row).toMatchObject({
      websiteId: (website as Website).id,
      url: `${site.url}/`,
      checks: ['links'],
      formMode: 'validate_only',
      pageSelectionMode: 'random_sample',
      sampleSize: 3,
      pinnedPageUrls: [`${site.url}/contact`],
    });
  });

  it('marks the source, for a key only', async () => {
    const { website } = await createWebsite();
    const res = await post('/scans', { websiteId: (website as Website).id, source: 'monday' });
    const row = await ctx.db.scan.findUniqueOrThrow({
      where: { id: res.json<{ id: string }>().id },
    });
    expect(row.triggeredByType).toBe('monday');
  });

  it('refuses a url on another host, and an unknown website', async () => {
    const { website } = await createWebsite();
    const wrong = await post('/scans', {
      websiteId: (website as Website).id,
      url: 'https://elsewhere.example.com',
    });
    expect(wrong.statusCode).toBe(400);
    expect(errorOf(wrong).message).toContain('Leave the url out');
    expect((await post('/scans', { websiteId: 'web_none' })).statusCode).toBe(404);
    expect((await post('/scans', {})).statusCode).toBe(400);
  });

  it('a one-off scan of no website is a full crawl, exactly as before', async () => {
    const site = fresh();
    const res = await post('/scans', { url: site.url });
    const row = await ctx.db.scan.findUniqueOrThrow({
      where: { id: res.json<{ id: string }>().id },
    });
    expect(row).toMatchObject({
      websiteId: null,
      pageSelectionMode: 'full',
      triggeredByType: 'manual_api',
    });
    const detail = (await get(`/scans/${row.id}`)).json<{
      website: unknown;
      triggeredByType: string;
      pageSelectionMode: string;
    }>();
    expect(detail).toMatchObject({
      website: null,
      triggeredByType: 'manual_api',
      pageSelectionMode: 'full',
    });
  });

  it('a one-off scan can still choose a static list or a sample', async () => {
    const site = fresh();
    const res = await post('/scans', {
      url: site.url,
      pageSelectionMode: 'static_list',
      staticPageUrls: [`${site.url}/a`],
    });
    expect(res.statusCode).toBe(202);
    const bad = await post('/scans', { url: fresh().url, pageSelectionMode: 'static_list' });
    expect(bad.statusCode).toBe(400);
    const foreign = await post('/scans', {
      url: fresh().url,
      pageSelectionMode: 'static_list',
      staticPageUrls: ['https://elsewhere.example.com/x'],
    });
    expect(foreign.statusCode).toBe(400);
  });

  it('shows the website on the scan, and compares only with checks of the same website', async () => {
    const { website, site } = await createWebsite({ name: 'Compared' });
    const id = (website as Website).id;
    // A one-off audit of the same host, and an earlier check of the website.
    await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 1,
      healthScore: 99,
      createdAt: new Date('2026-06-02T00:00:00Z'),
    });
    const earlier = await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 2,
      websiteId: id,
      healthScore: 60,
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    const current = await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 3,
      websiteId: id,
      healthScore: 75,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    });

    const detail = (await get(`/scans/${current}`)).json<{
      website: { id: string; name: string };
      previousScan: { id: string };
      scoreChange: number;
    }>();
    expect(detail.website).toEqual({ id, name: 'Compared' });
    expect(detail.previousScan.id).toBe(earlier);
    expect(detail.scoreChange).toBe(15);
  });

  it('follows the stored previous scan once a check is complete', async () => {
    const { website, site } = await createWebsite();
    const id = (website as Website).id;
    const a = await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 1,
      websiteId: id,
      healthScore: 50,
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 2,
      websiteId: id,
      healthScore: 90,
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    const c = await insertScan(ctx.db, {
      hostname: site.host,
      runNumber: 3,
      websiteId: id,
      healthScore: 80,
      previousScanId: a,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    });
    const detail = (await get(`/scans/${c}`)).json<{ previousScan: { id: string } }>();
    expect(detail.previousScan.id).toBe(a);
  });
});

describe('the OpenAPI document', () => {
  it('describes the website endpoints', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/docs/json' });
    const spec = res.json<{
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    }>();
    for (const path of [
      '/api/v1/websites',
      '/api/v1/websites/{id}',
      '/api/v1/websites/{id}/check-now',
      '/api/v1/websites/{id}/history',
      '/api/v1/websites/{id}/recipients',
      '/api/v1/websites/{id}/recipients/{recipientId}',
    ]) {
      expect(spec.paths[path], path).toBeDefined();
    }
    expect(spec.components.schemas).toHaveProperty('Website');
    expect(spec.components.schemas).toHaveProperty('CreateWebsiteBody');
  });
});
