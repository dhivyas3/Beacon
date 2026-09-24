import { createDb } from '@beacon/db';
import { createSafeClient } from '@beacon/net';
import { USER_AGENT } from '@beacon/shared';
import { LocalStorage } from '@beacon/storage';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { startScanWorker } from './jobs/scan-worker.js';
import { createEmailSender, resolveProvider } from './notifications/email-sender.js';
import { startNotifier } from './notifications/notifier.js';
import { chromiumArgs } from './scan/browser.js';
import { SHUTDOWN_FAILURE } from './scan/runner.js';
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

  // Callbacks and emails. Every scan that finishes, by any route, is announced to the notifier.
  const sender = createEmailSender(config, log);
  log.info({ provider: sender.name, configured: resolveProvider(config) }, 'email provider');
  if (sender.name === 'none')
    log.error('Email is misconfigured, so reports cannot be sent. See the EMAIL_* settings.');
  const notifier = startNotifier(
    {
      db,
      config,
      log,
      sender,
      client: createSafeClient({ allowLocal: config.ALLOW_LOCAL_TARGETS, userAgent: USER_AGENT }),
      quietFailureMessage: SHUTDOWN_FAILURE,
    },
    { connection, prefix: config.QUEUE_PREFIX, log },
  );
  const announce = async (scanId: string): Promise<void> => {
    try {
      await notifier.notify(scanId);
    } catch (error) {
      // A notification problem must never turn a finished scan into a failed one.
      log.error({ err: error, scanId }, 'could not announce a finished scan');
    }
  };

  const scanWorker = startScanWorker({
    db,
    config,
    storage,
    log,
    connection,
    shutdownSignal: shutdown.signal,
    runner: {
      onFinished: (scanId) => announce(scanId),
      browserArgs: chromiumArgs(config.CHROMIUM_NO_SANDBOX),
    },
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
      else {
        const { failedScanIds } = await reapStaleScans(db, log);
        for (const scanId of failedScanIds) await announce(scanId);
      }
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
    await notifier.close();
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
