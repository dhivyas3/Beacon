import { QUEUES, type ScanJobData } from '@beacon/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/** Producer side of the scan queue. The worker consumes it. */
export interface ScanQueue {
  enqueue(scanId: string): Promise<void>;
  /** Removes a job that has not started. A running job stops when it sees the scan cancelled. */
  remove(scanId: string): Promise<void>;
  /**
   * Tells the worker a scan reached a final state that the worker did not produce itself, such as
   * a cancellation, so its callback and emails are sent. Announcing a scan twice is harmless.
   */
  notifyFinished(scanId: string): Promise<void>;
  close(): Promise<void>;
}

export class BullScanQueue implements ScanQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<ScanJobData>;
  private readonly notifications: Queue<ScanJobData>;

  constructor(redisUrl: string, prefix: string, onError: (error: Error) => void = () => undefined) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<ScanJobData>(QUEUES.scan, {
      connection: this.connection,
      prefix,
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 1 },
    });
    this.notifications = new Queue<ScanJobData>(QUEUES.notifications, {
      connection: this.connection,
      prefix,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
    // BullMQ emits 'error' for connection problems. Without a listener Node would crash the process.
    this.queue.on('error', onError);
    this.notifications.on('error', onError);
    this.connection.on('error', onError);
  }

  async enqueue(scanId: string): Promise<void> {
    await this.queue.add('scan', { scanId }, { jobId: scanId });
  }

  async remove(scanId: string): Promise<void> {
    try {
      await this.queue.remove(scanId);
    } catch {
      // The job is already active or gone. The worker handles cancellation itself.
    }
  }

  async notifyFinished(scanId: string): Promise<void> {
    // The same job id the worker uses, so a scan announced from two places is handled once.
    await this.notifications.add('scan-finished', { scanId }, { jobId: `finished-${scanId}` });
  }

  async close(): Promise<void> {
    // Closing while BullMQ is still running its startup handshake rejects those commands.
    await this.queue.waitUntilReady().catch(() => undefined);
    await this.notifications.waitUntilReady().catch(() => undefined);
    await this.queue.close();
    await this.notifications.close();
    this.connection.disconnect();
  }
}
