import { newId, QUEUES, type ScanJobData } from '@qa-hub/shared';
import { Queue, type Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorld,
  insertQueuedScan,
  OFFLINE_BROWSER_ARGS,
  offlineResolver,
  silentLog,
  waitFor,
  type TestWorld,
} from '../test/harness.js';
import { startScanWorker } from './scan-worker.js';

let world: TestWorld;
let connection: Redis;
let queue: Queue<ScanJobData>;
let worker: Worker<ScanJobData> | undefined;
const shutdown = new AbortController();

beforeAll(async () => {
  // One scan at a time, like MAX_CONCURRENT_SCANS=1.
  world = await createWorld({ MAX_CONCURRENT_SCANS: '1' });
  connection = new Redis(world.config.REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue<ScanJobData>(QUEUES.scan, { connection, prefix: world.config.QUEUE_PREFIX });
  await world.db.allowedDomain.create({ data: { id: newId('dom'), hostname: 'localhost' } });
}, 120_000);

afterAll(async () => {
  shutdown.abort();
  await worker?.close();
  await queue.close();
  connection.disconnect();
  await world.close();
});

function startWorker(): Worker<ScanJobData> {
  return startScanWorker({
    db: world.db,
    config: world.config,
    storage: world.storage,
    log: silentLog,
    connection,
    shutdownSignal: shutdown.signal,
    runner: {
      resolver: offlineResolver,
      browserArgs: OFFLINE_BROWSER_ARGS,
      backoff: { maxRetries: 3, baseMs: 5, maxMs: 50 },
      flushMs: 50,
    },
  });
}

const statusOf = async (id: string) =>
  (await world.db.scan.findUniqueOrThrow({ where: { id } })).status;

describe('scan queue worker', () => {
  it('runs one scan at a time, leaves the rest queued, and skips scans cancelled while waiting', async () => {
    const siteUrl = world.sites.site.url;
    const first = await insertQueuedScan(world.db, `${siteUrl}/`, { checks: ['staging-urls'] });
    // Same fixture server through a different hostname, so both scans may be active at once.
    const second = await insertQueuedScan(
      world.db,
      siteUrl.replace('127.0.0.1', 'localhost') + '/',
      {
        checks: ['staging-urls'],
      },
    );
    const third = await insertQueuedScan(world.db, `${siteUrl}/about`, {
      checks: ['staging-urls'],
      hostname: 'third.test',
    });

    for (const id of [first, second, third]) await queue.add('scan', { scanId: id }, { jobId: id });
    await world.db.scan.update({
      where: { id: third },
      data: { status: 'cancelled', finishedAt: new Date() },
    });

    worker = startWorker();

    // While the first scan is in progress the second one has not been started.
    await waitFor(async () => ['discovering', 'running'].includes(await statusOf(first)), {
      label: 'the first scan to start',
    });
    expect(await statusOf(second)).toBe('queued');

    await waitFor(async () => (await statusOf(first)) === 'completed', {
      label: 'the first scan to complete',
      timeoutMs: 120_000,
    });
    await waitFor(async () => (await statusOf(second)) === 'completed', {
      label: 'the second scan to complete',
      timeoutMs: 120_000,
    });

    // The scan cancelled while queued was picked up and skipped.
    await waitFor(
      async () =>
        (await queue.getJob(third)) === undefined || (await queue.getJob(third))?.finishedOn,
      {
        label: 'the cancelled scan job to be processed',
      },
    );
    expect(await statusOf(third)).toBe('cancelled');
    expect(await world.db.scanPage.count({ where: { scanId: third } })).toBe(0);

    const a = await world.db.scan.findUniqueOrThrow({ where: { id: first } });
    const b = await world.db.scan.findUniqueOrThrow({ where: { id: second } });
    // Strictly one after the other: the second started only after the first finished.
    expect(b.startedAt?.getTime()).toBeGreaterThanOrEqual(a.finishedAt?.getTime() ?? Infinity);
  }, 240_000);
});
