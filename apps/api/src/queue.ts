import { QUEUES, type ScanJobData } from '@beacon/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/** Producer side of the scan queue. The worker consumes it. */
export interface ScanQueue {
  enqueue(scanId: string): Promise<void>;
  /** Removes a job that has not started. A running job stops when it sees the scan cancelled. */
  remove(scanId: string): Promise<void>;
  close(): Promise<void>;
}

export class BullScanQueue implements ScanQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<ScanJobData>;

  constructor(redisUrl: string, prefix: string, onError: (error: Error) => void = () => undefined) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<ScanJobData>(QUEUES.scan, {
      connection: this.connection,
      prefix,
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 1 },
    });
    // BullMQ emits 'error' for connection problems. Without a listener Node would crash the process.
    this.queue.on('error', onError);
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

  async close(): Promise<void> {
    // Closing while BullMQ is still running its startup handshake rejects those commands.
    await this.queue.waitUntilReady().catch(() => undefined);
    await this.queue.close();
    this.connection.disconnect();
  }
}
