import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  isActiveStatus,
  type Issue,
  type Page,
  type ProgressEvent,
  type RecipientInput,
  type ScanDetail,
  type ScanStatus,
  type UpdateRecipientBody,
  type UpdateWebsiteBody,
} from '@beacon/shared';
import {
  api,
  type IssueFilters,
  type PageFilters,
  type ScanListFilters,
  type WebsiteCreateInput,
  type WebsiteListFilters,
} from './client';

/** Polling rhythm. Active scans update every second, an idle list refreshes now and then. */
export const POLL_ACTIVE_MS = 1000;
export const POLL_LIST_ACTIVE_MS = 2000;
export const POLL_LIST_IDLE_MS = 15_000;
/** While the live event stream is connected, polling is only a safety net. */
export const POLL_STREAMED_MS = 10_000;

export const keys = {
  session: ['session'] as const,
  scans: (filters: ScanListFilters) => ['scans', filters] as const,
  scan: (id: string) => ['scan', id] as const,
  history: (hostname: string) => ['scan-history', hostname] as const,
  pages: (id: string, filters: PageFilters) => ['pages', id, filters] as const,
  issues: (id: string, filters: IssueFilters) => ['issues', id, 'flat', filters] as const,
  groups: (id: string, filters: IssueFilters) => ['issues', id, 'groups', filters] as const,
  feed: (id: string) => ['issues', id, 'feed'] as const,
  fixed: (id: string) => ['fixed', id] as const,
  stream: (id: string) => ['scan-stream', id] as const,
  websites: (filters: WebsiteListFilters) => ['websites', filters] as const,
  website: (id: string) => ['website', id] as const,
  websiteHistory: (id: string) => ['website-history', id] as const,
  emailDeliveries: (id: string) => ['email-deliveries', id] as const,
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
  const client = useQueryClient();
  return useQuery({
    queryKey: keys.scan(id),
    queryFn: () => api.scans.get(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === undefined || !isActiveStatus(status)) return false;
      const streamed = client.getQueryData<{ connected: boolean }>(keys.stream(id))?.connected;
      return streamed ? POLL_STREAMED_MS : POLL_ACTIVE_MS;
    },
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 2,
  });
}

function parseEvent<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

/**
 * Follows a running scan over server-sent events, writing what arrives straight into the query
 * cache so every view that shows the scan updates at once. If the stream cannot open, or drops,
 * `useScan` goes back to polling every second, so the page never stops moving.
 */
export function useScanEvents(scanId: string, enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled || scanId === '' || typeof EventSource === 'undefined') return;
    const source = new EventSource(api.scans.eventsUrl(scanId), { withCredentials: true });
    const setConnected = (connected: boolean) =>
      client.setQueryData(keys.stream(scanId), { connected });

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('progress', (event) => {
      const data = parseEvent<ProgressEvent>(event);
      if (!data) return;
      // A finished scan is not written into the cache from here. The stream carries progress only,
      // so the report would render with no per-check results, and the status change would switch
      // this stream off before its own `done` event arrived. Load the whole scan instead, and let
      // the stream stay open until `done`.
      if (!isActiveStatus(data.status)) {
        void client.invalidateQueries({ queryKey: keys.scan(scanId) });
        return;
      }
      client.setQueryData<ScanDetail>(keys.scan(scanId), (current) =>
        current
          ? { ...current, status: data.status, progress: data.progress, summary: data.summary }
          : current,
      );
    });
    source.addEventListener('issue', (event) => {
      const issue = parseEvent<Issue>(event);
      if (!issue) return;
      client.setQueryData<Page<Issue>>(keys.feed(scanId), (current) =>
        current
          ? {
              ...current,
              items: [issue, ...current.items.filter((item) => item.id !== issue.id)].slice(0, 12),
            }
          : current,
      );
    });
    source.addEventListener('done', () => {
      source.close();
      setConnected(false);
      // The stream carries progress only. The rest of the report loads now that the scan is over.
      const stale = [
        keys.scan(scanId),
        ['issues', scanId],
        ['pages', scanId],
        ['scans'],
        ['websites'],
        ['website'],
      ];
      for (const queryKey of stale) void client.invalidateQueries({ queryKey });
    });
    return () => {
      source.close();
      setConnected(false);
    };
  }, [client, scanId, enabled]);
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

export function useFixedIssues(scanId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.fixed(scanId),
    queryFn: () => api.scans.fixed(scanId),
    enabled,
    staleTime: 30_000,
  });
}

// ---- Websites -----------------------------------------------------------------------------------

export function useWebsites(filters: WebsiteListFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: keys.websites(filters),
    enabled,
    queryFn: ({ pageParam }) => api.websites.list(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const anyChecking = pages.some((page) =>
        page.items.some((website) => website.activeScanId !== null),
      );
      return anyChecking ? POLL_LIST_ACTIVE_MS : POLL_LIST_IDLE_MS;
    },
  });
}

export function useWebsite(id: string) {
  return useQuery({
    queryKey: keys.website(id),
    queryFn: () => api.websites.get(id),
    refetchInterval: (query) => (query.state.data?.activeScanId ? POLL_LIST_ACTIVE_MS : false),
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 2,
  });
}

export function useWebsiteHistory(id: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: keys.websiteHistory(id),
    enabled: enabled && id !== '',
    queryFn: ({ pageParam }) => api.websites.history(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

export function useEmailDeliveries(id: string) {
  return useInfiniteQuery({
    queryKey: keys.emailDeliveries(id),
    queryFn: ({ pageParam }) => api.websites.emailDeliveries(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

/** Everything that shows a website goes stale when it changes or a check starts or ends. */
function invalidateWebsites(client: QueryClient, id?: string): void {
  void client.invalidateQueries({ queryKey: ['websites'] });
  if (id) {
    void client.invalidateQueries({ queryKey: keys.website(id) });
    void client.invalidateQueries({ queryKey: keys.websiteHistory(id) });
  }
}

export function useCreateWebsite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: WebsiteCreateInput) => api.websites.create(body),
    onSuccess: () => invalidateWebsites(client),
  });
}

export function useUpdateWebsite(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateWebsiteBody) => api.websites.update(id, body),
    onSuccess: (website) => {
      client.setQueryData(keys.website(id), website);
      invalidateWebsites(client, id);
    },
  });
}

export function useDeleteWebsite(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.websites.remove(id),
    onSuccess: () => {
      client.removeQueries({ queryKey: keys.website(id) });
      invalidateWebsites(client);
      void client.invalidateQueries({ queryKey: ['scans'] });
    },
  });
}

export function useCheckNow(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.websites.checkNow(id),
    onSuccess: () => {
      invalidateWebsites(client, id);
      void client.invalidateQueries({ queryKey: ['scans'] });
    },
  });
}

export function useRecipientActions(websiteId: string) {
  const client = useQueryClient();
  const done = () => void client.invalidateQueries({ queryKey: keys.website(websiteId) });
  return {
    add: useMutation({
      mutationFn: (body: RecipientInput) => api.websites.addRecipient(websiteId, body),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (input: { recipientId: string; body: UpdateRecipientBody }) =>
        api.websites.updateRecipient(websiteId, input.recipientId, input.body),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (recipientId: string) => api.websites.removeRecipient(websiteId, recipientId),
      onSuccess: done,
    }),
  };
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
