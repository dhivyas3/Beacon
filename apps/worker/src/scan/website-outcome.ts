import type { Db } from '@beacon/db';
import type { Logger } from '../logger.js';

export type ScanOutcome = { status: 'completed' } | { status: 'failed'; message: string };

/**
 * Keeps a website's "last check" in step with its scans. A check that finishes, well or badly,
 * updates when the website was last checked. A failed check leaves its message on the website, so
 * an unreachable site is visible without opening the scan, and the next check that completes
 * clears it. Scans of no website, and cancelled scans, change nothing.
 */
export async function recordWebsiteOutcome(
  db: Db,
  log: Logger,
  scan: { id: string; websiteId: string | null },
  outcome: ScanOutcome,
): Promise<void> {
  if (scan.websiteId === null) return;
  try {
    await db.website.updateMany({
      where: { id: scan.websiteId },
      data: {
        lastCheckAt: new Date(),
        lastRunError: outcome.status === 'failed' ? outcome.message : null,
      },
    });
  } catch (error) {
    // Bookkeeping must never turn a finished scan into a failure.
    log.warn({ err: error, websiteId: scan.websiteId }, 'could not record the website outcome');
  }
}
