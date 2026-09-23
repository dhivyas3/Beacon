import { Queue } from 'bullmq';
import type { LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { screenshotKey } from '@beacon/storage';
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
let submitter: string;
let hostCounter = 0;

beforeAll(async () => {
  ctx = await createTestApp();
  await ctx.allowDomain('*.example.com');
  writer = (await ctx.createApiKey(['scans:read', 'scans:write'], 'n8n writer')).key;
  reader = (await ctx.createApiKey(['scans:read'], 'reader')).key;
  submitter = (await ctx.createApiKey(['scans:read', 'scans:write', 'forms:submit'], 'submitter'))
    .key;
});

afterAll(async () => {
  await ctx.close();
});

/** A fresh hostname per call, so tests do not trip the one-active-scan-per-host rule. */
function freshUrl(): string {
  hostCounter += 1;
  return `https://site${hostCounter}.example.com`;
}

function createScan(
  payload: Record<string, unknown>,
  key = writer,
  headers: Record<string, string> = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/scans',
    headers: { ...bearer(key), ...headers },
    payload,
  });
}

function getScan(id: string, key = reader) {
  return ctx.app.inject({ method: 'GET', url: `/api/v1/scans/${id}`, headers: bearer(key) });
}

describe('POST /scans', () => {
  it('queues a scan and answers 202 with links', async () => {
    const url = freshUrl();
    const res = await createScan({ url, metadata: { mondayItemId: '123', nested: { a: [1, 2] } } });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ id: string; status: string; statusUrl: string; reportUrl: string }>();
    expect(body.id).toMatch(/^scn_[0-9A-Za-z]{12}$/);
    expect(body.status).toBe('queued');
    expect(body.statusUrl).toBe(`http://qa.test/api/v1/scans/${body.id}`);
    expect(body.reportUrl).toBe(`http://qa.test/scans/${body.id}`);

    const row = await ctx.db.scan.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({
      hostname: new URL(url).hostname,
      runNumber: 1,
      formMode: 'detect',
      status: 'queued',
    });
    expect(row.checks).toHaveLength(6);
    expect(row.triggeredByApiKeyId).not.toBeNull();
  });

  it('puts a job on the scan queue', async () => {
    const res = await createScan({ url: freshUrl() });
    const { id } = res.json<{ id: string }>();
    const connection = new Redis(ctx.redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue('scan', { connection, prefix: ctx.queuePrefix });
    try {
      const job = await queue.getJob(id);
      expect(job?.data).toEqual({ scanId: id });
    } finally {
      await queue.close();
      connection.disconnect();
    }
  });

  it('echoes metadata untouched and normalises the url', async () => {
    const metadata = { mondayItemId: '987', tags: ['a', 'b'], deep: { ok: true } };
    const res = await createScan({
      url: `${freshUrl()}/?utm_source=x#top`,
      metadata,
      checks: ['seo', 'images', 'seo'],
    });
    const { id } = res.json<{ id: string }>();
    const scan = (await getScan(id)).json<{
      url: string;
      metadata: unknown;
      checks: string[];
    }>();
    expect(scan.metadata).toEqual(metadata);
    expect(scan.url).toMatch(/^https:\/\/site\d+\.example\.com\/$/);
    expect(scan.checks).toEqual(['seo', 'images']);
  });

  it('records who triggered the scan', async () => {
    const admin = await ctx.adminCookie();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/scans',
      headers: { cookie: admin },
      payload: { url: freshUrl() },
    });
    expect(res.statusCode).toBe(202);
    const scan = (await getScan(res.json<{ id: string }>().id)).json<{
      triggeredBy: { type: string; name: string };
    }>();
    expect(scan.triggeredBy).toMatchObject({ type: 'user', name: 'Admin' });

    const viaKey = await createScan({ url: freshUrl() });
    const keyScan = (await getScan(viaKey.json<{ id: string }>().id)).json<{
      triggeredBy: { type: string; name: string };
    }>();
    expect(keyScan.triggeredBy).toMatchObject({ type: 'api_key', name: 'n8n writer' });
  });

  describe('validation', () => {
    it('rejects a missing or malformed url with 400', async () => {
      for (const payload of [
        {},
        { url: 'example.com' },
        { url: 'ftp://a.example.com' },
        { url: 42 },
      ]) {
        const res = await createScan(payload);
        expect(res.statusCode).toBe(400);
        expect(errorOf(res).code).toBe('validation_error');
      }
    });

    it('rejects unknown checks, empty checks and bad form modes', async () => {
      for (const extra of [{ checks: ['nope'] }, { checks: [] }, { formMode: 'yolo' }]) {
        const res = await createScan({ url: freshUrl(), ...extra });
        expect(res.statusCode).toBe(400);
      }
    });

    it('rejects invalid JSON with a JSON error body', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/scans',
        headers: { ...bearer(writer), 'content-type': 'application/json' },
        payload: '{"url": ',
      });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('bad_request');
    });

    it('lists what was wrong in details', async () => {
      const res = await createScan({ url: 'nope', checks: ['bad'] });
      const error = errorOf(res) as { details: { issues: { path: string }[] } };
      expect(error.details.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(['url', 'checks.0']),
      );
    });
  });

  describe('allowed domains', () => {
    it('answers 422 when the hostname is not allowed', async () => {
      const res = await createScan({ url: 'https://not-allowed.org' });
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'domain_not_allowed',
        details: { hostname: 'not-allowed.org' },
      });
      expect(errorOf(res).message).toMatch(/Ask an admin/);
    });

    it('matches wildcard entries on the apex and subdomains only', async () => {
      expect((await createScan({ url: 'https://example.com' })).statusCode).toBe(202);
      expect((await createScan({ url: 'https://deep.sub.example.com' })).statusCode).toBe(202);
      expect((await createScan({ url: 'https://evilexample.com' })).statusCode).toBe(422);
    });
  });

  describe('SSRF protection', () => {
    it('refuses hostnames that resolve to private addresses', async () => {
      await ctx.allowDomain('private-app.example.com');
      const res = await createScan({ url: 'https://private-app.example.com' });
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({ code: 'url_blocked', details: { field: 'url' } });
    });

    it('refuses cloud metadata and loopback addresses even if an admin allows them', async () => {
      await ctx.allowDomain('169.254.169.254');
      await ctx.allowDomain('127.0.0.1');
      for (const url of ['http://169.254.169.254/latest', 'http://127.0.0.1:8080/']) {
        const res = await createScan({ url });
        expect(res.statusCode).toBe(422);
        expect(errorOf(res).code).toBe('url_blocked');
      }
    });

    it('applies the same checks to callback URLs', async () => {
      for (const callbackUrl of [
        'http://127.0.0.1:5678/webhook',
        'http://169.254.169.254/',
        'https://private-hook.example.com/x',
        'http://localhost/hook',
      ]) {
        const res = await createScan({ url: freshUrl(), callbackUrl });
        expect(res.statusCode).toBe(422);
        expect(errorOf(res)).toMatchObject({
          code: 'url_blocked',
          details: { field: 'callbackUrl' },
        });
      }
      const ok = await createScan({
        url: freshUrl(),
        callbackUrl: 'https://n8n.example.com/webhook/qa',
      });
      expect(ok.statusCode).toBe(202);
    });

    it('permits local targets only when ALLOW_LOCAL_TARGETS is set', async () => {
      const local = await createTestApp({ ALLOW_LOCAL_TARGETS: 'true' });
      try {
        await local.allowDomain('127.0.0.1');
        const { key } = await local.createApiKey();
        const res = await local.app.inject({
          method: 'POST',
          url: '/api/v1/scans',
          headers: bearer(key),
          payload: { url: 'http://127.0.0.1:4010/' },
        });
        expect(res.statusCode).toBe(202);
      } finally {
        await local.close();
      }
    });
  });

  describe('form submission scope', () => {
    it('needs forms:submit for formMode submit', async () => {
      const denied = await createScan({ url: freshUrl(), formMode: 'submit' });
      expect(denied.statusCode).toBe(403);
      expect(errorOf(denied)).toMatchObject({
        code: 'forbidden',
        details: { requiredScope: 'forms:submit' },
      });

      const allowed = await createScan({ url: freshUrl(), formMode: 'submit' }, submitter);
      expect(allowed.statusCode).toBe(202);
      const scan = await getScan(allowed.json<{ id: string }>().id);
      expect(scan.json<{ formMode: string }>().formMode).toBe('submit');
    });

    it('allows the safer modes without the scope', async () => {
      for (const formMode of ['detect', 'validate_only']) {
        const res = await createScan({ url: freshUrl(), formMode });
        expect(res.statusCode).toBe(202);
      }
    });
  });

  describe('idempotency', () => {
    it('returns the original scan for a repeated key', async () => {
      const url = freshUrl();
      const first = await createScan({ url }, writer, { 'idempotency-key': 'monday-item-1' });
      expect(first.statusCode).toBe(202);
      expect(first.headers['idempotent-replayed']).toBeUndefined();

      const second = await createScan({ url }, writer, { 'idempotency-key': 'monday-item-1' });
      expect(second.statusCode).toBe(202);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

      const count = await ctx.db.scan.count({ where: { hostname: new URL(url).hostname } });
      expect(count).toBe(1);
    });

    it('does not answer 409 when a retry arrives while the scan is still active', async () => {
      const url = freshUrl();
      const headers = { 'idempotency-key': 'retry-while-running' };
      const first = await createScan({ url }, writer, headers);
      await ctx.db.scan.update({
        where: { id: first.json<{ id: string }>().id },
        data: { status: 'running' },
      });
      const retry = await createScan({ url }, writer, headers);
      expect(retry.statusCode).toBe(202);
      expect(retry.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    });

    it('scopes keys to the caller', async () => {
      const other = (await ctx.createApiKey(['scans:read', 'scans:write'], 'other')).key;
      const headers = { 'idempotency-key': 'shared-value' };
      const a = await createScan({ url: freshUrl() }, writer, headers);
      const b = await createScan({ url: freshUrl() }, other, headers);
      expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
    });

    it('rejects an empty or oversized key', async () => {
      const long = 'x'.repeat(201);
      for (const key of ['   ', long]) {
        const res = await createScan({ url: freshUrl() }, writer, { 'idempotency-key': key });
        expect(res.statusCode).toBe(400);
      }
    });

    it('survives concurrent duplicates: one scan, every caller gets it', async () => {
      const url = freshUrl();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          createScan({ url }, writer, { 'idempotency-key': 'parallel' }),
        ),
      );
      const ids = new Set(results.map((res) => res.json<{ id: string }>().id));
      expect(results.every((res) => res.statusCode === 202)).toBe(true);
      expect(ids.size).toBe(1);
    });
  });

  describe('duplicate active scans', () => {
    it('answers 409 with the existing scan in the body', async () => {
      const url = freshUrl();
      const first = await createScan({ url });
      const firstId = first.json<{ id: string }>().id;

      const dup = await createScan({ url });
      expect(dup.statusCode).toBe(409);
      const error = errorOf(dup) as {
        code: string;
        message: string;
        details: { scan: { id: string; status: string; progress: object } };
      };
      expect(error.code).toBe('conflict');
      expect(error.details.scan).toMatchObject({ id: firstId, status: 'queued' });
      expect(error.details.scan.progress).toMatchObject({
        phase: 'queued',
        queuePosition: expect.any(Number),
      });
    });

    it('applies to running and discovering scans, and clears when the scan ends', async () => {
      const url = freshUrl();
      const first = await createScan({ url });
      const id = first.json<{ id: string }>().id;

      for (const status of ['discovering', 'running'] as const) {
        await ctx.db.scan.update({ where: { id }, data: { status } });
        expect((await createScan({ url })).statusCode).toBe(409);
      }

      await ctx.db.scan.update({
        where: { id },
        data: { status: 'completed', finishedAt: new Date() },
      });
      const next = await createScan({ url });
      expect(next.statusCode).toBe(202);
      const scan = await getScan(next.json<{ id: string }>().id);
      expect(scan.json<{ runNumber: number }>().runNumber).toBe(2);
    });

    it('lets exactly one of several simultaneous requests win', async () => {
      const url = freshUrl();
      const results = await Promise.all(Array.from({ length: 5 }, () => createScan({ url })));
      const statuses = results.map((res) => res.statusCode).sort();
      expect(statuses).toEqual([202, 409, 409, 409, 409]);
      expect(await ctx.db.scan.count({ where: { hostname: new URL(url).hostname } })).toBe(1);
    });

    it('does not burn run numbers on rejected requests', async () => {
      const url = freshUrl();
      const first = await createScan({ url });
      await createScan({ url });
      await createScan({ url });
      await ctx.db.scan.update({
        where: { id: first.json<{ id: string }>().id },
        data: { status: 'completed' },
      });
      const second = await createScan({ url });
      const scan = await getScan(second.json<{ id: string }>().id);
      expect(scan.json<{ runNumber: number }>().runNumber).toBe(2);
    });
  });
});

