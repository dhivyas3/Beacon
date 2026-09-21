import type { Scan } from '@beacon/shared';
import { CalendarClock, KeyRound, User, Workflow } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { HealthScorePill } from '@/components/health-score';
import { ScanProgress } from '@/components/scan-progress';
import { StatusBadge } from '@/components/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber, pathOf, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { TRIGGER_LABELS } from '@/lib/website';

const HEAD = 'px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-subtle';
const CELL = 'px-3 py-3 align-middle';

function Count({ value, tone }: { value: number; tone: 'critical' | 'warning' }) {
  if (value === 0) return <span className="tabular text-subtle">0</span>;
  return (
    <span
      className={cn(
        'tabular font-medium',
        tone === 'critical' ? 'text-critical-text' : 'text-warning-text',
      )}
    >
      {formatNumber(value)}
    </span>
  );
}

function TriggeredBy({ scan }: { scan: Scan }) {
  if (!scan.triggeredBy) {
    if (scan.triggeredByType === 'manual_ui' || scan.triggeredByType === 'manual_api') {
      return <span className="text-subtle">—</span>;
    }
    const Icon = scan.triggeredByType === 'scheduled' ? CalendarClock : Workflow;
    return (
      <span className="inline-flex items-center gap-1.5 text-muted">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {TRIGGER_LABELS[scan.triggeredByType]}
      </span>
    );
  }
  const Icon = scan.triggeredBy.type === 'api_key' ? KeyRound : User;
  return (
    <span className="inline-flex max-w-[140px] items-center gap-1.5 text-muted">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{scan.triggeredBy.name}</span>
      <span className="sr-only">
        {scan.triggeredBy.type === 'api_key' ? '(API key)' : '(user)'}
      </span>
    </span>
  );
}

/** Scans as a table. Running rows carry their live progress and time left. */
export function ScansTable({ scans }: { scans: Scan[] }) {
  const navigate = useNavigate();
  return (
    <div className="scroll-x rounded-lg border border-border bg-surface shadow-card">
      <table className="w-full min-w-[860px] border-collapse text-sm">
        <caption className="sr-only">Scans, newest first</caption>
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={HEAD}>
              Site
            </th>
            <th scope="col" className={cn(HEAD, 'hidden xl:table-cell')}>
              Run
            </th>
            <th scope="col" className={HEAD}>
              Status
            </th>
            <th scope="col" className={HEAD}>
              Progress
            </th>
            <th scope="col" className={HEAD}>
              Score
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Critical
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Warnings
            </th>
            <th scope="col" className={cn(HEAD, 'hidden lg:table-cell')}>
              Triggered by
            </th>
            <th scope="col" className={HEAD}>
              Started
            </th>
          </tr>
        </thead>
        <tbody>
          {scans.map((scan) => (
            <tr
              key={scan.id}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('a,button')) return;
                void navigate(`/scans/${scan.id}`);
              }}
              className="cursor-pointer border-b border-border transition-colors duration-150 last:border-b-0 hover:bg-surface-2/60"
            >
              <td className={CELL}>
                <Link
                  to={`/scans/${scan.id}`}
                  className="block max-w-[260px] truncate font-medium text-fg hover:underline"
                >
                  {scan.hostname}
                </Link>
                <span className="block max-w-[260px] truncate font-mono text-xs text-subtle">
                  {pathOf(scan.url)}
                </span>
              </td>
              <td className={cn(CELL, 'hidden text-muted xl:table-cell')}>
                <span className="tabular">#{scan.runNumber}</span>
              </td>
              <td className={CELL}>
                <StatusBadge status={scan.status} />
              </td>
              <td className={CELL}>
                <ScanProgress status={scan.status} progress={scan.progress} />
              </td>
              <td className={CELL}>
                <HealthScorePill score={scan.summary.healthScore} />
              </td>
              <td className={cn(CELL, 'text-right')}>
                <Count value={scan.summary.critical} tone="critical" />
              </td>
              <td className={cn(CELL, 'text-right')}>
                <Count value={scan.summary.warnings} tone="warning" />
              </td>
              <td className={cn(CELL, 'hidden text-[13px] lg:table-cell')}>
                <TriggeredBy scan={scan} />
              </td>
              <td className={cn(CELL, 'whitespace-nowrap text-[13px] text-muted')}>
                <time
                  dateTime={scan.startedAt ?? scan.createdAt}
                  title={scan.startedAt ?? scan.createdAt}
                >
                  {relativeTime(scan.startedAt ?? scan.createdAt)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Same shape as the table, so the page does not jump when the data arrives. */
export function ScansTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="rounded-lg border border-border bg-surface shadow-card"
      aria-busy="true"
      aria-label="Loading scans"
    >
      <div className="border-b border-border px-3 py-2.5">
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-6 border-b border-border px-3 py-4 last:border-b-0"
        >
          <div className="w-48 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="ml-auto h-4 w-32" />
        </div>
      ))}
    </div>
  );
}
