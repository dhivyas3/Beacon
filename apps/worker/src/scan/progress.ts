import type { Db } from '@beacon/db';
import {
  average,
  computeProgress,
  pushRolling,
  ROLLING_WINDOW,
  type Progress,
  type ScanStage,
} from '@beacon/shared';
import type { Logger } from '../logger.js';

export interface ProgressConfig {
  pageConcurrency: number;
  linkConcurrency: number;
  seedDurationMs: number | null;
  createdAt: Date;
  startedAt: Date;
}

export interface ProgressOptions {
  /** How often counters are written to the scan row. The spec allows at most every 2 seconds. */
  flushMs?: number;
  /** Called with the fresh progress after every write, for live streaming. */
  publish?: (progress: Progress) => void;
  /** Called once when the scan row is no longer active, meaning it was cancelled or failed. */
  onLost: () => void;
}

/**
 * Keeps the counters of a running scan and writes them to the `Scan` row on a timer.
 *
 * Each write also refreshes `heartbeatAt`, which the reaper uses to spot dead scans, and notices
 * when the row is no longer `discovering` or `running`. That is how a cancel reaches a worker
 * that is in the middle of a page.
 */
export class ProgressTracker {
  status: 'discovering' | 'running' = 'discovering';
  stage: ScanStage | null = null;
  pagesFound = 0;
  pagesTotal = 0;
  pagesDone = 0;
  linksTotal = 0;
  linksChecked = 0;
  critical = 0;
  warnings = 0;

  private pageMs: number[] = [];
  private linkMs: number[] = [];
  private lastPercent = 0;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private lost = false;

  constructor(
    private readonly db: Db,
    private readonly scanId: string,
    private readonly config: ProgressConfig,
    private readonly log: Logger,
    private readonly options: ProgressOptions,
  ) {}

  start(): void {
    const every = this.options.flushMs ?? 2000;
    this.timer = setInterval(() => void this.flush(), every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  pageDone(durationMs: number): void {
    this.pagesDone += 1;
    this.pageMs = pushRolling(this.pageMs, durationMs, ROLLING_WINDOW);
  }

  linkChecked(durationMs: number): void {
    this.linksChecked += 1;
    this.linkMs = pushRolling(this.linkMs, durationMs, ROLLING_WINDOW);
  }

  addIssues(critical: number, warnings: number): void {
    this.critical += critical;
    this.warnings += warnings;
  }

  /** Current progress as the API would report it. */
  snapshot(now = new Date()): Progress {
    return computeProgress(
      {
        status: this.status,
        stage: this.stage,
        pagesFound: this.pagesFound,
        pagesTotal: this.pagesTotal,
        pagesDone: this.pagesDone,
        linksTotal: this.linksTotal,
        linksChecked: this.linksChecked,
        avgPageMs: average(this.pageMs),
        avgLinkMs: average(this.linkMs),
        pageConcurrency: this.config.pageConcurrency,
        linkConcurrency: this.config.linkConcurrency,
        seedDurationMs: this.config.seedDurationMs,
        progressPercent: this.lastPercent,
        createdAt: this.config.createdAt,
        startedAt: this.config.startedAt,
        finishedAt: null,
        queuePosition: null,
      },
      now,
    );
  }

  /** Writes the counters now. Writes are serialised, so a slow database never overlaps itself. */
  flush(): Promise<void> {
    this.chain = this.chain
      .then(() => this.write())
      .catch((error: unknown) => {
        this.log.warn({ err: error }, 'could not write scan progress');
      });
    return this.chain;
  }

  private async write(): Promise<void> {
    if (this.lost) return;
    const progress = this.snapshot();
    // Percent never moves backwards, whatever the counters do.
    this.lastPercent = Math.max(this.lastPercent, progress.percent);

    const result = await this.db.scan.updateMany({
      where: { id: this.scanId, status: { in: ['discovering', 'running'] } },
      data: {
        pagesFound: this.pagesFound,
        pagesTotal: this.pagesTotal,
        pagesDone: this.pagesDone,
        linksTotal: this.linksTotal,
        linksChecked: this.linksChecked,
        criticalCount: this.critical,
        warningCount: this.warnings,
        avgPageMs: average(this.pageMs),
        avgLinkMs: average(this.linkMs),
        progressPercent: this.lastPercent,
        stage: this.stage,
        heartbeatAt: new Date(),
      },
    });
    if (result.count === 0) {
      this.lost = true;
      this.options.onLost();
      return;
    }
    this.options.publish?.({ ...progress, percent: this.lastPercent });
  }
}
