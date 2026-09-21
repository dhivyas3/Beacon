import type { Website } from '@beacon/shared';
import { Globe, Loader2, PauseCircle, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useWebsites } from '@/api/hooks';
import { HealthScorePill } from '@/components/health-score';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { useDocumentTitle } from '@/lib/use-document-title';
import { describePageSelection, describeScheduleLocal } from '@/lib/website';

const HEAD = 'px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-subtle';
const CELL = 'px-3 py-3 align-middle';

function StatusCell({ website }: { website: Website }) {
  if (!website.isActive) {
    return (
      <Badge tone="neutral">
        <PauseCircle className="size-3" aria-hidden />
        Paused
      </Badge>
    );
  }
  if (website.activeScanId) return <Badge tone="accent">Checking now</Badge>;
  return <Badge tone="success">Active</Badge>;
}

function WebsitesTable({ websites }: { websites: Website[] }) {
  const navigate = useNavigate();
  return (
    <div className="scroll-x rounded-lg border border-border bg-surface shadow-card">
      <table className="w-full min-w-[860px] border-collapse text-sm">
        <caption className="sr-only">Websites</caption>
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={HEAD}>
              Website
            </th>
            <th scope="col" className={HEAD}>
              Status
            </th>
            <th scope="col" className={HEAD}>
              Schedule
            </th>
            <th scope="col" className={cn(HEAD, 'hidden lg:table-cell')}>
              Pages checked
            </th>
            <th scope="col" className={HEAD}>
              Latest score
            </th>
            <th scope="col" className={HEAD}>
              Last check
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Recipients
            </th>
          </tr>
        </thead>
        <tbody>
          {websites.map((website) => {
            const active = website.recipients.filter((recipient) => recipient.isActive).length;
            return (
              <tr
                key={website.id}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('a,button')) return;
                  void navigate(`/websites/${website.id}`);
                }}
                className="cursor-pointer border-b border-border transition-colors duration-150 last:border-b-0 hover:bg-surface-2/60"
              >
                <td className={CELL}>
                  <Link
                    to={`/websites/${website.id}`}
                    className="block max-w-[240px] truncate font-medium text-fg hover:underline"
                  >
                    {website.name}
                  </Link>
                  <span className="block max-w-[240px] truncate font-mono text-xs text-subtle">
                    {website.hostname}
                  </span>
                </td>
                <td className={CELL}>
                  <StatusCell website={website} />
                </td>
                <td className={cn(CELL, 'text-[13px] text-muted')}>
                  {describeScheduleLocal(website)}
                </td>
                <td className={cn(CELL, 'hidden text-[13px] text-muted lg:table-cell')}>
                  {describePageSelection(website)}
                </td>
                <td className={CELL}>
                  <HealthScorePill score={website.latest?.healthScore ?? null} />
                </td>
                <td className={cn(CELL, 'whitespace-nowrap text-[13px] text-muted')}>
                  {website.latest?.finishedAt ? (
                    <time dateTime={website.latest.finishedAt}>
                      {relativeTime(website.latest.finishedAt)}
                    </time>
                  ) : (
                    'Never'
                  )}
                </td>
                <td className={cn(CELL, 'tabular text-right text-[13px] text-muted')}>
                  {website.emailEnabled ? active : <span title="Emails are turned off">Off</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WebsitesTableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div
      className="rounded-lg border border-border bg-surface shadow-card"
      aria-busy="true"
      aria-label="Loading websites"
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
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="ml-auto h-5 w-12 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function WebsitesPage() {
  useDocumentTitle('Websites · Beacon');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const filters = useMemo(() => ({ q: q || undefined }), [q]);
  const websites = useWebsites(filters);
  const items = useMemo(
    () => websites.data?.pages.flatMap((page) => page.items) ?? [],
    [websites.data],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Websites</h1>
          <p className="mt-1 text-[13px] text-muted">
            Sites Beacon checks on a schedule and emails reports for.
          </p>
        </div>
        <Link to="/websites/new" className={buttonVariants({ variant: 'primary' })}>
          <Plus className="size-4" aria-hidden />
          Add website
        </Link>
      </div>

      <section aria-label="Website list" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle"
              aria-hidden
            />
            <Input
              type="search"
              placeholder="Search websites"
              aria-label="Search websites"
              className="pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {websites.isFetching && !websites.isPending ? (
            <Loader2 className="ml-auto size-4 animate-spin text-subtle" aria-label="Refreshing" />
          ) : null}
        </div>

        {websites.isPending ? (
          <WebsitesTableSkeleton />
        ) : websites.isError ? (
          <ErrorState
            title="Could not load websites"
            error={websites.error}
            onRetry={() => void websites.refetch()}
          />
        ) : items.length === 0 ? (
          q ? (
            <EmptyState
              icon={Search}
              title="No websites match your search"
              description="Try a different name or address, or clear the search."
              action={<Button onClick={() => setSearch('')}>Clear search</Button>}
            />
          ) : (
            <EmptyState
              icon={Globe}
              title="No websites yet"
              description="Add a website and choose how often, and how many pages, Beacon should check."
              action={
                <Link to="/websites/new" className={buttonVariants({ variant: 'primary' })}>
                  <Plus className="size-4" aria-hidden />
                  Add website
                </Link>
              }
            />
          )
        ) : (
          <>
            <WebsitesTable websites={items} />
            {websites.hasNextPage ? (
              <div className="flex justify-center">
                <Button
                  onClick={() => void websites.fetchNextPage()}
                  loading={websites.isFetchingNextPage}
                >
                  Load more websites
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
