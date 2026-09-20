import { formatDuration, type ScanDetail } from '@qa-hub/shared';
import { Activity, Gauge, Hourglass, Timer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useIssueFeed } from '@/api/hooks';
import { ScanProgress } from '@/components/scan-progress';
import { SeverityLabel } from '@/components/severity';
import { Alert } from '@/components/ui/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatClock, formatNumber, pathOf, relativeTime } from '@/lib/format';

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-subtle">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </p>
      <p className="tabular mt-1 text-lg font-semibold text-fg">{value}</p>
    </div>
  );
}

/** Issues as they are found, newest first. */
function LiveFeed({ scanId }: { scanId: string }) {
  const feed = useIssueFeed(scanId, true);
  const items = feed.data?.items ?? [];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Found so far</CardTitle>
          <CardDescription>New issues appear here as pages are checked.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-3 sm:pt-3">
        {feed.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading issues">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted">
            Nothing found yet. Issues show up here the moment a check finds one.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((issue) => (
              <li key={issue.id} className="flex items-start gap-3 py-2.5 animate-fade-in">
                <SeverityLabel severity={issue.severity} iconOnly className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-fg">{issue.message}</p>
                  <p className="truncate font-mono text-xs text-subtle">
                    {pathOf(issue.pageUrl ?? issue.resourceUrl)}
                  </p>
                </div>
                <time className="shrink-0 text-xs text-subtle" dateTime={issue.createdAt}>
                  {relativeTime(issue.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** What a scan looks like while it is running: big progress, throughput and a live feed. */
export function InProgressView({ scan }: { scan: ScanDetail }) {
  const { progress } = scan;
  return (
    <div className="space-y-4">
      <Alert tone="info" title="Scan in progress, results incomplete">
        Numbers and issues below are what has been found so far and will keep changing until the
        scan completes.
      </Alert>

      <Card>
        <CardContent className="space-y-5">
          <ScanProgress status={scan.status} progress={progress} size="large" />
          <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
            <Stat
              icon={Gauge}
              label="Pages per minute"
              value={formatNumber(progress.pagesPerMinute)}
            />
            <Stat icon={Timer} label="Elapsed" value={formatDuration(progress.elapsedSeconds)} />
            <Stat
              icon={Hourglass}
              label="Estimated finish"
              value={progress.estimatedFinishAt ? formatClock(progress.estimatedFinishAt) : '—'}
            />
            <Stat
              icon={Activity}
              label="Found so far"
              value={`${formatNumber(scan.summary.critical)} critical, ${formatNumber(scan.summary.warnings)} warnings`}
            />
          </div>
        </CardContent>
      </Card>

      <LiveFeed scanId={scan.id} />
    </div>
  );
}
