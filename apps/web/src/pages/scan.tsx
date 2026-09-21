import { CHECK_LABELS, isActiveStatus, type ScanDetail, type Severity } from '@beacon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FileText, Link2, RotateCw, Wrench, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiClientError, api } from '@/api/client';
import {
  useCancelScan,
  useCheckNow,
  useFixedIssues,
  useScan,
  useScanEvents,
  useScanHistory,
  useWebsiteHistory,
} from '@/api/hooks';
import { InProgressView } from '@/components/live-view';
import {
  CheckChips,
  IssueList,
  SummaryCards,
  VIEW_OPTIONS,
  type ReportFilters,
  type ReportView,
} from '@/components/report';
import { ScoreTrend, type TrendPoint } from '@/components/score-trend';
import { SeverityLabel } from '@/components/severity';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, EmptyState, ErrorState } from '@/components/ui/states';
import { Label } from '@/components/ui/input';
import { formatDateTime, pluralise, relativeTime } from '@/lib/format';
import { useDocumentTitle } from '@/lib/use-document-title';
import { TRIGGER_LABELS } from '@/lib/website';

function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading scan">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="grid gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((card) => (
          <Skeleton key={card} className="h-32" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function CancelButton({ scanId }: { scanId: string }) {
  const [open, setOpen] = useState(false);
  const cancel = useCancelScan(scanId);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <XCircle className="size-4" aria-hidden />
          Cancel scan
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Cancel this scan?"
        description="Pages already checked keep their results. The scan stops within a page or two and cannot be resumed."
      >
        <DialogFooter>
          <DialogClose asChild>
            <Button>Keep running</Button>
          </DialogClose>
          <Button
            variant="danger"
            loading={cancel.isPending}
            onClick={() =>
              cancel.mutate(undefined, {
                onSuccess: () => {
                  setOpen(false);
                  toast.success('Scan cancelled');
                },
                onError: (error) => {
                  setOpen(false);
                  toast.error(
                    error instanceof ApiClientError ? error.message : 'Could not cancel the scan.',
                  );
                },
              })
            }
          >
            Cancel scan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CheckAgainButton({ websiteId }: { websiteId: string }) {
  const navigate = useNavigate();
  const checkNow = useCheckNow(websiteId);
  return (
    <Button
      variant="primary"
      loading={checkNow.isPending}
      onClick={() =>
        checkNow.mutate(undefined, {
          onSuccess: (created) => {
            toast.success('Check started');
            void navigate(`/scans/${created.id}`);
          },
          onError: (error) =>
            toast.error(
              error instanceof ApiClientError ? error.message : 'Could not start the check.',
            ),
        })
      }
    >
      <RotateCw className="size-4" aria-hidden />
      Check again
    </Button>
  );
}

function RescanButton({ scan }: { scan: ScanDetail }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const rescan = useMutation({
    mutationFn: () =>
      api.scans.create({ url: scan.url, checks: scan.checks, formMode: scan.formMode }),
    onSuccess: (created) => {
      void client.invalidateQueries({ queryKey: ['scans'] });
      toast.success('Scan started');
      void navigate(`/scans/${created.id}`);
    },
    onError: (error) =>
      toast.error(error instanceof ApiClientError ? error.message : 'Could not start the scan.'),
  });
  return (
    <Button variant="primary" loading={rescan.isPending} onClick={() => rescan.mutate()}>
      <RotateCw className="size-4" aria-hidden />
      Re-scan
    </Button>
  );
}

function Header({ scan }: { scan: ScanDetail }) {
  const active = isActiveStatus(scan.status);
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {scan.website ? (
          <nav
            aria-label="Breadcrumb"
            className="mb-2 flex items-center gap-1 text-[13px] text-muted"
          >
            <Link
              to="/websites"
              className="inline-flex items-center gap-1 transition-colors hover:text-fg"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              Websites
            </Link>
            <span aria-hidden>/</span>
            <Link to={`/websites/${scan.website.id}`} className="transition-colors hover:text-fg">
              {scan.website.name}
            </Link>
            <span aria-hidden>/</span>
            <span aria-current="page">Check #{scan.runNumber}</span>
          </nav>
        ) : (
          <Link
            to="/scans"
            className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted transition-colors hover:text-fg"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Scans
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="break-all text-xl font-semibold text-fg">{scan.hostname}</h1>
          <span className="tabular text-sm text-muted">Run #{scan.runNumber}</span>
          <StatusBadge status={scan.status} />
          {scan.website ? null : <Badge tone="outline">One-off scan</Badge>}
        </div>
        <p className="mt-1 break-all font-mono text-xs text-muted">{scan.url}</p>
        <p className="mt-1 text-[13px] text-muted">
          {scan.startedAt ? (
            <>
              Started{' '}
              <time dateTime={scan.startedAt} title={formatDateTime(scan.startedAt)}>
                {relativeTime(scan.startedAt)}
              </time>
            </>
          ) : (
            'Waiting to start'
          )}
          {scan.triggeredBy ? (
            <> by {scan.triggeredBy.name}</>
          ) : scan.triggeredByType !== 'manual_ui' && scan.triggeredByType !== 'manual_api' ? (
            <> · {TRIGGER_LABELS[scan.triggeredByType]}</>
          ) : null}
        </p>
        {scan.website ? null : (
          <p className="mt-1 text-[13px] text-muted">
            Not part of a website's schedule, so no email report is sent.
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {active ? (
          <CancelButton scanId={scan.id} />
        ) : (
          <>
            <Button
              onClick={() => {
                void navigator.clipboard
                  .writeText(window.location.href)
                  .then(() => toast.success('Link copied'))
                  .catch(() => toast.error('Could not copy the link.'));
              }}
            >
              <Link2 className="size-4" aria-hidden />
              Copy link
            </Button>
            <a
              href={api.scans.csvUrl(scan.id)}
              download
              className={buttonVariants({ variant: 'secondary' })}
            >
              <Download className="size-4" aria-hidden />
              Export CSV
            </a>
            <a
              href={api.scans.pdfUrl(scan.id)}
              download
              className={buttonVariants({ variant: 'secondary' })}
            >
              <FileText className="size-4" aria-hidden />
              Export PDF
            </a>
            {scan.website ? (
              <CheckAgainButton websiteId={scan.website.id} />
            ) : (
              <RescanButton scan={scan} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Problems the previous check had and this one does not. */
function FixedSection({ scan }: { scan: ScanDetail }) {
  const fixed = useFixedIssues(scan.id, scan.fixedIssueCount > 0);
  if (scan.fixedIssueCount === 0) return null;
  const items = fixed.data?.items ?? [];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Fixed since the last check</CardTitle>
          <CardDescription>
            {pluralise(scan.fixedIssueCount, 'problem')} found in run #
            {scan.previousScan?.runNumber ?? '?'} {scan.fixedIssueCount === 1 ? 'is' : 'are'} gone.
            {scan.pageSelectionMode === 'full'
              ? ''
              : ' Only pages checked both times count, because a page that was not looked at again is unseen, not fixed.'}
          </CardDescription>
        </div>
        <Wrench className="size-4 shrink-0 text-subtle" aria-hidden />
      </CardHeader>
      <CardContent className="pt-3 sm:pt-3">
        {fixed.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading fixed problems">
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </div>
        ) : fixed.isError ? (
          <ErrorState
            title="Could not load the fixed problems"
            error={fixed.error}
            onRetry={() => void fixed.refetch()}
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.fingerprint} className="flex items-start gap-3 py-2.5 first:pt-0">
                <SeverityLabel severity={item.severity} iconOnly className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-fg">{item.message}</p>
                  <p className="text-xs text-muted">
                    {CHECK_LABELS[item.checkType]}
                    {item.affectedPages > 0
                      ? ` · was on ${pluralise(item.affectedPages, 'page')}`
                      : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ReportBody({ scan }: { scan: ScanDetail }) {
  const [view, setView] = useState<ReportView>('page');
  const [checkType, setCheckType] = useState<ReportFilters['checkType']>(undefined);
  const [severity, setSeverity] = useState<Severity | ''>('');
  const [showIgnored, setShowIgnored] = useState(false);

  const filters: ReportFilters = { checkType, severity: severity || undefined, showIgnored };

  const completed = scan.status === 'completed';
  const siteHistory = useScanHistory(scan.hostname, completed && !scan.website);
  const websiteHistory = useWebsiteHistory(
    scan.website?.id ?? '',
    completed && scan.website !== null,
  );
  const trend = useMemo<TrendPoint[]>(() => {
    const points = scan.website
      ? (websiteHistory.data?.pages.flatMap((page) => page.items) ?? []).map((item) => ({
          run: item.runNumber,
          score: item.healthScore,
          finishedAt: item.finishedAt,
        }))
      : (siteHistory.data?.items ?? []).map((item) => ({
          run: item.runNumber,
          score: item.summary.healthScore,
          finishedAt: item.finishedAt,
        }));
    return points
      .filter((point): point is TrendPoint => point.score !== null)
      .slice(0, 12)
      .reverse();
  }, [scan.website, siteHistory.data, websiteHistory.data]);

  return (
    <div className="space-y-6">
      {scan.status === 'failed' ? (
        <Alert tone="critical" title="This scan failed">
          {scan.errorMessage ?? 'The scan stopped because of an error.'} Results below are from
          before it stopped.
        </Alert>
      ) : scan.status === 'cancelled' ? (
        <Alert tone="warning" title="This scan was cancelled">
          Results are incomplete: only the pages checked before it stopped are included.
        </Alert>
      ) : null}

      <SummaryCards scan={scan} />
      {scan.status === 'completed' ? (
        <ScoreTrend
          points={trend}
          currentRun={scan.runNumber}
          {...(scan.website
            ? {
                description: `The last ${trend.length} completed checks of ${scan.website.name}.`,
              }
            : {})}
        />
      ) : null}
      <FixedSection scan={scan} />
      <CheckChips results={scan.checkResults} selected={checkType} onSelect={setCheckType} />

      <section aria-label="Issues" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented label="Group issues" value={view} onChange={setView} options={VIEW_OPTIONS} />
          <div className="flex flex-wrap items-center gap-3">
            <Select
              aria-label="Filter by severity"
              value={severity}
              onChange={(event) => setSeverity(event.target.value as Severity | '')}
            >
              <option value="">All severities</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </Select>
            <div className="flex items-center gap-2">
              <Checkbox
                id="show-ignored"
                checked={showIgnored}
                onCheckedChange={(value) => setShowIgnored(value === true)}
              />
              <Label htmlFor="show-ignored">Show ignored</Label>
            </div>
          </div>
        </div>
        <IssueList
          scanId={scan.id}
          view={view}
          filters={filters}
          active={false}
          checks={scan.checkResults}
        />
      </section>
    </div>
  );
}

export function ScanPage() {
  const { id = '' } = useParams();
  const scan = useScan(id);

  // While a scan runs the tab title carries its percentage, so it can be watched from another tab.
  const current = scan.data;
  useScanEvents(id, current ? isActiveStatus(current.status) : false);
  const title = current
    ? isActiveStatus(current.status)
      ? `${current.progress.percent}% · ${current.hostname}`
      : `${current.hostname} · Report`
    : 'Scan · Beacon';
  useDocumentTitle(title);

  if (scan.isPending) return <DetailSkeleton />;

  if (scan.isError) {
    const notFound = scan.error instanceof ApiClientError && scan.error.status === 404;
    return notFound ? (
      <EmptyState
        title="Scan not found"
        description="It may have been removed, or the link may be wrong."
        action={
          <Link to="/scans" className={buttonVariants({ variant: 'primary' })}>
            Go to scans
          </Link>
        }
        className="mt-10"
      />
    ) : (
      <ErrorState
        title="Could not load this scan"
        error={scan.error}
        onRetry={() => void scan.refetch()}
      />
    );
  }

  const data = scan.data;
  const active = isActiveStatus(data.status);
  return (
    <div className="space-y-6">
      <Header scan={data} />
      {active ? <InProgressView scan={data} /> : <ReportBody scan={data} />}
    </div>
  );
}
