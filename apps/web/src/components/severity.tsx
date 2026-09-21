import { CHECK_LABELS, type CheckType, type ComparisonLabel, type Severity } from '@beacon/shared';
import { Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

const SEVERITY = {
  critical: { label: 'Critical', icon: OctagonAlert, text: 'text-critical-text' },
  warning: { label: 'Warning', icon: TriangleAlert, text: 'text-warning-text' },
  info: { label: 'Info', icon: Info, text: 'text-muted' },
} as const;

/** Severity as an icon and a word. The colour reinforces it but is never the only cue. */
export function SeverityLabel({
  severity,
  iconOnly = false,
  className,
}: {
  severity: Severity;
  iconOnly?: boolean;
  className?: string;
}) {
  const { label, icon: Icon, text } = SEVERITY[severity];
  return (
    <span className={cn('inline-flex items-center gap-1 text-[13px] font-medium', text, className)}>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className={iconOnly ? 'sr-only' : undefined}>{label}</span>
    </span>
  );
}

export function CheckBadge({ checkType }: { checkType: CheckType }) {
  return <Badge tone="outline">{CHECK_LABELS[checkType]}</Badge>;
}

/** New / still open, relative to the previous completed scan of the same site. */
export function ComparisonBadge({ comparison }: { comparison: ComparisonLabel | null }) {
  if (comparison === null) return null;
  return comparison === 'new' ? (
    <Badge tone="accent">New</Badge>
  ) : (
    <Badge tone="neutral">Still open</Badge>
  );
}
