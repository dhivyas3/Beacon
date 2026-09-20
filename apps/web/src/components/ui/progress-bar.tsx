import { cn } from '@/lib/cn';

export type ProgressTone = 'active' | 'success' | 'muted';

interface ProgressBarProps {
  /** 0 to 100. Ignored when `indeterminate`. */
  value: number;
  tone?: ProgressTone;
  /** Unknown amount of work, such as discovery. Shows a moving segment instead of a fill. */
  indeterminate?: boolean;
  label: string;
  size?: 'sm' | 'lg';
  className?: string;
}

const FILL: Record<ProgressTone, string> = {
  active: 'bg-accent',
  success: 'bg-success',
  muted: 'bg-subtle/60',
};

/**
 * Accessible progress bar. The fill animates between values over 300 ms so updates glide rather
 * than jump. A determinate bar exposes `aria-valuenow`, an indeterminate one omits it as ARIA asks.
 */
export function ProgressBar({
  value,
  tone = 'active',
  indeterminate = false,
  label,
  size = 'sm',
  className,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(indeterminate ? { 'aria-busy': true } : { 'aria-valuenow': clamped })}
      className={cn(
        'relative w-full overflow-hidden rounded-full bg-track',
        size === 'lg' ? 'h-2.5' : 'h-1.5',
        className,
      )}
    >
      {indeterminate ? (
        <div className="absolute inset-y-0 left-0 w-1/3 animate-indeterminate rounded-full bg-accent" />
      ) : (
        <div
          className={cn('h-full rounded-full transition-[width] duration-300 ease-out', FILL[tone])}
          style={{ width: `${clamped}%` }}
        />
      )}
    </div>
  );
}
