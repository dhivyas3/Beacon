import {
  CHECK_LABELS,
  type CheckResult,
  type CheckType,
  type GroupedIssue,
  type ScanDetail,
  type ScanPage,
  type Severity,
} from '@beacon/shared';
import { Check, ChevronDown, FileText, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { IssueFilters, PageFilters } from '@/api/client';
import { useGroupedIssues, useIssues, useScanPages } from '@/api/hooks';
import { HealthScoreFigure } from '@/components/health-score';
import { IssueRow } from '@/components/issues';
import { CheckBadge, ComparisonBadge, SeverityLabel } from '@/components/severity';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import { formatNumber, pathOf, pluralise } from '@/lib/format';

// ---- Summary ------------------------------------------------------------------------------------

function StatCard({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number;
  note?: string;
  tone?: 'critical' | 'warning';
}) {
  return (
    <Card>
      <CardContent>
        <p className="text-[13px] font-medium text-muted">{label}</p>
        <p
          className={cn(
            'mt-2 text-4xl font-semibold leading-none',
            value > 0 && tone === 'critical' && 'text-critical-text',
            value > 0 && tone === 'warning' && 'text-warning-text',
          )}
        >
          {formatNumber(value)}
        </p>
        {note ? <p className="mt-2 text-[13px] text-muted">{note}</p> : null}
      </CardContent>
    </Card>
  );
}

/** Health score, pages scanned, critical and warnings. Counts are of open issues only. */
export function SummaryCards({ scan }: { scan: ScanDetail }) {
  const { summary } = scan;
  const previous = scan.previousScan;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card className="col-span-2 lg:col-span-1">
        <CardContent>
          <p className="mb-2 text-[13px] font-medium text-muted">Health score</p>
          <HealthScoreFigure
            score={summary.healthScore}
            change={previous && summary.healthScore !== null ? scan.scoreChange : undefined}
          />
          {previous ? (
            <p className="mt-2 text-[13px] text-muted">
              Compared with run #{previous.runNumber}
              {scan.fixedIssueCount > 0
                ? ` · ${pluralise(scan.fixedIssueCount, 'issue')} fixed`
                : ''}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <StatCard
        label="Pages scanned"
        value={summary.pages}
        note={`${formatNumber(summary.passed)} without issues`}
      />
      <StatCard
        label="Critical"
        value={summary.critical}
        tone="critical"
        note="Broken things visitors will hit"
      />
      <StatCard
        label="Warnings"
        value={summary.warnings}
        tone="warning"
        note="Worth fixing, less urgent"
      />
    </div>
  );
}

// ---- Issues by check ----------------------------------------------------------------------------

/**
 * One chip per check that ran. It filters the list below, and shows checks that found nothing as
 * passed, which proves they ran.
 */
export function CheckChips({
  results,
  selected,
  onSelect,
}: {
  results: CheckResult[];
  selected: CheckType | undefined;
  onSelect: (check: CheckType | undefined) => void;
}) {
  if (results.length === 0) return null;
  const total = results.reduce((sum, result) => sum + result.issuesFound, 0);
  return (
    <section aria-labelledby="by-check">
      <h2 id="by-check" className="mb-2 text-sm font-semibold text-fg">
        Issues by check
      </h2>
      <div className="flex flex-wrap gap-2">
        <Chip active={selected === undefined} onClick={() => onSelect(undefined)}>
          All checks
          <span className="tabular text-muted">{formatNumber(total)}</span>
        </Chip>
        {results.map((result) => (
          <Chip
            key={result.checkType}
            active={selected === result.checkType}
            onClick={() => onSelect(selected === result.checkType ? undefined : result.checkType)}
          >
            {CHECK_LABELS[result.checkType]}
            {result.issuesFound === 0 ? (
              <span className="inline-flex items-center gap-0.5 text-success-text">
                <Check className="size-3.5" aria-hidden />
                Passed
              </span>
            ) : (
              <span className="tabular text-muted">{formatNumber(result.issuesFound)}</span>
            )}
          </Chip>
        ))}
      </div>
    </section>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors duration-150',
        active
          ? 'border-accent bg-accent-soft text-accent-text'
          : 'border-border-strong bg-surface text-fg hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  );
}

// ---- Lists --------------------------------------------------------------------------------------

function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading issues">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
          <Skeleton className="size-4" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function NoIssues({ filtered, checks }: { filtered: boolean; checks: CheckResult[] }) {
  return (
    <EmptyState
      icon={ShieldCheck}
      title={filtered ? 'No issues match these filters' : 'No issues found'}
      description={
        filtered
          ? 'Try another check or severity, or show ignored issues.'
          : checks.length > 0
            ? `Every check passed: ${checks.map((check) => CHECK_LABELS[check.checkType]).join(', ')}.`
            : 'Nothing to report.'
      }
      className="border-0 py-10"
    />
  );
}

export interface ReportFilters {
  checkType: CheckType | undefined;
  severity: Severity | undefined;
  showIgnored: boolean;
}

function toIssueFilters(filters: ReportFilters): IssueFilters {
  return {
    checkType: filters.checkType,
    severity: filters.severity,
    state: filters.showIgnored ? undefined : 'open',
  };
}

// ---- By issue -----------------------------------------------------------------------------------

function GroupRow({
  group,
  scanId,
  filters,
}: {
  group: GroupedIssue;
  scanId: string;
  filters: ReportFilters;
}) {
  const [open, setOpen] = useState(false);
  const occurrences = useIssues(
    scanId,
    { fingerprint: group.fingerprint, state: filters.showIgnored ? undefined : 'open' },
    open,
    10,
  );
  const items = occurrences.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-2/60"
      >
        <SeverityLabel severity={group.severity} iconOnly className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg">{group.message}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <CheckBadge checkType={group.checkType} />
            <ComparisonBadge comparison={group.comparison} />
            {group.state === 'ignored' ? <Badge>Ignored</Badge> : null}
            {group.sample.resourceUrl ? (
              <span className="min-w-0 max-w-full truncate font-mono text-xs text-subtle">
                {group.sample.resourceUrl}
              </span>
            ) : null}
          </span>
        </span>
        <span className="mt-0.5 flex shrink-0 items-center gap-2 text-[13px] text-muted">
          <span className="tabular">
            affects {formatNumber(group.affectedPages)}{' '}
            {group.affectedPages === 1 ? 'page' : 'pages'}
          </span>
          <ChevronDown
            className={cn(
              'size-4 text-subtle transition-transform duration-150',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </span>
      </button>
      {open ? (
        <div className="border-t border-border bg-surface-2/40">
          {occurrences.isPending ? (
            <ListSkeleton rows={2} />
          ) : occurrences.isError ? (
            <ErrorState
              error={occurrences.error}
              onRetry={() => void occurrences.refetch()}
              className="m-3"
            />
          ) : (
            <>
              <ul>
                {items.map((issue) => (
                  <IssueRow key={issue.id} issue={issue} scanId={scanId} showPage />
                ))}
              </ul>
              {occurrences.hasNextPage ? (
                <div className="p-3 text-center">
                  <Button
                    size="sm"
                    loading={occurrences.isFetchingNextPage}
                    onClick={() => void occurrences.fetchNextPage()}
                  >
                    Show more pages
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function ByIssueView({
  scanId,
  filters,
  active,
  checks,
}: {
  scanId: string;
  filters: ReportFilters;
  active: boolean;
  checks: CheckResult[];
}) {
  const groups = useGroupedIssues(scanId, toIssueFilters(filters), active);
  const items = groups.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(filters.checkType || filters.severity);
  return (
    <Card className="overflow-hidden">
      {groups.isPending ? (
        <ListSkeleton />
      ) : groups.isError ? (
        <ErrorState error={groups.error} onRetry={() => void groups.refetch()} className="m-4" />
      ) : items.length === 0 ? (
        <NoIssues filtered={filtered} checks={checks} />
      ) : (
        <>
          <ul>
            {items.map((group) => (
              <GroupRow key={group.fingerprint} group={group} scanId={scanId} filters={filters} />
            ))}
          </ul>
          {groups.hasNextPage ? (
            <div className="border-t border-border p-3 text-center">
              <Button
                loading={groups.isFetchingNextPage}
                onClick={() => void groups.fetchNextPage()}
              >
                Load more issues
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

// ---- By page ------------------------------------------------------------------------------------

function PageRow({
  page,
  scanId,
  filters,
}: {
  page: ScanPage;
  scanId: string;
  filters: ReportFilters;
}) {
  const [open, setOpen] = useState(false);
  const issues = useIssues(scanId, { pageId: page.id, ...toIssueFilters(filters) }, open, 50);
  const items = issues.data?.pages.flatMap((entry) => entry.items) ?? [];
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-2/60"
      >
        <FileText className="size-4 shrink-0 text-subtle" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[13px] text-fg">{pathOf(page.url)}</span>
          {page.template ? (
            <span className="block truncate font-mono text-xs text-subtle">{page.template}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {page.criticalCount > 0 ? (
            <Badge tone="critical">{formatNumber(page.criticalCount)} critical</Badge>
          ) : null}
          {page.warningCount > 0 ? (
            <Badge tone="warning">{pluralise(page.warningCount, 'warning')}</Badge>
          ) : null}
          <ChevronDown
            className={cn(
              'size-4 text-subtle transition-transform duration-150',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </span>
      </button>
      {open ? (
        <div className="border-t border-border bg-surface-2/40">
          {issues.isPending ? (
            <ListSkeleton rows={2} />
          ) : issues.isError ? (
            <ErrorState
              error={issues.error}
              onRetry={() => void issues.refetch()}
              className="m-3"
            />
          ) : items.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted">
              No issues on this page match the filters.
            </p>
          ) : (
            <ul>
              {items.map((issue) => (
                <IssueRow key={issue.id} issue={issue} scanId={scanId} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

function ByPageView({
  scanId,
  filters,
  active,
  checks,
}: {
  scanId: string;
  filters: ReportFilters;
  active: boolean;
  checks: CheckResult[];
}) {
  const pageFilters: PageFilters = {
    hasIssues: true,
    checkType: filters.checkType,
    severity: filters.severity,
  };
  const pages = useScanPages(scanId, pageFilters, active);
  const items = pages.data?.pages.flatMap((entry) => entry.items) ?? [];
  const filtered = Boolean(filters.checkType || filters.severity);
  return (
    <Card className="overflow-hidden">
      {pages.isPending ? (
        <ListSkeleton />
      ) : pages.isError ? (
        <ErrorState error={pages.error} onRetry={() => void pages.refetch()} className="m-4" />
      ) : items.length === 0 ? (
        <NoIssues filtered={filtered} checks={checks} />
      ) : (
        <>
          <ul>
            {items.map((page) => (
              <PageRow key={page.id} page={page} scanId={scanId} filters={filters} />
            ))}
          </ul>
          {pages.hasNextPage ? (
            <div className="border-t border-border p-3 text-center">
              <Button loading={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                Load more pages
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

export type ReportView = 'page' | 'issue';

/** The list under the chips, either grouped by page or by issue. */
export function IssueList({
  scanId,
  view,
  filters,
  active,
  checks,
}: {
  scanId: string;
  view: ReportView;
  filters: ReportFilters;
  active: boolean;
  checks: CheckResult[];
}) {
  return view === 'issue' ? (
    <ByIssueView scanId={scanId} filters={filters} active={active} checks={checks} />
  ) : (
    <ByPageView scanId={scanId} filters={filters} active={active} checks={checks} />
  );
}

export const VIEW_OPTIONS = [
  { value: 'page' as const, label: 'By page' },
  { value: 'issue' as const, label: 'By issue' },
];
