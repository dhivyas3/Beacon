import type { Db } from '@qa-hub/db';
import type { Logger } from './logger.js';

/** A scan with no heartbeat for this long is considered dead. */
export const STALE_AFTER_MS = 2 * 60 * 1000;

export const STALE_MESSAGE = 'The scan stopped responding (no heartbeat for 2 minutes).';

export interface ReapResult {
  /** Ids of the scans marked failed by this run. */
  failedScanIds: string[];
}

/**
 * Marks scans that are `discovering` or `running` and have not sent a heartbeat for two minutes
 * as `failed`. Queued scans are never touched: they have no heartbeat because they have not
 * started. Safe to run from several workers at once, because each update re-checks the status.
 */
export async function reapStaleScans(
  db: Db,
  log: Logger,
  now: Date = new Date(),
): Promise<ReapResult> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);

  const candidates = await db.scan.findMany({
    where: {
      status: { in: ['discovering', 'running'] },
      OR: [
        { heartbeatAt: { lt: cutoff } },
        { heartbeatAt: null, startedAt: { lt: cutoff } },
        { heartbeatAt: null, startedAt: null, createdAt: { lt: cutoff } },
      ],
    },
    select: { id: true },
  });

  const failedScanIds: string[] = [];
  for (const { id } of candidates) {
    const updated = await db.scan.updateMany({
      where: { id, status: { in: ['discovering', 'running'] } },
      data: { status: 'failed', errorMessage: STALE_MESSAGE, finishedAt: now },
    });
    if (updated.count === 1) {
      failedScanIds.push(id);
      log.warn({ scanId: id }, 'marked stale scan as failed');
    }
  }
  return { failedScanIds };
}
