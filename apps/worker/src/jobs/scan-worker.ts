import type { Db } from '@beacon/db';
import { QUEUES, type ScanJobData } from '@beacon/shared';
import type { Storage } from '@beacon/storage';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { WorkerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { runScan, type RunnerDeps } from '../scan/runner.js';

export interface ScanWorkerDeps {
  db: Db;
  config: WorkerConfig;
  storage: Storage;
  log: Logger;
  connection: Redis;
  shutdownSignal: AbortSignal;
  runner?: Partial<RunnerDeps>;
}

/**
 * Consumes the scan queue. Concurrency is the global limit on running scans: the rest wait in the
 * queue, and their scans stay `queued` until a slot frees up.
 */
export function startScanWorker(deps: ScanWorkerDeps): Worker<ScanJobData> {
  const worker = new Worker<ScanJobData>(
    QUEUES.scan,
    async (job) => {
      await runScan(
        {
          db: deps.db,
          config: deps.config,
          storage: deps.storage,
          log: deps.log,
          shutdownSignal: deps.shutdownSignal,
          ...deps.runner,
        },
        job.data.scanId,
      );
    },
    {
      connection: deps.connection,
      prefix: deps.config.QUEUE_PREFIX,
      concurrency: deps.config.MAX_CONCURRENT_SCANS,
      // A scan whose worker died is not retried from scratch. The reaper fails it instead.
      maxStalledCount: 0,
      lockDuration: 60_000,
    },
  );
  worker.on('failed', (job, error) => {
    deps.log.error({ err: error, scanId: job?.data.scanId }, 'scan job failed');
  });
  worker.on('error', (error) => deps.log.error({ err: error }, 'scan worker error'));
  return worker;
}