describe('GET /scans/:id', () => {
  it('returns status, progress, summary and check results', async () => {
    const res = await createScan({ url: freshUrl() });
    const { id } = res.json<{ id: string }>();
    await ctx.db.checkResult.create({
      data: {
        id: `chk_test${id.slice(4)}`,
        scanId: id,
        checkType: 'images',
        pagesChecked: 12,
        issuesFound: 0,
      },
    });

    const detail = await getScan(id);
    expect(detail.statusCode).toBe(200);
    const body = detail.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      id,
      status: 'queued',
      runNumber: 1,
      progress: {
        phase: 'queued',
        percent: 0,
        etaSeconds: null,
        estimating: false,
        queuePosition: expect.any(Number),
      },
      summary: { healthScore: null, pages: 0, critical: 0, warnings: 0 },
      checkResults: [{ checkType: 'images', pagesChecked: 12, issuesFound: 0 }],
      previousScan: null,
      scoreChange: null,
    });
  });

  it('reports queue position in creation order', async () => {
    const a = (await createScan({ url: freshUrl() })).json<{ id: string }>().id;
    const b = (await createScan({ url: freshUrl() })).json<{ id: string }>().id;
    const positionOf = async (id: string) =>
      (await getScan(id)).json<{ progress: { queuePosition: number } }>().progress.queuePosition;
    const before = await positionOf(b);
    expect(before - (await positionOf(a))).toBe(1);

    // Once the older scan starts running it leaves the queue and the next one moves up.
    await ctx.db.scan.update({ where: { id: a }, data: { status: 'running' } });
    expect(await positionOf(b)).toBe(before - 1);
  });

  it('shows live progress for a running scan', async () => {
    const id = (await createScan({ url: freshUrl() })).json<{ id: string }>().id;
    await ctx.db.scan.update({
      where: { id },
      data: {
        status: 'running',
        stage: 'pages',
        startedAt: new Date(Date.now() - 100_000),
        pagesFound: 214,
        pagesTotal: 214,
        pagesDone: 87,
        linksTotal: 1240,
        avgPageMs: 5000,
        avgLinkMs: 200,
      },
    });
    const progress = (await getScan(id)).json<{ progress: Record<string, unknown> }>().progress;
    expect(progress).toMatchObject({
      phase: 'running',
      percent: 38,
      pagesDone: 87,
      pagesTotal: 214,
      linksTotal: 1240,
      pagesPerMinute: 60,
      estimating: false,
      queuePosition: null,
    });
    expect(progress.etaSeconds).toBe(157);
    expect(typeof progress.estimatedFinishAt).toBe('string');
  });

  it('returns the actual duration data for a completed scan and never 100 before that', async () => {
    const id = (await createScan({ url: freshUrl() })).json<{ id: string }>().id;
    await ctx.db.scan.update({
      where: { id },
      data: { status: 'running', stage: 'finalising', startedAt: new Date(), progressPercent: 100 },
    });
    expect((await getScan(id)).json<{ progress: { percent: number } }>().progress.percent).toBe(99);

    await ctx.db.scan.update({
      where: { id },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        startedAt: new Date(Date.now() - 252_000),
        healthScore: 91,
      },
    });
    const done = (await getScan(id)).json<{
      progress: {
        percent: number;
        phase: string;
        elapsedSeconds: number;
        etaSeconds: number | null;
      };
    }>();
    expect(done.progress).toMatchObject({ percent: 100, phase: 'completed', etaSeconds: null });
    expect(done.progress.elapsedSeconds).toBeGreaterThanOrEqual(251);
  });

  it('answers 404 in the standard envelope for unknown scans', async () => {
    const res = await getScan('scn_doesnotexist');
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toEqual({
      code: 'not_found',
      message: 'Scan scn_doesnotexist was not found.',
    });
  });

  it('requires authentication', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/scans/scn_x' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /scans', () => {
  it('paginates newest first with a cursor and no overlap', async () => {
    const list = await createTestApp();
    try {
      await list.allowDomain('*.example.com');
      const { key } = await list.createApiKey();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await list.app.inject({
          method: 'POST',
          url: '/api/v1/scans',
          headers: bearer(key),
          payload: { url: `https://p${i}.example.com` },
        });
        ids.push(res.json<{ id: string }>().id);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: LightMyRequestResponse = await list.app.inject({
          method: 'GET',
          url: `/api/v1/scans?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          headers: bearer(key),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ items: { id: string }[]; nextCursor: string | null }>();
        expect(body.items.length).toBeLessThanOrEqual(2);
        seen.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect(seen).toEqual([...ids].reverse());
    } finally {
      await list.close();
    }
  });

  it('filters by status, hostname and text', async () => {
    const a = (await createScan({ url: 'https://filter-alpha.example.com' })).json<{ id: string }>()
      .id;
    await createScan({ url: 'https://filter-beta.example.com' });
    await ctx.db.scan.update({
      where: { id: a },
      data: { status: 'completed', finishedAt: new Date() },
    });

    const list = async (query: string) =>
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/scans?${query}`,
          headers: bearer(reader),
        })
      ).json<{ items: { id: string; hostname: string; status: string }[] }>().items;

    const completed = await list('status=completed&hostname=filter-alpha.example.com');
    expect(completed.map((item) => item.id)).toEqual([a]);

    const queued = await list('status=queued&q=filter-beta');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.hostname).toBe('filter-beta.example.com');

    expect(await list('hostname=nothing.example.com')).toEqual([]);
  });

  it('rejects a bad cursor, limit or status', async () => {
    for (const query of ['cursor=!!!', 'limit=0', 'limit=101', 'status=sleeping']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/scans?${query}`,
        headers: bearer(reader),
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('POST /scans/:id/cancel', () => {
  it('cancels a queued scan, removes its job and frees the hostname', async () => {
    const url = freshUrl();
    const id = (await createScan({ url })).json<{ id: string }>().id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/scans/${id}/cancel`,
      headers: bearer(writer),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; finishedAt: string; progress: { phase: string } }>();
    expect(body.status).toBe('cancelled');
    expect(body.progress.phase).toBe('cancelled');
    expect(body.finishedAt).toBeTruthy();

    const connection = new Redis(ctx.redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue('scan', { connection, prefix: ctx.queuePrefix });
    try {
      expect(await queue.getJob(id)).toBeUndefined();
    } finally {
      await queue.close();
      connection.disconnect();
    }

    expect((await createScan({ url })).statusCode).toBe(202);
  });

  it('answers 409 when the scan already finished, 404 when unknown, 403 without write scope', async () => {
    const id = (await createScan({ url: freshUrl() })).json<{ id: string }>().id;
    await ctx.db.scan.update({ where: { id }, data: { status: 'completed' } });

    const finished = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/scans/${id}/cancel`,
      headers: bearer(writer),
    });
    expect(finished.statusCode).toBe(409);
    expect(errorOf(finished).code).toBe('conflict');

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/scans/scn_nope/cancel',
      headers: bearer(writer),
    });
    expect(unknown.statusCode).toBe(404);

    const readOnly = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/scans/${id}/cancel`,
      headers: bearer(reader),
    });
    expect(readOnly.statusCode).toBe(403);
  });
});

