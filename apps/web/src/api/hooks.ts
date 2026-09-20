import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  isActiveStatus,
  type Issue,
  type Page,
  type ScanDetail,
  type ScanStatus,
} from '@qa-hub/shared';
import { api, type IssueFilters, type PageFilters, type ScanListFilters } from './client';

/** Polling rhythm. Active scans update every second, an idle list refreshes now and then. */
export const POLL_ACTIVE_MS = 1000;
export const POLL_LIST_ACTIVE_MS = 2000;
export const POLL_LIST_IDLE_MS = 15_000;

export const keys = {
  session: ['session'] as const,
  scans: (filters: ScanListFilters) => ['scans', filters] as const,
  scan: (id: string) => ['scan', id] as const,
  history: (hostname: string) => ['scan-history', hostname] as const,
  pages: (id: string, filters: PageFilters) => ['pages', id, filters] as const,
  issues: (id: string, filters: IssueFilters) => ['issues', id, 'flat', filters] as const,
  groups: (id: string, filters: IssueFilters) => ['issues', id, 'groups', filters] as const,
  feed: (id: string) => ['issues', id, 'feed'] as const,
  apiKeys: ['api-keys'] as const,
  domains: ['allowed-domains'] as const,
  settings: ['settings'] as const,
  webhookSecret: ['webhook-secret'] as const,
};

export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: api.me,
    retry: false,
    staleTime: 60_000,
  });
}

export function useScansInfinite(filters: ScanListFilters) {
  return useInfiniteQuery({
    queryKey: keys.scans(filters),
    queryFn: ({ pageParam }) => api.scans.list(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const anyActive = pages.some((page) =>
        page.items.some((scan) => isActiveStatus(scan.status)),
      );
      return anyActive ? POLL_LIST_ACTIVE_MS : POLL_LIST_IDLE_MS;
    },
  });
}

export function useScan(id: string) {
  return useQuery({
    queryKey: keys.scan(id),
    queryFn: () => api.scans.get(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined && isActiveStatus(status) ? POLL_ACTIVE_MS : false;
    },
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 2,
  });
}

/** Completed scans of a hostname, newest first, for the score trend. */
export function useScanHistory(hostname: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.history(hostname),
    queryFn: () => api.scans.list({ hostname, status: 'completed' }),
    enabled,
    staleTime: 30_000,
  });
}

export function useScanPages(scanId: string, filters: PageFilters, refetching: boolean) {
  return useInfiniteQuery({
    queryKey: keys.pages(scanId, filters),
    queryFn: ({ pageParam }) => api.scans.pages(scanId, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: refetching ? 3000 : false,
  });
}

export function useIssues(scanId: string, filters: IssueFilters, enabled = true, limit = 25) {
  return useInfiniteQuery({
    queryKey: [...keys.issues(scanId, filters), limit],
    queryFn: ({ pageParam }) => api.scans.issues(scanId, filters, pageParam, limit),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useGroupedIssues(scanId: string, filters: IssueFilters, refetching: boolean) {
  return useInfiniteQuery({
    queryKey: keys.groups(scanId, filters),
    queryFn: ({ pageParam }) => api.scans.groupedIssues(scanId, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: refetching ? 3000 : false,
  });
}

/** The newest findings of a running scan, for the live feed. */
export function useIssueFeed(scanId: string, active: boolean) {
  return useQuery({
    queryKey: keys.feed(scanId),
    queryFn: () => api.scans.issues(scanId, { sort: 'newest', state: 'open' }, undefined, 12),
    refetchInterval: active ? 2000 : false,
    placeholderData: keepPreviousData,
  });
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: api.settings.get, staleTime: 60_000 });
}

type IssueCache = InfiniteData<Page<Issue>, string | undefined>;

/** Patches one issue inside every cached issue list, so the UI reacts before the server answers. */
function patchIssueInCaches(
  client: QueryClient,
  scanId: string,
  issueId: string,
  patch: Partial<Issue>,
): void {
  client.setQueriesData<IssueCache>({ queryKey: ['issues', scanId, 'flat'] }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => (item.id === issueId ? { ...item, ...patch } : item)),
          })),
        }
      : data,
  );
}

/**
 * Ignore or reopen an issue. The list updates immediately and rolls back if the server refuses.
 * On success the scan and grouped views refetch, because counts and the health score change.
 */
export function useUpdateIssue(scanId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { issueId: string; state: Issue['state']; ignoreNote?: string | null }) =>
      api.scans.updateIssue(scanId, input.issueId, {
        state: input.state,
        ignoreNote: input.ignoreNote ?? null,
      }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: ['issues', scanId] });
      const snapshot = client.getQueriesData<IssueCache>({ queryKey: ['issues', scanId, 'flat'] });
      patchIssueInCaches(client, scanId, input.issueId, {
        state: input.state,
        ignoreNote: input.state === 'ignored' ? (input.ignoreNote ?? null) : null,
      });
      return { snapshot };
    },
    onError: (_error, _input, context) => {
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.scan(scanId) });
      void client.invalidateQueries({ queryKey: ['issues', scanId] });
      void client.invalidateQueries({ queryKey: ['pages', scanId] });
    },
  });
}

export function useCancelScan(scanId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.scans.cancel(scanId),
    onSuccess: (scan) => {
      client.setQueryData<ScanDetail>(keys.scan(scanId), (current) =>
        current ? { ...current, ...scan } : current,
      );
      void client.invalidateQueries({ queryKey: keys.scan(scanId) });
      void client.invalidateQueries({ queryKey: ['scans'] });
    },
  });
}

export type { ScanStatus };
