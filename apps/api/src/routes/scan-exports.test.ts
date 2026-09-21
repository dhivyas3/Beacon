import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BYTE_ORDER_MARK, csvLine } from '../services/report-export.js';
import { pdfSafe } from '../services/report-pdf.js';
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
let cookie: string;
let reader: string;

beforeAll(async () => {
  ctx = await createTestApp();
  cookie = await ctx.adminCookie();
  reader = (await ctx.createApiKey(['scans:read'])).key;
});

afterAll(async () => {
  await ctx.close();
});

/** A completed check and the one before it, so "fixed" has something to compare with. */
async function scanPair(
  host: string,
  mode: 'full' | 'random_sample',
): Promise<{ previous: string; current: string }> {
  const previous = await insertScan(ctx.db, {
    hostname: host,
    runNumber: 1,
    createdAt: new Date('2026-03-01T00:00:00Z'),
    healthScore: 70,
    pagesTotal: 3,
    pageSelectionMode: mode,
  });
  const current = await insertScan(ctx.db, {
    hostname: host,
    runNumber: 2,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    healthScore: 80,
    pagesTotal: 2,
    pageSelectionMode: mode,
    previousScanId: previous,
  });
  return { previous, current };
}

describe('GET /scans/:id/fixed', () => {
  it('lists problems the previous check had and this one does not', async () => {
    const { previous, current } = await scanPair('fixed-full.example.com', 'full');
    const home = await insertPage(ctx.db, previous, 'https://fixed-full.example.com/');
    const gone = await insertPage(ctx.db, previous, 'https://fixed-full.example.com/gone');
    await insertPage(ctx.db, current, 'https://fixed-full.example.com/');
    await insertIssue(ctx.db, { scanId: previous, pageId: home, fingerprint: 'fp-still' });
    await insertIssue(ctx.db, {
      scanId: previous,
      pageId: home,
      fingerprint: 'fp-fixed',
      severity: 'warning',
      message: 'Missing alt text',
    });
    await insertIssue(ctx.db, {
      scanId: previous,
      pageId: gone,
      fingerprint: 'fp-fixed',
      severity: 'warning',
      message: 'Missing alt text',
    });
    await insertIssue(ctx.db, { scanId: current, pageId: home, fingerprint: 'fp-still' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/scans/${current}/fixed`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          fingerprint: 'fp-fixed',
          checkType: 'images',
          severity: 'warning',
          message: 'Missing alt text',
          affectedPages: 2,
        },
      ],
    });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/scans/${current}`,
      headers: { cookie },
    });
    expect(detail.json<{ fixedIssueCount: number }>().fixedIssueCount).toBe(1);
  });

  it('does not count a problem on a page a sampled check did not look at again', async () => {
    const { previous, current } = await scanPair('fixed-sample.example.com', 'random_sample');
    const rechecked = await insertPage(ctx.db, previous, 'https://fixed-sample.example.com/a');
    const unseen = await insertPage(ctx.db, previous, 'https://fixed-sample.example.com/b');
    await insertPage(ctx.db, current, 'https://fixed-sample.example.com/a');
    await insertIssue(ctx.db, { scanId: previous, pageId: rechecked, fingerprint: 'fp-a' });
    await insertIssue(ctx.db, { scanId: previous, pageId: unseen, fingerprint: 'fp-b' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/scans/${current}/fixed`,
      headers: { cookie },
    });
    expect(
      res.json<{ items: { fingerprint: string }[] }>().items.map((i) => i.fingerprint),
    ).toEqual(['fp-a']);
  });

  it('is empty when there is nothing to compare with, and 404 for an unknown scan', async () => {
    const only = await insertScan(ctx.db, { hostname: 'fixed-none.example.com' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/scans/${only}/fixed`,
      headers: bearer(reader),
    });
    expect(res.json()).toEqual({ items: [] });

    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/scans/scn_missing/fixed',
      headers: bearer(reader),
    });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('not_found');
  });
});

describe('GET /scans/:id/export.csv', () => {
  it('exports every issue with a header row, escaping and formula protection', async () => {
    const scan = await insertScan(ctx.db, { hostname: 'csv.example.com' });
    const page = await insertPage(ctx.db, scan, 'https://csv.example.com/a');
    await insertIssue(ctx.db, {
      scanId: scan,
      pageId: page,
      fingerprint: 'fp-1',
      message: 'Image "hero" is broken, 404',
    });
    await insertIssue(ctx.db, {
      scanId: scan,
      pageId: null,
      fingerprint: 'fp-2',
      severity: 'warning',
      checkType: 'seo',
      message: '=HYPERLINK("http://evil.example","click")',
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/scans/${scan}/export.csv`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="beacon-csv.example.com-check-1.csv"',
    );
    const lines = res.body.replace(BYTE_ORDER_MARK, '').trimEnd().split('\r\n');
    expect(res.body.startsWith(BYTE_ORDER_MARK)).toBe(true);
    expect(lines[0]).toBe(
      'severity,check,state,page_url,message,resource_url,selector,found_at,ignore_note,fingerprint',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Image ""hero"" is broken, 404"');
    expect(lines[1]).toContain('https://csv.example.com/a');
    // The formula is neutralised, and its quotes are doubled inside a quoted cell.
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
  });

  it('needs authentication', async () => {
    const scan = await insertScan(ctx.db, { hostname: 'csv-auth.example.com' });
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/scans/${scan}/export.csv` });
    expect(res.statusCode).toBe(401);
  });
});

