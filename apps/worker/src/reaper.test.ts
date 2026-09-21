import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@beacon/db';
import { newId } from '@beacon/shared';
import { createIsolatedDatabase, type TestDatabase } from '@beacon/testkit';
import { pino } from 'pino';
import { reapStaleScans, STALE_AFTER_MS } from './reaper.js';

let database: TestDatabase;
let db: Db;
const log = pino({ level: 'silent' });
const now = new Date('2026-09-18T10:00:00.000Z');
let counter = 0;

beforeAll(async () => {
  database = await createIsolatedDatabase();
  db = createDb({ url: database.url, log: false });
});

afterAll(async () => {
  await db.$disconnect();
  await database.drop();
});

async function makeScan(input: {
  status: 'queued' | 'discovering' | 'running' | 'completed';
  heartbeatAgoMs?: number;
}): Promise<string> {
  counter += 1;
  const scan = await db.scan.create({
    data: {
      id: newId('scn'),
      url: `https://site${counter}.test/`,
      hostname: `site${counter}.test`,
      runNumber: 1,
      status: input.status,
      checks: ['images'],
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      startedAt: input.status === 'queued' ? null : new Date(now.getTime() - 30 * 60 * 1000),
      heartbeatAt:
        input.heartbeatAgoMs === undefined ? null : new Date(now.getTime() - input.heartbeatAgoMs),
    },
  });
  return scan.id;
}

describe('reapStaleScans', () => {
  it('fails running and discovering scans with an old heartbeat', async () => {
    const running = await makeScan({ status: 'running', heartbeatAgoMs: STALE_AFTER_MS + 1000 });
    const discovering = await makeScan({
      status: 'discovering',
      heartbeatAgoMs: STALE_AFTER_MS + 60_000,
    });

    const result = await reapStaleScans(db, log, now);

    expect(result.failedScanIds).toEqual(expect.arrayContaining([running, discovering]));
    const row = await db.scan.findUniqueOrThrow({ where: { id: running } });
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toContain('stopped responding');
    expect(row.finishedAt).toEqual(now);
  });

  it('leaves healthy, queued and finished scans alone', async () => {
    const healthy = await makeScan({ status: 'running', heartbeatAgoMs: 30_000 });
    const queued = await makeScan({ status: 'queued' });
    const completed = await makeScan({ status: 'completed', heartbeatAgoMs: 60 * 60 * 1000 });

    const result = await reapStaleScans(db, log, now);

    for (const id of [healthy, queued, completed]) {
      expect(result.failedScanIds).not.toContain(id);
    }
    expect((await db.scan.findUniqueOrThrow({ where: { id: healthy } })).status).toBe('running');
    expect((await db.scan.findUniqueOrThrow({ where: { id: queued } })).status).toBe('queued');
  });

  it('fails a running scan that never sent a heartbeat once it is old enough', async () => {
    const id = await makeScan({ status: 'running' });
    const result = await reapStaleScans(db, log, now);
    expect(result.failedScanIds).toContain(id);
  });

  it('is idempotent', async () => {
    const id = await makeScan({ status: 'running', heartbeatAgoMs: STALE_AFTER_MS * 2 });
    const first = await reapStaleScans(db, log, now);
    const second = await reapStaleScans(db, log, now);
    expect(first.failedScanIds).toContain(id);
    expect(second.failedScanIds).not.toContain(id);
  });
});
