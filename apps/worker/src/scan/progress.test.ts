import { createDb, type Db } from '@beacon/db';
import { newId, type Progress } from '@beacon/shared';
import { createIsolatedDatabase, type TestDatabase } from '@beacon/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLog, waitFor } from '../test/harness.js';
import { ProgressTracker } from './progress.js';

let database: TestDatabase;
let db: Db;
let counter = 0;

beforeAll(async () => {
  database = await createIsolatedDatabase();
  db = createDb({ url: database.url, log: false });
});

afterAll(async () => {
  await db.$disconnect();
  await database.drop();
});

async function makeScan(status: 'running' | 'discovering' = 'running'): Promise<string> {
  counter += 1;
  const id = newId('scn');
  await db.scan.create({
    data: {
      id,
      url: `https://p${counter}.test/`,
      hostname: `p${counter}.test`,
      runNumber: 1,
      status,
      checks: ['images'],
      startedAt: new Date(Date.now() - 60_000),
    },
  });
  return id;
}

function tracker(scanId: string, onLost: () => void, publish?: (p: Progress) => void) {
  return new ProgressTracker(
    db,
    scanId,
    {
      pageConcurrency: 5,
      linkConcurrency: 10,
      seedDurationMs: null,
      createdAt: new Date(Date.now() - 90_000),
      startedAt: new Date(Date.now() - 60_000),
    },
    silentLog,
    { flushMs: 20, onLost, ...(publish ? { publish } : {}) },
  );
}

describe('ProgressTracker', () => {
  it('writes counters, rolling averages, percent and a heartbeat', async () => {
    const id = await makeScan();
    const t = tracker(id, () => undefined);
    t.status = 'running';
    t.stage = 'pages';
    t.pagesTotal = 10;
    t.pagesFound = 10;
    for (const ms of [1000, 2000, 3000]) t.pageDone(ms);
    t.addIssues(2, 5);
    await t.flush();

    const row = await db.scan.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      pagesDone: 3,
      pagesTotal: 10,
      criticalCount: 2,
      warningCount: 5,
      avgPageMs: 2000,
      stage: 'pages',
    });
    // 5 + 80 * 3/10
    expect(row.progressPercent).toBe(29);
    expect(row.heartbeatAt).not.toBeNull();
  });

  it('keeps only the last 20 page durations in the rolling average', async () => {
    const id = await makeScan();
    const t = tracker(id, () => undefined);
    t.status = 'running';
    t.stage = 'pages';
    t.pagesTotal = 100;
    for (let i = 0; i < 20; i++) t.pageDone(10_000); // old, slow pages
    for (let i = 0; i < 20; i++) t.pageDone(1000); // the site sped up
    await t.flush();
    expect((await db.scan.findUniqueOrThrow({ where: { id } })).avgPageMs).toBe(1000);
  });

  it('never lets the stored percent move backwards', async () => {
    const id = await makeScan();
    const t = tracker(id, () => undefined);
    t.status = 'running';
    t.stage = 'links';
    t.linksTotal = 10;
    t.pagesTotal = 5;
    for (let i = 0; i < 5; i++) t.pageDone(100);
    for (let i = 0; i < 8; i++) t.linkChecked(50);
    await t.flush();
    const high = (await db.scan.findUniqueOrThrow({ where: { id } })).progressPercent;
    expect(high).toBeGreaterThan(90);

    // The link total grows as late pages add links. The bar must not drop.
    t.linksTotal = 400;
    await t.flush();
    expect((await db.scan.findUniqueOrThrow({ where: { id } })).progressPercent).toBe(high);
  });

  it('publishes each write and reports the same percent that is stored', async () => {
    const id = await makeScan();
    const seen: Progress[] = [];
    const t = tracker(
      id,
      () => undefined,
      (p) => seen.push(p),
    );
    t.status = 'running';
    t.stage = 'pages';
    t.pagesTotal = 4;
    t.pageDone(500);
    await t.flush();
    t.pageDone(500);
    await t.flush();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.pagesDone).toBe(2);
    const stored = await db.scan.findUniqueOrThrow({ where: { id } });
    expect(seen[1]?.percent).toBe(stored.progressPercent);
  });

  it('notices when the scan is cancelled and stops writing', async () => {
    const id = await makeScan();
    let lost = 0;
    const t = tracker(id, () => (lost += 1));
    t.start();
    t.status = 'running';
    t.pagesTotal = 10;

    await db.scan.update({ where: { id }, data: { status: 'cancelled', finishedAt: new Date() } });
    await waitFor(async () => lost > 0, { label: 'cancellation to be noticed', timeoutMs: 5000 });
    t.stop();

    t.pageDone(100);
    await t.flush();
    expect(lost).toBe(1);
    const row = await db.scan.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('cancelled');
    expect(row.pagesDone).toBe(0); // nothing overwrote the cancelled scan
  });

  it('writes on its own timer and stops when told to', async () => {
    const id = await makeScan();
    const t = tracker(id, () => undefined);
    t.start();
    t.status = 'running';
    t.stage = 'pages';
    t.pagesTotal = 3;
    t.pageDone(100);
    await waitFor(
      async () => (await db.scan.findUniqueOrThrow({ where: { id } })).pagesDone === 1,
      { label: 'the timer to write', timeoutMs: 5000 },
    );
    t.stop();
    // A write that was already queued when stop() was called may still land. Let it finish first.
    await t.flush();
    const beat = (await db.scan.findUniqueOrThrow({ where: { id } })).heartbeatAt?.getTime();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await db.scan.findUniqueOrThrow({ where: { id } })).heartbeatAt?.getTime()).toBe(beat);
  });
});
