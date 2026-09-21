import { CHECK_LABELS, type Website } from '@beacon/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ExternalLink,
  Pencil,
  PauseCircle,
  PlayCircle,
  ScanSearch,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiClientError } from '@/api/client';
import {
  useCheckNow,
  useDeleteWebsite,
  useUpdateWebsite,
  useWebsite,
  useWebsiteHistory,
} from '@/api/hooks';
import { HealthScoreFigure, HealthScorePill } from '@/components/health-score';
import { ScoreTrend, type TrendPoint } from '@/components/score-trend';
import { LiveCheck } from '@/components/website-card';
import { EmailDeliveriesCard } from '@/components/website-emails';
import { FORM_MODE_LABELS } from '@/components/website-form';
import { RecipientsCard } from '@/components/website-recipients';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber, relativeTime } from '@/lib/format';
import { useDocumentTitle } from '@/lib/use-document-title';
import { describePageSelection, describeScheduleLocal, TRIGGER_LABELS } from '@/lib/website';

function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading website">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="grid gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((card) => (
          <Skeleton key={card} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

function DeleteButton({ website }: { website: Website }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const remove = useDeleteWebsite(website.id);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Trash2 className="size-4" aria-hidden />
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Delete ${website.name}?`}
        description="Beacon stops checking it and stops emailing its recipients. Reports from earlier checks are kept and stay available as one-off scans."
      >
        <DialogFooter>
          <DialogClose asChild>
            <Button>Keep website</Button>
          </DialogClose>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  setOpen(false);
                  toast.success(`${website.name} deleted`);
                  void navigate('/websites', { replace: true });
                },
                onError: (error) => {
                  setOpen(false);
                  toast.error(
                    error instanceof ApiClientError
                      ? error.message
                      : 'Could not delete the website.',
                  );
                },
              })
            }
          >
            Delete website
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Header({ website }: { website: Website }) {
  const navigate = useNavigate();
  const checkNow = useCheckNow(website.id);
  const update = useUpdateWebsite(website.id);
  const checking = website.activeScanId !== null;

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <Link
          to="/websites"
          className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted transition-colors hover:text-fg"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Websites
        </Link>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="break-words text-xl font-semibold text-fg">{website.name}</h1>
          {!website.isActive ? (
            <Badge tone="neutral">
              <PauseCircle className="size-3" aria-hidden />
              Paused
            </Badge>
          ) : checking ? (
            <Badge tone="accent">Checking now</Badge>
          ) : (
            <Badge tone="success">Active</Badge>
          )}
        </div>
        <a
          href={website.url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 inline-flex items-center gap-1 break-all font-mono text-xs text-muted hover:text-fg hover:underline"
        >
          {website.url}
          <ExternalLink className="size-3 shrink-0" aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        <p className="mt-1 text-[13px] text-muted">
          {describeScheduleLocal(website)}
          {website.isActive && website.nextCheckAt ? (
            <>
              {' · '}Next check{' '}
              <time dateTime={website.nextCheckAt} title={formatDateTime(website.nextCheckAt)}>
                {relativeTime(website.nextCheckAt)}
              </time>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="primary"
          loading={checkNow.isPending}
          disabled={checking}
          onClick={() =>
            checkNow.mutate(undefined, {
              onSuccess: (scan) => {
                toast.success('Check started');
                void navigate(`/scans/${scan.id}`);
              },
              onError: (error) =>
                toast.error(
                  error instanceof ApiClientError ? error.message : 'Could not start the check.',
                ),
            })
          }
        >
          <ScanSearch className="size-4" aria-hidden />
          {checking ? 'Checking…' : 'Check now'}
        </Button>
        <Button
          loading={update.isPending}
          onClick={() =>
            update.mutate(
              { isActive: !website.isActive },
              {
                onSuccess: () =>
                  toast.success(website.isActive ? 'Website paused' : 'Website resumed'),
                onError: (error) =>
                  toast.error(
                    error instanceof ApiClientError
                      ? error.message
                      : 'Could not update the website.',
                  ),
              },
            )
          }
        >
          {website.isActive ? (
            <PauseCircle className="size-4" aria-hidden />
          ) : (
            <PlayCircle className="size-4" aria-hidden />
          )}
          {website.isActive ? 'Pause' : 'Resume'}
        </Button>
        <Link to={`/websites/${website.id}/edit`} className={buttonVariants()}>
          <Pencil className="size-4" aria-hidden />
          Edit
        </Link>
        <DeleteButton website={website} />
      </div>
    </div>
  );
}

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
            'tabular mt-2 text-4xl font-semibold leading-none',
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

function Summary({ website }: { website: Website }) {
  const latest = website.latest;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card className="col-span-2 lg:col-span-1">
        <CardContent>
          <p className="mb-2 text-[13px] font-medium text-muted">Latest health score</p>
          <HealthScoreFigure score={latest?.healthScore ?? null} change={latest?.scoreChange} />
          {latest?.finishedAt ? (
            <p className="mt-2 text-[13px] text-muted">
              <Link to={`/scans/${latest.scanId}`} className="text-accent-text hover:underline">
                Check #{latest.runNumber}
              </Link>{' '}
              <time dateTime={latest.finishedAt}>{relativeTime(latest.finishedAt)}</time>
            </p>
          ) : (
            <p className="mt-2 text-[13px] text-muted">No completed check yet.</p>
          )}
          {latest?.status === 'failed' ? (
            <p className="mt-2 text-[13px] text-critical-text">
              The last check failed.{' '}
              <Link
                to={`/scans/${latest.scanId}`}
                className="font-medium underline underline-offset-2"
              >
                See why
              </Link>
            </p>
          ) : null}
        </CardContent>
      </Card>
      <StatCard
        label="Critical"
        value={latest?.critical ?? 0}
        tone="critical"
        note="In the latest check"
      />
      <StatCard
        label="Warnings"
        value={latest?.warnings ?? 0}
        tone="warning"
        note="In the latest check"
      />
      <StatCard
        label="Pages checked"
        value={website.pagesEverChecked}
        note="Different pages, across every check"
      />
    </div>
  );
}

function History({ website }: { website: Website }) {
  const history = useWebsiteHistory(website.id);
  const items = useMemo(
    () => history.data?.pages.flatMap((page) => page.items) ?? [],
    [history.data],
  );
  const trend = useMemo<TrendPoint[]>(
    () =>
      items
        .filter((item) => item.healthScore !== null)
        .slice(0, 12)
        .reverse()
        .map((item) => ({
          run: item.runNumber,
          score: item.healthScore as number,
          finishedAt: item.finishedAt,
        })),
    [items],
  );

  if (history.isPending) {
    return <Skeleton className="h-64 w-full" aria-label="Loading history" />;
  }
  if (history.isError) {
    return (
      <ErrorState
        title="Could not load the history"
        error={history.error}
        onRetry={() => void history.refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <ScoreTrend
        points={trend}
        description={`The last ${trend.length} completed checks of ${website.name}.`}
      />
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Check history</CardTitle>
            <CardDescription>Every completed check, newest first.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              title="No completed checks yet"
              description={
                website.checkFrequency === 'manual'
                  ? 'Start one with Check now.'
                  : 'The first check runs on schedule, or start one now.'
              }
              className="py-8"
            />
          ) : (
            <>
              <div className="scroll-x">
                <table className="w-full min-w-[640px] border-collapse text-sm">
                  <caption className="sr-only">Completed checks, newest first</caption>
                  <thead>
                    <tr className="text-left text-xs font-medium uppercase tracking-wide text-subtle">
                      <th scope="col" className="py-2 pr-3">
                        Check
                      </th>
                      <th scope="col" className="py-2 pr-3">
                        Finished
                      </th>
                      <th scope="col" className="py-2 pr-3">
                        Started by
                      </th>
                      <th scope="col" className="py-2 pr-3">
                        Score
                      </th>
                      <th scope="col" className="py-2 pr-3 text-right">
                        Critical
                      </th>
                      <th scope="col" className="py-2 pr-3 text-right">
                        Warnings
                      </th>
                      <th scope="col" className="py-2 text-right">
                        Pages
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.scanId} className="border-t border-border">
                        <td className="py-2.5 pr-3">
                          <Link
                            to={`/scans/${item.scanId}`}
                            className="font-medium text-fg hover:underline"
                          >
                            #{item.runNumber}
                            <span className="sr-only"> report</span>
                          </Link>
                        </td>
                        <td className="py-2.5 pr-3 text-[13px] text-muted">
                          {item.finishedAt ? (
                            <time
                              dateTime={item.finishedAt}
                              title={formatDateTime(item.finishedAt)}
                            >
                              {relativeTime(item.finishedAt)}
                            </time>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-[13px] text-muted">
                          {TRIGGER_LABELS[item.triggeredByType]}
                        </td>
                        <td className="py-2.5 pr-3">
                          <HealthScorePill score={item.healthScore} />
                        </td>
                        <td className="tabular py-2.5 pr-3 text-right">{item.critical}</td>
                        <td className="tabular py-2.5 pr-3 text-right">{item.warnings}</td>
                        <td className="tabular py-2.5 text-right text-muted">{item.pages}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {history.hasNextPage ? (
                <div className="mt-3 flex justify-center">
                  <Button
                    size="sm"
                    onClick={() => void history.fetchNextPage()}
                    loading={history.isFetchingNextPage}
                  >
                    Show older checks
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[150px_1fr] sm:gap-4">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="text-[13px] text-fg">{children}</dd>
    </div>
  );
}

function Configuration({ website }: { website: Website }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>How this website is checked.</CardDescription>
        </div>
        <Link to={`/websites/${website.id}/edit`} className={buttonVariants({ size: 'sm' })}>
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </Link>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <Row label="Schedule">{describeScheduleLocal(website)}</Row>
          <Row label="Pages">
            {describePageSelection(website)}
            {website.pageSelectionMode === 'random_sample' && website.pinnedPageUrls.length > 0 ? (
              <ul className="mt-1 font-mono text-xs text-muted">
                {website.pinnedPageUrls.map((url) => (
                  <li key={url} className="break-all">
                    {url}
                  </li>
                ))}
              </ul>
            ) : null}
            {website.pageSelectionMode === 'static_list' ? (
              <ul className="mt-1 font-mono text-xs text-muted">
                {website.staticPageUrls.map((url) => (
                  <li key={url} className="break-all">
                    {url}
                  </li>
                ))}
              </ul>
            ) : null}
          </Row>
          <Row label="Checks">
            {website.enabledChecks.map((check) => CHECK_LABELS[check]).join(', ')}
          </Row>
          <Row label="Forms">{FORM_MODE_LABELS[website.formMode].label}</Row>
          <Row label="Emails">{website.emailEnabled ? 'On' : 'Off'}</Row>
          <Row label="Added">{formatDateTime(website.createdAt)}</Row>
        </dl>
      </CardContent>
    </Card>
  );
}

export function WebsiteDetailPage() {
  const { id = '' } = useParams();
  const website = useWebsite(id);
  const client = useQueryClient();
  useDocumentTitle(website.data ? `${website.data.name} · Beacon` : 'Website · Beacon');

  if (website.isPending) return <DetailSkeleton />;

  if (website.isError) {
    const notFound = website.error instanceof ApiClientError && website.error.status === 404;
    return notFound ? (
      <EmptyState
        title="Website not found"
        description="It may have been removed, or the link may be wrong."
        action={
          <Link to="/websites" className={buttonVariants({ variant: 'primary' })}>
            Go to websites
          </Link>
        }
        className="mt-10"
      />
    ) : (
      <ErrorState
        title="Could not load this website"
        error={website.error}
        onRetry={() => void client.invalidateQueries({ queryKey: ['website', id] })}
      />
    );
  }

  const data = website.data;
  const emailFailed = data.emailStatus && data.emailStatus.failed > 0 ? data.emailStatus : null;
  return (
    <div className="space-y-6">
      <Header website={data} />

      {data.lastRunError ? (
        <Alert tone="warning" title="The last scheduled check could not start">
          {data.lastRunError}
        </Alert>
      ) : null}
      {emailFailed ? (
        <Alert tone="warning" title="A report email did not go out">
          {emailFailed.failed === 1 ? 'One email' : `${emailFailed.failed} emails`} for the latest
          check failed
          {emailFailed.lastError ? `: ${emailFailed.lastError}` : '.'} See Emails below.
        </Alert>
      ) : null}

      {data.activeScanId ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Check in progress</CardTitle>
              <CardDescription>The report is ready when it completes.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <LiveCheck scanId={data.activeScanId} />
          </CardContent>
        </Card>
      ) : null}

      <Summary website={data} />
      <History website={data} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Configuration website={data} />
        <RecipientsCard website={data} />
      </div>
      <EmailDeliveriesCard websiteId={data.id} />
    </div>
  );
}
