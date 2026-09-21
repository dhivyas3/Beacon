import { isActiveStatus, type ScanDetail, type Severity } from '@beacon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Link2, RotateCw, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiClientError, api } from '@/api/client';
import { useCancelScan, useScan, useScanHistory } from '@/api/hooks';
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
import { StatusBadge } from '@/components/status-badge';
import { Button, buttonVariants } from '@/components/ui/button';
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
import { formatDateTime, relativeTime } from '@/lib/format';
import { useDocumentTitle } from '@/lib/use-document-title';

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
        <Link
          to="/"
          className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted transition-colors hover:text-fg"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Scans
        </Link>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="break-all text-xl font-semibold text-fg">{scan.hostname}</h1>
          <span className="tabular text-sm text-muted">Run #{scan.runNumber}</span>
          <StatusBadge status={scan.status} />
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
          {scan.triggeredBy ? <> by {scan.triggeredBy.name}</> : null}
        </p>
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
            <RescanButton scan={scan} />
          </>
        )}
      </div>
    </div>
  );
}

function ReportBody({ scan }: { scan: ScanDetail }) {
  const [view, setView] = useState<ReportView>('page');
  const [checkType, setCheckType] = useState<ReportFilters['checkType']>(undefined);
  const [severity, setSeverity] = useState<Severity | ''>('');
  const [showIgnored, setShowIgnored] = useState(false);

  const filters: ReportFilters = { checkType, severity: severity || undefined, showIgnored };

  const history = useScanHistory(scan.hostname, scan.status === 'completed');
  const trend = useMemo<TrendPoint[]>(() => {
    const items = history.data?.items ?? [];
    return items
      .filter((item) => item.summary.healthScore !== null)
      .slice(0, 12)
      .reverse()
      .map((item) => ({
        run: item.runNumber,
        score: item.summary.healthScore as number,
        finishedAt: item.finishedAt,
      }));
  }, [history.data]);

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
        <ScoreTrend points={trend} currentRun={scan.runNumber} />
      ) : null}
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
          <Link to="/" className={buttonVariants({ variant: 'primary' })}>
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
