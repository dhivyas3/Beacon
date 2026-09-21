import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUES } from '@beacon/shared';
import type { Logger } from '../logger.js';
import {
  attemptCallback,
  attemptEmail,
  DELIVERY_ATTEMPTS,
  planNotifications,
  retryDelayMs,
  type NotifyDeps,
  type Outcome,
} from './deliveries.js';

export interface NotifierOptions {
  connection: Redis;
  prefix: string;
  log: Logger;
  /** Waits between attempts. Tests shorten it. */
  delayMs?: (attemptsMade: number) => number;
}

export interface Notifier {
  /** Call when a scan reaches a final state. Safe to call more than once for the same scan. */
  notify(scanId: string): Promise<void>;
  /** The deps the workers use, with the queue producers filled in. */
  deps: NotifyDeps;
  close(): Promise<void>;
}

type Producers = Pick<NotifyDeps, 'enqueueEmail' | 'enqueueCallback'>;

/**
 * Starts the three queues behind notifications.
 *
 * - `notifications`: one job per finished scan. It works out what is owed and queues the rest.
 * - `callbacks` and `emails`: one job per delivery, retried by BullMQ with growing waits. The
 *   outcome of every attempt is written to the delivery row, so what happened is in the database.
 *
 * The state that matters lives in the rows, not the jobs: if Redis loses a job, the row still says
 * `pending`, and running the same job again is safe.
 */
export function startNotifier(
  base: Omit<NotifyDeps, keyof Producers>,
  options: NotifierOptions,
): Notifier {
  const { connection, prefix, log } = options;
  const delay = options.delayMs ?? retryDelayMs;
  const queueOptions = { connection, prefix };
  const jobOptions = {
    attempts: DELIVERY_ATTEMPTS,
    backoff: { type: 'custom' as const },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  };

  const notifications = new Queue<{ scanId: string }>(QUEUES.notifications, {
    ...queueOptions,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  });
  const emails = new Queue<{ deliveryId: string }>(QUEUES.emails, queueOptions);
  const callbacks = new Queue<{ deliveryId: string }>(QUEUES.callbacks, queueOptions);
  for (const queue of [notifications, emails, callbacks]) {
    queue.on('error', (error) => log.error({ err: error }, 'notification queue error'));
  }

  const deps: NotifyDeps = {
    ...base,
    enqueueEmail: async (deliveryId) => {
      await emails.add('email', { deliveryId }, { ...jobOptions, jobId: deliveryId });
    },
    enqueueCallback: async (deliveryId) => {
      await callbacks.add('callback', { deliveryId }, { ...jobOptions, jobId: deliveryId });
    },
  };

  /** Runs one attempt, and turns "try again later" into the error BullMQ retries on. */
  const asJob =
    (attempt: (id: string, last: boolean) => Promise<Outcome>) =>
    async (job: {
      data: { deliveryId: string };
      attemptsMade: number;
      opts: { attempts?: number };
    }) => {
      const last = job.attemptsMade + 1 >= (job.opts.attempts ?? DELIVERY_ATTEMPTS);
      const outcome = await attempt(job.data.deliveryId, last);
      if (outcome === 'retry') throw new Error('The delivery did not succeed. It will be retried.');
      if (outcome === 'failed')
        throw new UnrecoverableError('The delivery failed and will not be retried.');
    };

  const workerOptions = {
    ...queueOptions,
    concurrency: 5,
    settings: { backoffStrategy: (attemptsMade: number) => delay(attemptsMade) },
  };
  const notificationWorker = new Worker<{ scanId: string }>(
    QUEUES.notifications,
    async (job) => {
      await planNotifications(deps, job.data.scanId);
    },
    { ...queueOptions, concurrency: 5 },
  );
  const emailWorker = new Worker<{ deliveryId: string }>(
    QUEUES.emails,
    asJob((id, last) => attemptEmail(deps, id, { last })),
    workerOptions,
  );
  const callbackWorker = new Worker<{ deliveryId: string }>(
    QUEUES.callbacks,
    asJob((id, last) => attemptCallback(deps, id, { last })),
    workerOptions,
  );
  for (const [name, worker] of [
    ['notifications', notificationWorker],
    ['emails', emailWorker],
    ['callbacks', callbackWorker],
  ] as const) {
    worker.on('error', (error) =>
      log.error({ err: error, queue: name }, 'notification worker error'),
    );
  }

  return {
    deps,
    async notify(scanId) {
      // One job per scan, however many places say it finished (the runner, the reaper, a cancel).
      await notifications.add('scan-finished', { scanId }, { jobId: `finished-${scanId}` });
    },
    async close() {
      await Promise.all([notificationWorker.close(), emailWorker.close(), callbackWorker.close()]);
      for (const queue of [notifications, emails, callbacks]) {
        await queue.waitUntilReady().catch(() => undefined);
        await queue.close();
      }
    },
  };
}