describe('DELETE /scans/:id', () => {
  it('removes a finished scan, its pages, issues and screenshots', async () => {
    const id = await insertScan(ctx.db, { hostname: 'delete-me.example.com' });
    const pageId = await insertPage(ctx.db, id, 'https://delete-me.example.com/');
    const issueId = await insertIssue(ctx.db, { scanId: id, pageId, fingerprint: 'fp-1' });
    const key = screenshotKey(id, issueId);
    await ctx.storage.put(key, Buffer.from('png-bytes'));
    await ctx.db.scanIssue.update({ where: { id: issueId }, data: { screenshotPath: key } });

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/scans/${id}`,
      headers: bearer(writer),
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    expect(await ctx.db.scan.findUnique({ where: { id } })).toBeNull();
    expect(await ctx.db.scanPage.findMany({ where: { scanId: id } })).toEqual([]);
    expect(await ctx.db.scanIssue.findMany({ where: { scanId: id } })).toEqual([]);
    expect(await ctx.storage.get(key)).toBeNull();
  });

  it('leaves a later scan without a previousScan rather than failing', async () => {
    const host = new URL(freshUrl()).hostname;
    const earlier = await insertScan(ctx.db, { hostname: host, runNumber: 1 });
    const later = await insertScan(ctx.db, {
      hostname: host,
      runNumber: 2,
      previousScanId: earlier,
    });

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/scans/${earlier}`,
      headers: bearer(writer),
    });
    expect(res.statusCode).toBe(204);

    const row = await ctx.db.scan.findUniqueOrThrow({ where: { id: later } });
    expect(row.previousScanId).toBeNull();

    const detail = await getScan(later);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ previousScan: unknown }>().previousScan).toBeNull();
  });

  it('answers 409 for an active scan, 404 for unknown, 403 without write scope, 401 signed out', async () => {
    const id = (await createScan({ url: freshUrl() })).json<{ id: string }>().id;

    const active = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/scans/${id}`,
      headers: bearer(writer),
    });
    expect(active.statusCode).toBe(409);
    expect(errorOf(active).code).toBe('conflict');
    // Refused, so it is still there.
    expect(await ctx.db.scan.findUnique({ where: { id } })).not.toBeNull();

    const unknown = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/scans/scn_nope',
      headers: bearer(writer),
    });
    expect(unknown.statusCode).toBe(404);

    const done = await insertScan(ctx.db, { hostname: 'read-only-delete.example.com' });
    const readOnly = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/scans/${done}`,
      headers: bearer(reader),
    });
    expect(readOnly.statusCode).toBe(403);

    const signedOut = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/scans/${done}` });
    expect(signedOut.statusCode).toBe(401);
  });
});
