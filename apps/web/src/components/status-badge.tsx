import type { ScanStatus } from '@qa-hub/shared';
import { Ban, CheckCircle2, Clock, Loader2, Radar, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';

const STATUS: Record<
  ScanStatus,
  { label: string; icon: LucideIcon; tone: NonNullable<BadgeProps['tone']>; spin?: boolean }
> = {
  queued: { label: 'Queued', icon: Clock, tone: 'neutral' },
  discovering: { label: 'Discovering', icon: Radar, tone: 'accent' },
  running: { label: 'Running', icon: Loader2, tone: 'accent', spin: true },
  completed: { label: 'Completed', icon: CheckCircle2, tone: 'success' },
  failed: { label: 'Failed', icon: XCircle, tone: 'critical' },
  cancelled: { label: 'Cancelled', icon: Ban, tone: 'neutral' },
};

/** Status as an icon and a word, so it never depends on colour alone. */
export function StatusBadge({ status }: { status: ScanStatus }) {
  const { label, icon: Icon, tone, spin } = STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon className={spin ? 'size-3 animate-spin' : 'size-3'} aria-hidden />
      {label}
    </Badge>
  );
}
