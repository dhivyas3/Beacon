import { SCAN_STATUSES, type ScanStatus } from '@beacon/shared';
import { Loader2, Radar, Search, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useScansInfinite } from '@/api/hooks';
import { NewScanForm } from '@/components/new-scan-form';
import { ScansTable, ScansTableSkeleton } from '@/components/scans-table';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useDebounced } from '@/lib/use-debounced';
import { useDocumentTitle } from '@/lib/use-document-title';

const STATUS_LABELS: Record<ScanStatus, string> = {
  queued: 'Queued',
  discovering: 'Discovering',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function DashboardPage() {
  useDocumentTitle('Scans · Beacon');
  const urlInput = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ScanStatus | ''>('');
  const [site, setSite] = useState('');
  const [knownSites, setKnownSites] = useState<string[]>([]);
  const q = useDebounced(search.trim());

  const filters = useMemo(
    () => ({
      status: status || undefined,
      hostname: site || undefined,
      q: q || undefined,
    }),
    [status, site, q],
  );
  const scans = useScansInfinite(filters);
  const items = useMemo(() => scans.data?.pages.flatMap((page) => page.items) ?? [], [scans.data]);

  // Remember every site seen so far, so the site filter can still offer them once it is applied.
  const seen = items.map((scan) => scan.hostname).filter((host) => !knownSites.includes(host));
  if (seen.length > 0) setKnownSites([...new Set([...knownSites, ...seen])].sort());

  const filtered = Boolean(status || site || q);

  function clearFilters(): void {
    setSearch('');
    setStatus('');
    setSite('');
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="new-scan-heading">
        <h1 id="new-scan-heading" className="mb-3 text-xl font-semibold text-fg">
          Scans
        </h1>
        <NewScanForm ref={urlInput} />
      </section>

      <section aria-label="Scan list" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle"
              aria-hidden
            />
            <Input
              type="search"
              placeholder="Search sites"
              aria-label="Search sites"
              className="pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value as ScanStatus | '')}
          >
            <option value="">All statuses</option>
            {SCAN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by site"
            value={site}
            onChange={(event) => setSite(event.target.value)}
          >
            <option value="">All sites</option>
            {knownSites.map((host) => (
              <option key={host} value={host}>
                {host}
              </option>
            ))}
          </Select>
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="size-3.5" aria-hidden />
              Clear filters
            </Button>
          ) : null}
          {scans.isFetching && !scans.isPending ? (
            <Loader2 className="ml-auto size-4 animate-spin text-subtle" aria-label="Refreshing" />
          ) : null}
        </div>

        {scans.isPending ? (
          <ScansTableSkeleton />
        ) : scans.isError ? (
          <ErrorState
            title="Could not load scans"
            error={scans.error}
            onRetry={() => void scans.refetch()}
          />
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={Search}
              title="No scans match these filters"
              description="Try a different search, or clear the filters to see every scan."
              action={<Button onClick={clearFilters}>Clear filters</Button>}
            />
          ) : (
            <EmptyState
              icon={Radar}
              title="Run your first scan"
              description="Enter the address of a live site above. Beacon finds every page and checks images, links, staging URLs and page health."
              action={
                <Button variant="primary" onClick={() => urlInput.current?.focus()}>
                  Enter a site address
                </Button>
              }
            />
          )
        ) : (
          <>
            <ScansTable scans={items} />
            {scans.hasNextPage ? (
              <div className="flex justify-center">
                <Button
                  onClick={() => void scans.fetchNextPage()}
                  loading={scans.isFetchingNextPage}
                >
                  Load more scans
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
