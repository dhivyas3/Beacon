import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestApp,
  errorOf,
  insertIssue,
  insertPage,
  insertScan,
  type TestApp,
} from '../test/helpers.js';

let ctx: TestApp;
let writer: string;
let reader: string;

// Scan under test: 4 pages, a mix of severities, one issue shared by three pages.
let scanId: string;
let pageIds: string[];
let brokenImageIds: string[];

const HOST = 'report.example.com';

beforeAll(async () => {
  ctx = await createTestApp();
  writer = (await ctx.createApiKey(['scans:read', 'scans:write'])).key;
  reader = (await ctx.createApiKey(['scans:read'])).key;

  // An older completed scan of the same hostname, used for new / still_open labels.
  const oldScan = await insertScan(ctx.db, {
    hostname: HOST,
    status: 'completed',
    runNumber: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    healthScore: 80,
    pagesTotal: 4,
  });
  const oldPage = await insertPage(ctx.db, oldScan, `https://${HOST}/`);
  await insertIssue(ctx.db, { scanId: oldScan, pageId: oldPage, fingerprint: 'fp-broken-image' });
  await insertIssue(ctx.db, {
    scanId: oldScan,
    pageId: oldPage,
    fingerprint: 'fp-fixed-since',
    severity: 'warning',
  });

  scanId = await insertScan(ctx.db, {
    hostname: HOST,
    status: 'completed',
    runNumber: 2,
    healthScore: 60,
    pagesTotal: 4,
    createdAt: new Date('2026-02-01T00:00:00Z'),
  });
  pageIds = [];
  for (const path of ['', 'about', 'contact', 'blog']) {
    pageIds.push(await insertPage(ctx.db, scanId, `https://${HOST}/${path}`));
  }

  brokenImageIds = [];
  const base = Date.parse('2026-02-01T00:00:10Z');
  for (const [index, pageId] of pageIds.slice(0, 3).entries()) {
    brokenImageIds.push(
      await insertIssue(ctx.db, {
        scanId,
        pageId,
        fingerprint: 'fp-broken-image',
        severity: 'critical',
        checkType: 'images',
        message: 'Image failed to load',
        createdAt: new Date(base + index * 1000),
      }),
    );
  }
  await insertIssue(ctx.db, {
    scanId,
    pageId: pageIds[0],
    fingerprint: 'fp-new-title',
    severity: 'warning',
    checkType: 'seo',
    message: 'Missing meta description',
    createdAt: new Date(base + 5000),
  });
  await insertIssue(ctx.db, {
    scanId,
    pageId: pageIds[3],
    fingerprint: 'fp-info',
    severity: 'info',
    checkType: 'forms',
    message: 'Form detected',
    createdAt: new Date(base + 6000),
  });
  await insertIssue(ctx.db, {
    scanId,
    pageId: null,
    fingerprint: 'fp-robots',
    severity: 'critical',
    checkType: 'seo',
    message: 'robots.txt blocks everything',
    createdAt: new Date(base + 7000),
  });

  await ctx.db.scan.update({
    where: { id: scanId },
    data: { criticalCount: 4, warningCount: 1 },
  });
  await ctx.db.scanPage.update({
    where: { id: pageIds[0] as string },
    data: { criticalCount: 1, warningCount: 1 },
  });
  await ctx.db.scanPage.update({ where: { id: pageIds[1] as string }, data: { criticalCount: 1 } });
  await ctx.db.checkResult.createMany({
    data: [
      { id: 'chk_aaaaaaaaaaaa', scanId, checkType: 'images', pagesChecked: 4, issuesFound: 3 },
      { id: 'chk_bbbbbbbbbbbb', scanId, checkType: 'links', pagesChecked: 4, issuesFound: 0 },
    ],
  });
});

afterAll(async () => {
  await ctx.close();
});

function get(url: string, key = reader) {
  return ctx.app.inject({ method: 'GET', url, headers: bearer(key) });
}

