import { createDb } from '@beacon/db';
import { LocalStorage } from '@beacon/storage';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { startScanWorker } from './jobs/scan-worker.js';
import { createLogger } from './logger.js';
import type { ScanJobData } from '@beacon/shared';
import { QUEUES, REAPER_INTERVAL_MS, REAPER_SCHEDULER_ID } from './queues.js';
import { reapStaleScans } from './reaper.js';
import {
  runSchedulerTick,
  SCHEDULER_INTERVAL_MS,
  SCHEDULER_JOB_NAME,
  SCHEDULER_SCHEDULER_ID,
} from './scheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');
  const db = createDb();
  const storage = new LocalStorage(config.STORAGE_DIR);

  // BullMQ requires maxRetriesPerRequest: null on blocking connections.
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const shutdown = new AbortController();

  const scanWorker = startScanWorker({
    db,
    config,
    storage,
    log,
    connection,
    shutdownSignal: shutdown.signal,
  });

  // The scheduler starts scans itself, so it needs the producer side of the scan queue too.
  const scanQueue = new Queue<ScanJobData>(QUEUES.scan, {
    connection,
    prefix: config.QUEUE_PREFIX,
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 1 },
  });
  scanQueue.on('error', (error) => log.error({ err: error }, 'scan queue error'));
  const scheduler = {
    db,
    config,
    log,
    enqueue: async (scanId: string): Promise<void> => {
      await scanQueue.add('scan', { scanId }, { jobId: scanId });
    },
  };

  // Two repeating jobs, each shared by every worker instance: one marks dead scans as failed, the
  // other starts the checks of websites that are due.
  const maintenance = new Queue(QUEUES.maintenance, { connection, prefix: config.QUEUE_PREFIX });
  await maintenance.upsertJobScheduler(
    REAPER_SCHEDULER_ID,
    { every: REAPER_INTERVAL_MS },
    { name: 'reap' },
  );
  await maintenance.upsertJobScheduler(
    SCHEDULER_SCHEDULER_ID,
    { every: SCHEDULER_INTERVAL_MS },
    { name: SCHEDULER_JOB_NAME },
  );
  const maintenanceWorker = new Worker(
    QUEUES.maintenance,
    async (job) => {
      if (job.name === SCHEDULER_JOB_NAME) await runSchedulerTick(scheduler);
      else await reapStaleScans(db, log);
    },
    { connection, prefix: config.QUEUE_PREFIX, concurrency: 1 },
  );
  maintenanceWorker.on('failed', (job, error) => {
    log.error({ err: error, jobId: job?.id }, 'maintenance job failed');
  });

  // Catch up on anything that came due while Beacon was down. Each such website is started once and
  // then follows its normal cadence, so downtime does not cause a burst of back-to-back checks.
  runSchedulerTick(scheduler)
    .then((result) => {
      if (result.started.length > 0)
        log.info({ started: result.started.length }, 'caught up on due websites');
    })
    .catch((error: unknown) => log.error({ err: error }, 'startup catch-up failed'));

  log.info(
    { maxConcurrentScans: config.MAX_CONCURRENT_SCANS, maxPages: config.MAX_PAGES },
    'worker started',
  );

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    // Running scans are failed with a clear message instead of being left for the reaper.
    shutdown.abort();
    await scanWorker.close();
    await maintenanceWorker.close();
    await maintenance.close();
    await scanQueue.waitUntilReady().catch(() => undefined);
    await scanQueue.close();
    connection.disconnect();
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
