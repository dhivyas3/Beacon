import { ActiveScanError, createQueuedScan, previousDurationMs, type Db } from '@beacon/db';
import { computeNextCheckAt, isHostAllowed, type CheckType } from '@beacon/shared';
import type { WorkerConfig } from './config.js';
import type { Logger } from './logger.js';

/** How often the worker looks for websites that are due. */
export const SCHEDULER_INTERVAL_MS = 2 * 60 * 1000;
export const SCHEDULER_JOB_NAME = 'schedule-websites';
export const SCHEDULER_SCHEDULER_ID = 'schedule-websites';

/** When a check could not start because the previous one is still running, try again in this long. */
export const RETRY_AFTER_MS = 30 * 60 * 1000;
/** Websites started per tick at most, so one tick stays quick. The rest are picked up next time. */
const BATCH = 50;

export interface SchedulerDeps {
  db: Db;
  config: Pick<WorkerConfig, 'PAGE_CONCURRENCY' | 'LINK_CONCURRENCY'>;
  log: Logger;
  /** Puts a scan on the scan queue. */
  enqueue: (scanId: string) => Promise<void>;
}

export interface TickResult {
  /** Scans created for websites that were due. */
  started: { websiteId: string; scanId: string }[];
  /** Websites that were due but could not start, with why. */
  skipped: { websiteId: string; reason: string }[];
}

/**
 * Starts a check for every active website whose time has come.
 *
 * - Each website is claimed with a compare-and-set on `nextCheckAt`, so when several workers tick
 *   at once, exactly one of them starts it.
 * - The next check is planned from now, not from the missed time. A website that was due for days
 *   because Beacon was down is checked once and then follows its normal cadence, with no backlog.
 * - If the previous check is still running, the website is tried again in {@link RETRY_AFTER_MS}
 *   rather than skipped until its next slot.
 * - A website that cannot be started keeps the reason in `lastRunError`, which the dashboard shows.
 */
export async function runSchedulerTick(
  deps: SchedulerDeps,
  now: Date = new Date(),
): Promise<TickResult> {
  const { db, log } = deps;
  const result: TickResult = { started: [], skipped: [] };

  const due = await db.website.findMany({
    where: { isActive: true, checkFrequency: { not: 'manual' }, nextCheckAt: { lte: now } },
    orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
    take: BATCH,
  });
  if (due.length === 0) return result;

  const allowedEntries = (await db.allowedDomain.findMany({ select: { hostname: true } })).map(
    (entry) => entry.hostname,
  );

  for (const website of due) {
    const next = computeNextCheckAt(website, now);
    const claimed = await db.website.updateMany({
      where: { id: website.id, isActive: true, nextCheckAt: website.nextCheckAt },
      data: { nextCheckAt: next },
    });
    if (claimed.count === 0) continue; // another worker got it, or it was edited meanwhile

    const skip = async (reason: string, retryAt?: Date): Promise<void> => {
      result.skipped.push({ websiteId: website.id, reason });
      log.warn({ websiteId: website.id, reason }, 'scheduled check not started');
      await db.website.update({
        where: { id: website.id },
        data: { lastRunError: reason, ...(retryAt ? { nextCheckAt: retryAt } : {}) },
      });
    };

    if (!isHostAllowed(website.hostname, allowedEntries)) {
      await skip(
        `${website.hostname} is no longer on the allowed domains list, so it was not checked. Add it in Settings.`,
      );
      continue;
    }

    try {
      const scan = await createQueuedScan(db, {
        url: website.url,
        hostname: website.hostname,
        checks: website.enabledChecks as CheckType[],
        formMode: website.formMode,
        triggeredByType: 'scheduled',
        websiteId: website.id,
        pageSelectionMode: website.pageSelectionMode,
        staticPageUrls: website.staticPageUrls,
        pinnedPageUrls: website.pinnedPageUrls,
        sampleSize: website.sampleSize,
        pageConcurrency: deps.config.PAGE_CONCURRENCY,
        linkConcurrency: deps.config.LINK_CONCURRENCY,
        seedDurationMs: await previousDurationMs(db, website.hostname),
      });
      try {
        await deps.enqueue(scan.id);
      } catch (error) {
        await db.scan.update({
          where: { id: scan.id },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            errorMessage: 'The scan could not be queued. Try again in a moment.',
          },
        });
        throw error;
      }
      result.started.push({ websiteId: website.id, scanId: scan.id });
      log.info({ websiteId: website.id, scanId: scan.id }, 'scheduled check started');
    } catch (error) {
      if (error instanceof ActiveScanError) {
        await skip(
          'A check of this website was still running when the next one was due. It will be tried again shortly.',
          new Date(now.getTime() + RETRY_AFTER_MS),
        );
      } else {
        log.error({ err: error, websiteId: website.id }, 'scheduled check failed to start');
        await skip(
          'The check could not be started because of an unexpected error. It will be tried again shortly.',
          new Date(now.getTime() + RETRY_AFTER_MS),
        );
      }
    }
  }
  return result;
}
