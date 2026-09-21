import { createDb } from '@beacon/db';
import { LocalStorage } from '@beacon/storage';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { startScanWorker } from './jobs/scan-worker.js';
import { createLogger } from './logger.js';
import { QUEUES, REAPER_INTERVAL_MS, REAPER_SCHEDULER_ID } from './queues.js';
import { reapStaleScans } from './reaper.js';

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

  // One repeating job, shared by every worker instance, marks dead scans as failed.
  const maintenance = new Queue(QUEUES.maintenance, { connection, prefix: config.QUEUE_PREFIX });
  await maintenance.upsertJobScheduler(
    REAPER_SCHEDULER_ID,
    { every: REAPER_INTERVAL_MS },
    { name: 'reap' },
  );
  const maintenanceWorker = new Worker(
    QUEUES.maintenance,
    async () => {
      await reapStaleScans(db, log);
    },
    { connection, prefix: config.QUEUE_PREFIX, concurrency: 1 },
  );
  maintenanceWorker.on('failed', (job, error) => {
    log.error({ err: error, jobId: job?.id }, 'maintenance job failed');
  });

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