interface IssueBody {
  id: string;
  severity: string;
  checkType: string;
  pageUrl: string | null;
  comparison: string | null;
  state: string;
  fingerprint: string;
}

describe('GET /scans/:id/pages', () => {
  it('lists pages sorted by url with pagination', async () => {
    const first = await get(`/api/v1/scans/${scanId}/pages?limit=3`);
    expect(first.statusCode).toBe(200);
    const body = first.json<{ items: { url: string }[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(3);
    expect(body.items.map((p) => p.url)).toEqual([...body.items.map((p) => p.url)].sort());
    expect(body.nextCursor).not.toBeNull();

    const second = await get(`/api/v1/scans/${scanId}/pages?limit=3&cursor=${body.nextCursor}`);
    const rest = second.json<{ items: { url: string }[]; nextCursor: string | null }>();
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    const all = [...body.items, ...rest.items].map((p) => p.url);
    expect(new Set(all).size).toBe(4);
  });

  it('filters by issues and url text', async () => {
    const withIssues = await get(`/api/v1/scans/${scanId}/pages?hasIssues=true`);
    expect(withIssues.json<{ items: unknown[] }>().items).toHaveLength(2);
    const clean = await get(`/api/v1/scans/${scanId}/pages?hasIssues=false`);
    expect(clean.json<{ items: unknown[] }>().items).toHaveLength(2);
    const search = await get(`/api/v1/scans/${scanId}/pages?q=ABOUT`);
    expect(search.json<{ items: { url: string }[] }>().items.map((p) => p.url)).toEqual([
      `https://${HOST}/about`,
    ]);
  });

  it('answers 404 for an unknown scan', async () => {
    expect((await get('/api/v1/scans/scn_missing/pages')).statusCode).toBe(404);
  });
});

describe('GET /scans/:id/issues', () => {
  it('lists most severe first with page url and evidence', async () => {
    const res = await get(`/api/v1/scans/${scanId}/issues?limit=100`);
    expect(res.statusCode).toBe(200);
    const { items } = res.json<{ items: IssueBody[] }>();
    expect(items).toHaveLength(6);
    const severities = items.map((issue) => issue.severity);
    expect(severities).toEqual([...severities].sort((a, b) => order(a) - order(b)));
    expect(items[0]).toMatchObject({ severity: 'critical' });
    expect(items.find((issue) => issue.pageUrl === null)?.checkType).toBe('seo');
  });

  it('filters by severity, check type, state and page', async () => {
    const list = async (query: string) =>
      (await get(`/api/v1/scans/${scanId}/issues?${query}`)).json<{ items: IssueBody[] }>().items;

    expect(await list('severity=critical')).toHaveLength(4);
    expect(await list('severity=warning')).toHaveLength(1);
    expect(await list('checkType=seo')).toHaveLength(2);
    expect(await list('checkType=seo&severity=critical')).toHaveLength(1);
    expect(await list('state=ignored')).toHaveLength(0);
    expect(await list(`pageId=${pageIds[0]}`)).toHaveLength(2);
  });

  it('paginates without repeating or skipping issues', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await get(
        `/api/v1/scans/${scanId}/issues?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      const body: { items: IssueBody[]; nextCursor: string | null } = res.json();
      seen.push(...body.items.map((issue) => issue.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('labels each issue new or still open against the previous completed scan', async () => {
    const { items } = (await get(`/api/v1/scans/${scanId}/issues?limit=100`)).json<{
      items: IssueBody[];
    }>();
    const byFingerprint = new Map(items.map((issue) => [issue.fingerprint, issue.comparison]));
    expect(byFingerprint.get('fp-broken-image')).toBe('still_open');
    expect(byFingerprint.get('fp-new-title')).toBe('new');
    expect(byFingerprint.get('fp-robots')).toBe('new');
  });

  it('shows no labels when the hostname has no earlier completed scan', async () => {
    const lonely = await insertScan(ctx.db, { hostname: 'lonely.example.com', runNumber: 1 });
    await insertIssue(ctx.db, { scanId: lonely, fingerprint: 'fp-x' });
    const { items } = (await get(`/api/v1/scans/${lonely}/issues`)).json<{ items: IssueBody[] }>();
    expect(items[0]?.comparison).toBeNull();
  });

  it('groups by fingerprint with the number of affected pages', async () => {
    const res = await get(`/api/v1/scans/${scanId}/issues?groupBy=fingerprint&limit=100`);
    expect(res.statusCode).toBe(200);
    const { items } = res.json<{
      items: {
        fingerprint: string;
        affectedPages: number;
        occurrences: number;
        severity: string;
        state: string;
        comparison: string | null;
        sample: { id: string; message: string };
      }[];
    }>();
    expect(items).toHaveLength(4);

    const broken = items.find((group) => group.fingerprint === 'fp-broken-image');
    expect(broken).toMatchObject({
      affectedPages: 3,
      occurrences: 3,
      severity: 'critical',
      state: 'open',
      comparison: 'still_open',
    });
    expect(broken?.sample.message).toBe('Image failed to load');
    expect(brokenImageIds).toContain(broken?.sample.id);

    // Critical groups come first, and among them the widest impact first.
    expect(items[0]?.fingerprint).toBe('fp-broken-image');
    expect(items.at(-1)?.severity).toBe('info');
  });

  it('paginates groups and applies filters', async () => {
    const first = await get(`/api/v1/scans/${scanId}/issues?groupBy=fingerprint&limit=2`);
    const body = first.json<{ items: { fingerprint: string }[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
    const second = await get(
      `/api/v1/scans/${scanId}/issues?groupBy=fingerprint&limit=2&cursor=${body.nextCursor}`,
    );
    const next = second.json<{ items: { fingerprint: string }[] }>();
    const fingerprints = [...body.items, ...next.items].map((g) => g.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);

    const seoOnly = await get(`/api/v1/scans/${scanId}/issues?groupBy=fingerprint&checkType=seo`);
    expect(seoOnly.json<{ items: unknown[] }>().items).toHaveLength(2);
  });

  it('rejects invalid filters and cursors', async () => {
    for (const query of ['severity=huge', 'checkType=vibes', 'groupBy=page', 'cursor=@@@']) {
      expect((await get(`/api/v1/scans/${scanId}/issues?${query}`)).statusCode).toBe(400);
    }
    const badGroupCursor = await get(
      `/api/v1/scans/${scanId}/issues?groupBy=fingerprint&cursor=${Buffer.from('abc').toString('base64url')}`,
    );
    expect(badGroupCursor.statusCode).toBe(400);
  });
});

describe('scan detail with a previous scan', () => {
  it('shows the score change and how many issues were fixed', async () => {
    const res = await get(`/api/v1/scans/${scanId}`);
    const detail = res.json<{
      previousScan: { runNumber: number; healthScore: number };
      scoreChange: number;
      fixedIssueCount: number;
      checkResults: { checkType: string; issuesFound: number }[];
    }>();
    expect(detail.previousScan).toMatchObject({ runNumber: 1, healthScore: 80 });
    expect(detail.scoreChange).toBe(-20);
    // fp-fixed-since existed before and is gone now.
    expect(detail.fixedIssueCount).toBe(1);
    expect(detail.checkResults).toEqual([
      { checkType: 'images', pagesChecked: 4, issuesFound: 3 },
      { checkType: 'links', pagesChecked: 4, issuesFound: 0 },
    ]);
  });
});

describe('PATCH /scans/:id/issues/:issueId', () => {
  function patch(issueId: string, payload: Record<string, unknown>, key = writer, scan = scanId) {
    return ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/scans/${scan}/issues/${issueId}`,
      headers: bearer(key),
      payload,
    });
  }

  it('ignores an issue with a note and reopens it', async () => {
    const id = brokenImageIds[2] as string;
    const ignored = await patch(id, { state: 'ignored', ignoreNote: 'Known: MON-1042' });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json()).toMatchObject({
      id,
      state: 'ignored',
      ignoreNote: 'Known: MON-1042',
      comparison: 'still_open',
    });

    const listed = await get(`/api/v1/scans/${scanId}/issues?state=ignored`);
    expect(listed.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([id]);

    const reopened = await patch(id, { state: 'open', ignoreNote: 'ignored by mistake' });
    expect(reopened.json()).toMatchObject({ state: 'open', ignoreNote: null });
  });

  it('recalculates counts and score on a completed scan', async () => {
    const before = await ctx.db.scan.findUniqueOrThrow({ where: { id: scanId } });
    expect(before.criticalCount).toBe(4);

    const id = brokenImageIds[0] as string;
    await patch(id, { state: 'ignored', ignoreNote: 'accepted' });

    const after = await ctx.db.scan.findUniqueOrThrow({ where: { id: scanId } });
    // 3 open critical (one broken image ignored) and 1 warning over 4 pages: 100 - (15 + 1) / 4 * 10.
    expect(after.criticalCount).toBe(3);
    expect(after.warningCount).toBe(1);
    expect(after.healthScore).toBe(60);
    const page = await ctx.db.scanPage.findUniqueOrThrow({ where: { id: pageIds[0] as string } });
    expect(page.criticalCount).toBe(0);

    await patch(id, { state: 'open' });
    const restored = await ctx.db.scan.findUniqueOrThrow({ where: { id: scanId } });
    expect(restored.criticalCount).toBe(4);
    expect(restored.healthScore).toBe(48);
  });

  it('groups show ignored only when every occurrence is ignored', async () => {
    for (const id of brokenImageIds) await patch(id, { state: 'ignored', ignoreNote: 'all' });
    const res = await get(`/api/v1/scans/${scanId}/issues?groupBy=fingerprint&limit=100`);
    const broken = res
      .json<{ items: { fingerprint: string; state: string }[] }>()
      .items.find((group) => group.fingerprint === 'fp-broken-image');
    expect(broken?.state).toBe('ignored');

    await patch(brokenImageIds[1] as string, { state: 'open' });
    const partial = await get(`/api/v1/scans/${scanId}/issues?groupBy=fingerprint&limit=100`);
    expect(
      partial
        .json<{ items: { fingerprint: string; state: string }[] }>()
        .items.find((group) => group.fingerprint === 'fp-broken-image')?.state,
    ).toBe('open');
    for (const id of brokenImageIds) await patch(id, { state: 'open' });
  });

  it('needs the write scope and a valid body', async () => {
    const id = brokenImageIds[0] as string;
    const denied = await patch(id, { state: 'ignored' }, reader);
    expect(denied.statusCode).toBe(403);

    for (const payload of [
      {},
      { state: 'deleted' },
      { state: 'ignored', ignoreNote: 'x'.repeat(501) },
    ]) {
      const res = await patch(id, payload);
      expect(res.statusCode).toBe(400);
    }
  });

  it('answers 404 for an unknown issue or an issue from another scan', async () => {
    const missing = await patch('iss_missing', { state: 'ignored' });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('not_found');

    const other = await insertScan(ctx.db, { hostname: 'other.example.com' });
    const wrongScan = await patch(brokenImageIds[0] as string, { state: 'ignored' }, writer, other);
    expect(wrongScan.statusCode).toBe(404);

    const noScan = await patch(
      brokenImageIds[0] as string,
      { state: 'ignored' },
      writer,
      'scn_nope',
    );
    expect(noScan.statusCode).toBe(404);
  });
});

function order(severity: string): number {
  return ['critical', 'warning', 'info'].indexOf(severity);
}