describe('csvLine', () => {
  it('prefixes cells that start like a formula', () => {
    const line = csvLine({
      severity: 'critical',
      checkType: 'links',
      state: 'open',
      pageUrl: null,
      message: '+1 attack',
      resourceUrl: '@cmd',
      selector: '-x',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      ignoreNote: null,
      fingerprint: 'fp',
    });
    expect(line).toBe("critical,links,open,,'+1 attack,'@cmd,'-x,2026-01-01T00:00:00.000Z,,fp");
  });
});

describe('GET /scans/:id/export.pdf', () => {
  it('returns a PDF with a safe file name', async () => {
    const scan = await insertScan(ctx.db, {
      hostname: 'pdf.example.com',
      healthScore: 72,
      pagesTotal: 3,
      criticalCount: 2,
    });
    const pages = [
      await insertPage(ctx.db, scan, 'https://pdf.example.com/'),
      await insertPage(ctx.db, scan, 'https://pdf.example.com/about'),
    ];
    for (const page of pages) {
      await insertIssue(ctx.db, {
        scanId: scan,
        pageId: page,
        fingerprint: 'fp-img',
        message: 'Broken image \u{1F4A5} on the page',
      });
    }
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/scans/${scan}/export.pdf`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="beacon-pdf.example.com-check-1.pdf"',
    );
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(1500);
  });

  it('renders a scan with no issues and a long list of problems', async () => {
    const clean = await insertScan(ctx.db, { hostname: 'pdf-clean.example.com', healthScore: 100 });
    const cleanRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/scans/${clean}/export.pdf`,
      headers: { cookie },
    });
    expect(cleanRes.statusCode).toBe(200);

    const busy = await insertScan(ctx.db, { hostname: 'pdf-busy.example.com', healthScore: 10 });
    const page = await insertPage(ctx.db, busy, 'https://pdf-busy.example.com/');
    for (let index = 0; index < 130; index += 1) {
      await insertIssue(ctx.db, {
        scanId: busy,
        pageId: page,
        fingerprint: `fp-${index}`,
        severity: index % 2 === 0 ? 'critical' : 'warning',
        message: `Problem number ${index} that goes on for a while so that it has to wrap onto a second line in the PDF layout`,
      });
    }
    const busyRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/scans/${busy}/export.pdf`,
      headers: { cookie },
    });
    expect(busyRes.statusCode).toBe(200);
    expect(busyRes.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // More than one page of problems.
    expect(busyRes.rawPayload.toString('latin1')).toMatch(/\/Type \/Page\b/);
  });

  it('answers 404 for an unknown scan', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/scans/scn_missing/export.pdf',
      headers: bearer(reader),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('pdfSafe', () => {
  it('keeps Latin text and replaces what the built-in fonts cannot draw', () => {
    expect(pdfSafe('Café – “quoted”')).toBe('Café – “quoted”');
    expect(pdfSafe('Boom \u{1F4A5} 中')).toBe('Boom ? ?');
    expect(pdfSafe('a\nb\tc')).toBe('a b c');
  });
});

/** Reads a server-sent event stream until `stop` says so, and returns what arrived. */
async function readEvents(
  response: Response,
  stop: (events: { event: string; data: unknown }[]) => boolean,
): Promise<{ event: string; data: unknown }[]> {
  const events: { event: string; data: unknown }[] = [];
  const reader = response.body?.getReader();
  if (!reader) throw new Error('no body');
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = (await reader.read()) as { value?: Uint8Array; done: boolean };
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) as unknown });
      end = buffer.indexOf('\n\n');
    }
    if (stop(events)) break;
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

describe('GET /scans/:id/events', () => {
  it('streams progress, new issues and a final done event', async () => {
    const scan = await insertScan(ctx.db, {
      hostname: 'events.example.com',
      status: 'running',
      pagesTotal: 4,
    });
    const page = await insertPage(ctx.db, scan, 'https://events.example.com/');
    // Found before the stream opened: the page loads these itself, so they are not replayed.
    await insertIssue(ctx.db, { scanId: scan, pageId: page, fingerprint: 'fp-before' });

    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${address}/api/v1/scans/${scan}/events`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    // Finish the scan a moment after the stream opens.
    setTimeout(() => {
      void (async () => {
        await insertIssue(ctx.db, {
          scanId: scan,
          pageId: page,
          fingerprint: 'fp-during',
          message: 'Found while streaming',
        });
        await ctx.db.scan.update({
          where: { id: scan },
          data: { status: 'completed', finishedAt: new Date(), healthScore: 88, criticalCount: 2 },
        });
      })();
    }, 300);

    const events = await readEvents(response, (seen) => seen.some((e) => e.event === 'done'));
    const names = events.map((event) => event.event);
    expect(names[0]).toBe('progress');
    expect(names).toContain('issue');
    expect(names.at(-1)).toBe('done');

    const issues = events.filter((event) => event.event === 'issue');
    expect(issues).toHaveLength(1);
    expect((issues[0]?.data as { message: string }).message).toBe('Found while streaming');

    const done = events.at(-1)?.data as {
      status: string;
      summary: { healthScore: number; critical: number };
    };
    expect(done.status).toBe('completed');
    expect(done.summary).toMatchObject({ healthScore: 88, critical: 2 });
  }, 30_000);

  it('sends done straight away for a scan that already finished', async () => {
    const scan = await insertScan(ctx.db, { hostname: 'events-done.example.com', healthScore: 90 });
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/scans/${scan}/events`, {
      headers: bearer(reader),
    });
    const events = await readEvents(response, (seen) => seen.some((e) => e.event === 'done'));
    expect(events.map((event) => event.event)).toEqual(['progress', 'done']);
  });

  it('answers 404 and 401 as normal JSON before any stream starts', async () => {
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/scans/scn_missing/events',
      headers: bearer(reader),
    });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('not_found');

    const scan = await insertScan(ctx.db, { hostname: 'events-auth.example.com' });
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/scans/${scan}/events`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
