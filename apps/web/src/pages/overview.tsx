import { Globe, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useWebsites } from '@/api/hooks';
import { WebsiteCard, WebsiteCardSkeleton } from '@/components/website-card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import { useDocumentTitle } from '@/lib/use-document-title';
import { attentionRank, needsAttention } from '@/lib/website';

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'critical' }) {
  return (
    <Card>
      <CardContent className="py-3 sm:py-4">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        <p
          className={cn(
            'tabular mt-1 text-2xl font-semibold leading-none',
            tone === 'critical' && value > 0 ? 'text-critical-text' : 'text-fg',
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

/** Every website at a glance: what needs attention first, and checks that are running now. */
export function OverviewPage() {
  useDocumentTitle('Overview · Beacon');
  const websites = useWebsites({});
  const items = useMemo(
    () =>
      (websites.data?.pages.flatMap((page) => page.items) ?? []).sort(
        (a, b) => attentionRank(a) - attentionRank(b) || a.name.localeCompare(b.name),
      ),
    [websites.data],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Overview</h1>
          <p className="mt-1 text-[13px] text-muted">
            The health of every website Beacon keeps watch on.
          </p>
        </div>
        <Link to="/websites/new" className={buttonVariants({ variant: 'primary' })}>
          <Plus className="size-4" aria-hidden />
          Add website
        </Link>
      </div>

      {websites.isPending ? (
        <div aria-busy="true" aria-label="Loading websites">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((card) => (
              <WebsiteCardSkeleton key={card} />
            ))}
          </div>
        </div>
      ) : websites.isError ? (
        <ErrorState
          title="Could not load websites"
          error={websites.error}
          onRetry={() => void websites.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="Add your first website"
          description="Register a site once and Beacon checks a few of its pages on a schedule, then emails the report to whoever should see it."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link to="/websites/new" className={buttonVariants({ variant: 'primary' })}>
                <Plus className="size-4" aria-hidden />
                Add website
              </Link>
              <Link to="/scans" className={buttonVariants()}>
                Run a one-off scan
              </Link>
            </div>
          }
        />
      ) : (
        <>
          <section aria-label="Summary" className="grid grid-cols-3 gap-3">
            <Tile label="Websites" value={items.length} />
            <Tile
              label="Need attention"
              value={items.filter(needsAttention).length}
              tone="critical"
            />
            <Tile
              label="Checking now"
              value={items.filter((website) => website.activeScanId !== null).length}
            />
          </section>
          <section aria-label="Websites" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((website) => (
              <WebsiteCard key={website.id} website={website} />
            ))}
          </section>
          {websites.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                onClick={() => void websites.fetchNextPage()}
                loading={websites.isFetchingNextPage}
              >
                Show more websites
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
