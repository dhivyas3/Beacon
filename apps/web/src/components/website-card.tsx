import { healthBand, isActiveStatus, type Website } from '@beacon/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, PauseCircle, TriangleAlert, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { useScan } from '@/api/hooks';
import { ScoreChange } from '@/components/health-score';
import { ScanProgress } from '@/components/scan-progress';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatNumber, relativeTime } from '@/lib/format';

const BAND = {
  good: { label: 'Good', text: 'text-success-text', icon: CheckCircle2 },
  fair: { label: 'Fair', text: 'text-warning-text', icon: TriangleAlert },
  poor: { label: 'Poor', text: 'text-critical-text', icon: XCircle },
} as const;

/**
 * The progress of a check that is running right now. It polls the scan and, when the scan ends,
 * tells the lists to refresh so the new score appears without waiting for the next poll.
 */
export function LiveCheck({ scanId }: { scanId: string }) {
  const client = useQueryClient();
  const scan = useScan(scanId);
  const finished = scan.data ? !isActiveStatus(scan.data.status) : false;

  useEffect(() => {
    if (!finished) return;
    void client.invalidateQueries({ queryKey: ['websites'] });
    void client.invalidateQueries({ queryKey: ['website'] });
    void client.invalidateQueries({ queryKey: ['website-history'] });
  }, [finished, client]);

  if (!scan.data) {
    return <Skeleton className="h-12 w-full" aria-label="Loading progress" />;
  }
  return (
    <div>
      <ScanProgress
        status={scan.data.status}
        progress={scan.data.progress}
        className="max-w-none"
      />
      <p className="mt-2 text-xs text-muted">
        Check #{scan.data.runNumber} ·{' '}
        <Link to={`/scans/${scanId}`} className="font-medium text-accent-text hover:underline">
          Follow this check
        </Link>
      </p>
    </div>
  );
}

function nextCheckText(website: Website): string {
  if (!website.isActive) return 'Paused';
  if (website.checkFrequency === 'manual') return 'Checked only when you start it';
  if (!website.nextCheckAt) return 'Next check not planned';
  return `Next check ${relativeTime(website.nextCheckAt)}`;
}

/** One website on the overview: its latest score, what changed, and when it is checked next. */
export function WebsiteCard({ website }: { website: Website }) {
  const latest = website.latest;
  const checking = website.activeScanId !== null;
  const score = latest?.healthScore ?? null;
  const band = score === null ? null : BAND[healthBand(score)];
  const emailFailed = (website.emailStatus?.failed ?? 0) > 0;

  return (
    <Card className="relative transition-shadow duration-150 focus-within:ring-2 focus-within:ring-accent hover:shadow-pop">
      <CardContent className="flex h-full flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-fg">
              <Link
                to={`/websites/${website.id}`}
                className="outline-none after:absolute after:inset-0 after:rounded-lg"
              >
                {website.name}
              </Link>
            </h3>
            <p className="truncate font-mono text-xs text-subtle">{website.hostname}</p>
          </div>
          {!website.isActive ? (
            <Badge tone="neutral">
              <PauseCircle className="size-3" aria-hidden />
              Paused
            </Badge>
          ) : checking ? (
            <Badge tone="accent">Checking now</Badge>
          ) : null}
        </div>

        {checking && website.activeScanId ? (
          <div className="relative z-10">
            <LiveCheck scanId={website.activeScanId} />
          </div>
        ) : latest && score !== null && band ? (
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="flex items-baseline gap-1.5">
                <span className="tabular text-4xl font-semibold leading-none text-fg">{score}</span>
                <span className="text-sm text-subtle">/ 100</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-[13px] font-medium',
                    band.text,
                  )}
                >
                  <band.icon className="size-3.5" aria-hidden />
                  {band.label}
                </span>
                <ScoreChange change={latest.scoreChange} />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 text-right">
              <div>
                <dt className="text-xs text-subtle">Critical</dt>
                <dd
                  className={cn(
                    'tabular text-lg font-semibold',
                    latest.critical > 0 ? 'text-critical-text' : 'text-fg',
                  )}
                >
                  {formatNumber(latest.critical)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-subtle">Warnings</dt>
                <dd
                  className={cn(
                    'tabular text-lg font-semibold',
                    latest.warnings > 0 ? 'text-warning-text' : 'text-fg',
                  )}
                >
                  {formatNumber(latest.warnings)}
                </dd>
              </div>
            </dl>
          </div>
        ) : latest?.status === 'failed' ? (
          <p className="flex items-start gap-1.5 text-[13px] text-critical-text">
            <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            The last check could not finish.{' '}
            <Link
              to={`/scans/${latest.scanId}`}
              className="font-medium underline underline-offset-2"
            >
              See why
            </Link>
          </p>
        ) : (
          <p className="text-[13px] text-muted">
            No completed check yet.{' '}
            {website.isActive && website.checkFrequency !== 'manual'
              ? 'The first one runs on schedule.'
              : 'Start one from the website page.'}
          </p>
        )}

        <div className="mt-auto space-y-1 border-t border-border pt-3 text-[13px] text-muted">
          <p>
            {latest?.finishedAt ? (
              <>
                {latest.status === 'failed' ? 'Last attempt' : 'Last checked'}{' '}
                <time dateTime={latest.finishedAt}>{relativeTime(latest.finishedAt)}</time>
                {latest.status === 'completed'
                  ? ` · ${latest.pages} ${latest.pages === 1 ? 'page' : 'pages'}`
                  : ''}
              </>
            ) : (
              'Never checked'
            )}
          </p>
          <p>{nextCheckText(website)}</p>
          {website.lastRunError ? (
            <p className="flex items-start gap-1.5 text-warning-text">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Last scheduled check could not start
            </p>
          ) : null}
          {emailFailed ? (
            <p className="flex items-start gap-1.5 text-warning-text">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              The last report email failed
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function WebsiteCardSkeleton() {
  return (
    <Card aria-hidden>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="h-12 w-full" />
        <div className="space-y-1.5 border-t border-border pt-3">
          <Skeleton className="h-3 w-44" />
          <Skeleton className="h-3 w-32" />
        </div>
      </CardContent>
    </Card>
  );
}
