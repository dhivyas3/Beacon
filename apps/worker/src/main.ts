import { createDb } from '@qa-hub/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { QUEUES, REAPER_INTERVAL_MS, REAPER_SCHEDULER_ID } from './queues.js';
import { reapStaleScans } from './reaper.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');
  const db = createDb();

  // BullMQ requires maxRetriesPerRequest: null on blocking connections.
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  // One repeating job, shared by every worker instance, marks dead scans as failed.
  const maintenance = new Queue(QUEUES.maintenance, { connection });
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
    { connection, concurrency: 1 },
  );
  maintenanceWorker.on('failed', (job, error) => {
    log.error({ err: error, jobId: job?.id }, 'maintenance job failed');
  });

  log.info({ queues: Object.values(QUEUES) }, 'worker started');

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    await maintenanceWorker.close();
    await maintenance.close();
    connection.disconnect();
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
