import {
  DEFAULT_LINK_MS,
  ETA_MIN_PAGES,
  FINALISING_SECONDS,
  PROGRESS_WEIGHTS,
  type ScanStage,
  type ScanStatus,
} from './constants.js';
import type { Progress, ProgressPhase } from './schemas/progress.js';

/** Everything `computeProgress` needs. All of it lives on the `Scan` row. */
export interface ProgressInput {
  status: ScanStatus;
  stage: ScanStage | null;
  pagesFound: number;
  pagesTotal: number;
  pagesDone: number;
  linksTotal: number;
  linksChecked: number;
  /** Rolling average of the last 20 page durations, in ms. */
  avgPageMs: number | null;
  /** Rolling average of the last 20 link check durations, in ms. */
  avgLinkMs: number | null;
  pageConcurrency: number;
  linkConcurrency: number;
  /** Duration of the previous completed scan of this hostname, in ms. */
  seedDurationMs: number | null;
  /** Last percentage stored on the scan. The result is never lower than this. */
  progressPercent: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** 1-based queue position, only meaningful while queued. */
  queuePosition: number | null;
}

function ratio(done: number, total: number): number {
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, done / total));
}

function phaseOf(input: ProgressInput): ProgressPhase {
  if (input.status !== 'running') return input.status;
  if (input.stage === 'links') return 'checking_links';
  if (input.stage === 'finalising') return 'finalising';
  return 'running';
}

function rawPercent(input: ProgressInput): number {
  const { discoveryEnd, pagesEnd, linksEnd } = PROGRESS_WEIGHTS;
  switch (input.status) {
    case 'queued':
    case 'discovering':
      return 0;
    case 'completed':
      return 100;
    case 'failed':
    case 'cancelled':
      return input.progressPercent;
    case 'running': {
      if (input.stage === 'finalising') return linksEnd;
      if (input.stage === 'links') {
        return pagesEnd + (linksEnd - pagesEnd) * ratio(input.linksChecked, input.linksTotal);
      }
      return discoveryEnd + (pagesEnd - discoveryEnd) * ratio(input.pagesDone, input.pagesTotal);
    }
  }
}

function elapsedSecondsOf(input: ProgressInput, now: Date): number {
  if (input.startedAt === null) return 0;
  const end = input.finishedAt ?? now;
  return Math.max(0, Math.round((end.getTime() - input.startedAt.getTime()) / 1000));
}

function pagesPerMinuteOf(input: ProgressInput, elapsedSeconds: number): number {
  if (input.avgPageMs !== null && input.avgPageMs > 0) {
    return Math.round((60_000 / input.avgPageMs) * Math.max(1, input.pageConcurrency));
  }
  if (elapsedSeconds > 0 && input.pagesDone > 0) {
    return Math.round(input.pagesDone / (elapsedSeconds / 60));
  }
  return 0;
}

function linkSecondsRemaining(input: ProgressInput): number {
  const remaining = Math.max(0, input.linksTotal - input.linksChecked);
  const perLink =
    input.avgLinkMs !== null && input.avgLinkMs > 0 ? input.avgLinkMs : DEFAULT_LINK_MS;
  return (remaining * perLink) / Math.max(1, input.linkConcurrency) / 1000;
}

interface EtaResult {
  seconds: number | null;
  estimating: boolean;
}

function etaOf(input: ProgressInput, percent: number): EtaResult {
  if (input.status !== 'running') return { seconds: null, estimating: false };

  if (input.stage === 'finalising') return { seconds: FINALISING_SECONDS, estimating: false };
  if (input.stage === 'links') {
    return {
      seconds: Math.round(linkSecondsRemaining(input) + FINALISING_SECONDS),
      estimating: false,
    };
  }

  const warmup = Math.min(ETA_MIN_PAGES, Math.max(1, input.pagesTotal));
  if (input.pagesDone < warmup || input.avgPageMs === null) {
    if (input.seedDurationMs !== null && input.seedDurationMs > 0) {
      const seeded = (input.seedDurationMs / 1000) * (1 - percent / 100);
      return { seconds: Math.max(FINALISING_SECONDS, Math.round(seeded)), estimating: false };
    }
    return { seconds: null, estimating: true };
  }

  const remainingPages = Math.max(0, input.pagesTotal - input.pagesDone);
  const pageSeconds =
    (remainingPages * input.avgPageMs) / Math.max(1, input.pageConcurrency) / 1000;
  const total = pageSeconds + linkSecondsRemaining(input) + FINALISING_SECONDS;
  return { seconds: Math.round(total), estimating: false };
}

/**
 * Computes the `progress` object exposed by the API, the SSE stream and the dashboard.
 *
 * This is the only place progress is derived. Percent is weighted across phases (discovery 0-5,
 * pages 5-85, links 85-98, finalising 98-100), never lower than the value stored on the scan, and
 * reaches 100 only when the scan has completed.
 */
export function computeProgress(input: ProgressInput, now: Date = new Date()): Progress {
  const raw = Math.round(rawPercent(input));
  const percent =
    input.status === 'completed' ? 100 : Math.min(99, Math.max(raw, input.progressPercent));

  const elapsedSeconds = elapsedSecondsOf(input, now);
  const eta = etaOf(input, percent);

  return {
    phase: phaseOf(input),
    percent,
    pagesFound: Math.max(input.pagesFound, input.pagesTotal),
    pagesDone: input.pagesDone,
    pagesTotal: input.pagesTotal,
    linksChecked: input.linksChecked,
    linksTotal: input.linksTotal,
    pagesPerMinute: pagesPerMinuteOf(input, elapsedSeconds),
    elapsedSeconds,
    etaSeconds: eta.seconds,
    estimating: eta.estimating,
    estimatedFinishAt:
      eta.seconds === null ? null : new Date(now.getTime() + eta.seconds * 1000).toISOString(),
    queuePosition: input.status === 'queued' ? input.queuePosition : null,
  };
}

/** Adds a sample to a rolling window and returns the new window (max `size` entries). */
export function pushRolling(window: readonly number[], sample: number, size = 20): number[] {
  const next = [...window, sample];
  return next.length > size ? next.slice(next.length - size) : next;
}

export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Exponential smoothing so a displayed ETA does not jump around. */
export function smoothEta(
  previous: number | null,
  next: number | null,
  alpha = 0.3,
): number | null {
  if (next === null) return null;
  if (previous === null) return next;
  return Math.round(alpha * next + (1 - alpha) * previous);
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return 'less than a minute left';
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `about ${totalMinutes} min left`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `about ${hours} hr left` : `about ${hours} hr ${minutes} min left`;
}

/** Exact duration for finished scans, for example "4 min 12 s". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
  return secs === 0 ? `${minutes} min` : `${minutes} min ${secs} s`;
}

export function formatOrdinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function formatQueuePosition(position: number): string {
  return `${formatOrdinal(position)} in queue`;
}

/** One-line human summary of a progress object, used for dashboard rows and tab titles. */
export function describeProgress(progress: Progress): string {
  switch (progress.phase) {
    case 'queued':
      return progress.queuePosition === null
        ? 'Waiting in queue'
        : formatQueuePosition(progress.queuePosition);
    case 'discovering':
      return `Discovering pages, ${progress.pagesFound} found so far`;
    case 'completed':
      return `Completed in ${formatDuration(progress.elapsedSeconds)}`;
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      if (progress.estimating || progress.etaSeconds === null) return 'Estimating…';
      return formatEta(progress.etaSeconds);
  }
}
