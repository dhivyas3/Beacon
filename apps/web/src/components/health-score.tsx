import { HEALTH_SCORE_DESCRIPTION, healthBand, type HealthBand } from '@qa-hub/shared';
import { CheckCircle2, CircleHelp, TriangleAlert, XCircle } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

const BAND: Record<
  HealthBand,
  { label: string; text: string; bg: string; icon: typeof CheckCircle2 }
> = {
  good: { label: 'Good', text: 'text-success-text', bg: 'bg-success-soft', icon: CheckCircle2 },
  fair: { label: 'Fair', text: 'text-warning-text', bg: 'bg-warning-soft', icon: TriangleAlert },
  poor: { label: 'Poor', text: 'text-critical-text', bg: 'bg-critical-soft', icon: XCircle },
};

/** Compact score for tables. Explains how it is calculated on hover and focus. */
export function HealthScorePill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-subtle">—</span>;
  const band = BAND[healthBand(score)];
  const Icon = band.icon;
  return (
    <Tooltip content={HEALTH_SCORE_DESCRIPTION}>
      <span
        tabIndex={0}
        className={cn(
          'tabular inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-semibold',
          band.bg,
          band.text,
        )}
        aria-label={`Health score ${score} out of 100, ${band.label}`}
      >
        <Icon className="size-3" aria-hidden />
        {score}
      </span>
    </Tooltip>
  );
}

/** The large figure on the report. One number, a word for it, and the formula on request. */
export function HealthScoreFigure({
  score,
  change,
}: {
  score: number | null;
  change?: number | null;
}) {
  if (score === null) {
    return <p className="text-3xl font-semibold text-subtle">—</p>;
  }
  const band = BAND[healthBand(score)];
  const Icon = band.icon;
  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-4xl font-semibold leading-none text-fg">{score}</span>
        <span className="text-sm text-subtle">/ 100</span>
        <Tooltip content={HEALTH_SCORE_DESCRIPTION}>
          <button
            type="button"
            className="ml-1 rounded-full text-subtle transition-colors hover:text-fg"
            aria-label="How the health score is calculated"
          >
            <CircleHelp className="size-4" aria-hidden />
          </button>
        </Tooltip>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
        <span className={cn('inline-flex items-center gap-1 font-medium', band.text)}>
          <Icon className="size-3.5" aria-hidden />
          {band.label}
        </span>
        {change !== undefined && change !== null && change !== 0 ? (
          <span
            className={cn(
              'tabular font-medium',
              change > 0 ? 'text-success-text' : 'text-critical-text',
            )}
          >
            {change > 0 ? '+' : '−'}
            {Math.abs(change)} since last scan
          </span>
        ) : change === 0 ? (
          <span className="text-muted">No change since last scan</span>
        ) : null}
      </div>
    </div>
  );
}
