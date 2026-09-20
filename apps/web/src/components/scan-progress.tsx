import {
  formatDuration,
  formatEta,
  formatQueuePosition,
  PHASE_LABELS,
  smoothEta,
  type Progress,
  type ScanStatus,
} from '@qa-hub/shared';
import { useEffect, useRef, useState } from 'react';
import { ProgressBar, type ProgressTone } from '@/components/ui/progress-bar';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

/**
 * Smooths the estimated time left (exponential smoothing, alpha 0.3) so the number shown does not
 * jump around as the estimate changes. It restarts whenever there is no estimate.
 */
export function useSmoothedEta(eta: number | null): number | null {
  const previous = useRef<number | null>(null);
  const [smoothed, setSmoothed] = useState<number | null>(eta);
  useEffect(() => {
    const next = smoothEta(previous.current, eta);
    previous.current = next;
    setSmoothed(next);
  }, [eta]);
  return smoothed;
}

interface ScanProgressProps {
  status: ScanStatus;
  progress: Progress;
  /** `row` for the table, `large` for the detail page. */
  size?: 'row' | 'large';
  className?: string;
}

export interface ProgressPresentation {
  /** Short label for the current phase. */
  phase: string;
  /** Text beside the phase, usually the time left. */
  aside: string;
  /** Secondary line under the bar. */
  detail: string;
  indeterminate: boolean;
  tone: ProgressTone;
  showPercent: boolean;
}

/** All the wording rules for progress live here, so they can be tested without rendering. */
export function presentProgress(
  status: ScanStatus,
  progress: Progress,
  smoothedEta: number | null,
): ProgressPresentation {
  const pages = `${formatNumber(progress.pagesDone)} of ${formatNumber(progress.pagesTotal)} pages`;
  switch (status) {
    case 'queued':
      return {
        phase: PHASE_LABELS.queued,
        aside: progress.queuePosition
          ? formatQueuePosition(progress.queuePosition)
          : 'Waiting in queue',
        detail: '',
        indeterminate: false,
        tone: 'muted',
        showPercent: false,
      };
    case 'discovering':
      return {
        phase: 'Discovery',
        aside: '',
        detail: `Discovering pages, ${formatNumber(progress.pagesFound)} found so far`,
        indeterminate: true,
        tone: 'active',
        showPercent: false,
      };
    case 'running': {
      const linkPhase = progress.phase === 'checking_links';
      return {
        phase: PHASE_LABELS[progress.phase],
        aside: progress.estimating || smoothedEta === null ? 'Estimating…' : formatEta(smoothedEta),
        detail: linkPhase
          ? `${formatNumber(progress.linksChecked)} of ${formatNumber(progress.linksTotal)} links`
          : pages,
        indeterminate: false,
        tone: 'active',
        showPercent: true,
      };
    }
    case 'completed':
      return {
        phase: PHASE_LABELS.completed,
        aside: `Completed in ${formatDuration(progress.elapsedSeconds)}`,
        detail: pages,
        indeterminate: false,
        tone: 'success',
        showPercent: true,
      };
    case 'failed':
    case 'cancelled':
      return {
        phase: PHASE_LABELS[status],
        aside: '',
        detail: progress.pagesTotal > 0 ? pages : '',
        indeterminate: false,
        tone: 'muted',
        showPercent: true,
      };
  }
}

/**
 * The progress of a scan: phase, bar, percentage, pages and time left. Follows the display rules:
 * queued shows a muted empty bar and queue position, discovering an indeterminate bar, the first
 * pages "Estimating…", finished scans their real duration, and failed or cancelled scans a frozen
 * muted bar.
 */
export function ScanProgress({ status, progress, size = 'row', className }: ScanProgressProps) {
  const smoothed = useSmoothedEta(status === 'running' ? progress.etaSeconds : null);
  const view = presentProgress(status, progress, smoothed);
  const large = size === 'large';
  const label = `${view.phase}${view.showPercent ? `, ${progress.percent} percent` : ''}`;

  return (
    <div className={cn(large ? 'w-full' : 'min-w-[200px] max-w-[280px]', className)}>
      {large ? null : (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
          <span className={cn('font-medium', view.tone === 'muted' ? 'text-muted' : 'text-fg')}>
            {view.phase}
          </span>
          <span className="tabular text-muted">{view.aside}</span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <ProgressBar
          className="flex-1"
          label={label}
          size={large ? 'lg' : 'sm'}
          value={status === 'queued' ? 0 : progress.percent}
          tone={view.tone}
          indeterminate={view.indeterminate}
        />
        {view.showPercent ? (
          <span
            className={cn(
              'tabular text-right font-medium',
              large ? 'min-w-14 text-2xl' : 'w-9 text-[13px]',
              view.tone === 'muted' ? 'text-muted' : 'text-fg',
            )}
          >
            {progress.percent}%
          </span>
        ) : null}
      </div>
      {large ? (
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[13px] text-muted">
          <span>{view.detail}</span>
          <span className="tabular">{view.aside}</span>
        </div>
      ) : view.detail ? (
        <p className="mt-1 text-xs text-muted">{view.detail}</p>
      ) : null}
    </div>
  );
}
