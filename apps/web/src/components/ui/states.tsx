import { AlertCircle, AlertTriangle, CheckCircle2, Info, RotateCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiClientError } from '@/api/client';
import { cn } from '@/lib/cn';
import { Button } from './button';

/** What to say when a request failed: what happened and what to do next. */
export function describeError(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Try again.';
}

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon = Info,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-6 py-12 text-center',
        className,
      )}
    >
      <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Icon className="size-5" aria-hidden />
      </div>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  error,
  title = 'Something went wrong',
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-critical/30 bg-critical-soft px-6 py-10 text-center',
        className,
      )}
    >
      <AlertCircle className="mb-2 size-6 text-critical" aria-hidden />
      <h3 className="text-sm font-semibold text-critical-text">{title}</h3>
      <p className="mt-1 max-w-md text-[13px] text-muted">{describeError(error)}</p>
      {onRetry ? (
        <Button className="mt-4" size="sm" onClick={onRetry}>
          <RotateCw className="size-3.5" aria-hidden />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

const ALERT_STYLES = {
  info: { icon: Info, box: 'border-accent/30 bg-accent-soft', text: 'text-accent-text' },
  warning: {
    icon: AlertTriangle,
    box: 'border-warning/40 bg-warning-soft',
    text: 'text-warning-text',
  },
  critical: {
    icon: AlertCircle,
    box: 'border-critical/30 bg-critical-soft',
    text: 'text-critical-text',
  },
  success: {
    icon: CheckCircle2,
    box: 'border-success/30 bg-success-soft',
    text: 'text-success-text',
  },
} as const;

/** An inline notice. Always an icon plus text, so meaning never relies on colour alone. */
export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof ALERT_STYLES;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const style = ALERT_STYLES[tone];
  const Icon = style.icon;
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-lg border px-4 py-3', style.box, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', style.text)} aria-hidden />
      <div className="min-w-0 flex-1 text-[13px]">
        {title ? <p className={cn('font-semibold', style.text)}>{title}</p> : null}
        {children ? <div className="text-muted">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}
