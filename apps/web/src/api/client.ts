import type {
  AllowedDomain,
  ApiKey,
  CheckType,
  CreateAllowedDomainBody,
  CreateApiKeyBody,
  CreatedApiKey,
  CreateScanBody,
  CreateScanResponse,
  CreateWebsiteBody,
  EmailDelivery,
  FixedIssuesResponse,
  GroupedIssue,
  Issue,
  IssueState,
  LoginBody,
  Page,
  RecipientInput,
  Scan,
  ScanDetail,
  ScanPage,
  ScanStatus,
  SessionResponse,
  Settings,
  Severity,
  UpdateIssueBody,
  UpdateRecipientBody,
  UpdateSettingsBody,
  UpdateWebsiteBody,
  Website,
  WebsiteHistoryItem,
  WebsiteRecipient,
} from '@beacon/shared';

/** An error answered by the API, already in the `{ error: { code, message } }` shape. */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function queryString(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

let unauthorizedHandler: (() => void) | null = null;

/** Called when a request that needed a session comes back 401, so the app can send you to sign in. */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

const NETWORK_MESSAGE =
  'Beacon could not reach the server. Check your connection and that the API is running, then try again.';

async function request<T>(
  method: string,
  path: string,
  options: {
    body?: unknown;
    query?: Query;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}${queryString(options.query)}`, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError(0, 'network_error', NETWORK_MESSAGE);
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Not JSON, for example a gateway error page.
  }

  if (!response.ok) {
    const envelope = (
      payload as { error?: { code?: string; message?: string; details?: unknown } } | null
    )?.error;
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      unauthorizedHandler?.();
    }
    throw new ApiClientError(
      response.status,
      envelope?.code ?? 'http_error',
      envelope?.message ??
        (response.status >= 500
          ? 'The server had a problem. Try again in a moment.'
          : `The request failed (HTTP ${response.status}).`),
      envelope?.details,
    );
  }
  return payload as T;
}

export interface ScanListFilters {
  status?: ScanStatus | undefined;
  hostname?: string | undefined;
  q?: string | undefined;
}

export interface IssueFilters {
  severity?: Severity | undefined;
  checkType?: CheckType | undefined;
  state?: IssueState | undefined;
  pageId?: string | undefined;
  fingerprint?: string | undefined;
  sort?: 'severity' | 'newest' | undefined;
}

export interface PageFilters {
  checkType?: CheckType | undefined;
  severity?: Severity | undefined;
  hasIssues?: boolean | undefined;
  q?: string | undefined;
}

export interface WebsiteListFilters {
  q?: string | undefined;
}

/** What the form sends: the API fills in defaults for anything left out. */
export type WebsiteCreateInput = Partial<CreateWebsiteBody> &
  Pick<CreateWebsiteBody, 'name' | 'url'>;

export const api = {
  login: (body: Pick<LoginBody, 'email' | 'password'>) =>
    request<SessionResponse>('POST', '/auth/login', { body }),
  logout: () => request<void>('POST', '/auth/logout'),
  me: () => request<SessionResponse>('GET', '/auth/me'),

  scans: {
    list: (filters: ScanListFilters, cursor?: string) =>
      request<Page<Scan>>('GET', '/scans', { query: { ...filters, cursor, limit: 25 } }),
    get: (id: string) => request<ScanDetail>('GET', `/scans/${id}`),
    create: (body: CreateScanBody, idempotencyKey?: string) =>
      request<CreateScanResponse>('POST', '/scans', {
        body,
        ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
      }),
    cancel: (id: string) => request<Scan>('POST', `/scans/${id}/cancel`),
    remove: (id: string) => request<void>('DELETE', `/scans/${id}`),
    pages: (id: string, filters: PageFilters, cursor?: string, limit = 25) =>
      request<Page<ScanPage>>('GET', `/scans/${id}/pages`, {
        query: { ...filters, cursor, limit },
      }),
    issues: (id: string, filters: IssueFilters, cursor?: string, limit = 25) =>
      request<Page<Issue>>('GET', `/scans/${id}/issues`, { query: { ...filters, cursor, limit } }),
    groupedIssues: (id: string, filters: IssueFilters, cursor?: string, limit = 25) =>
      request<Page<GroupedIssue>>('GET', `/scans/${id}/issues`, {
        query: { ...filters, groupBy: 'fingerprint', cursor, limit },
      }),
    updateIssue: (scanId: string, issueId: string, body: UpdateIssueBody) =>
      request<Issue>('PATCH', `/scans/${scanId}/issues/${issueId}`, { body }),
    fixed: (id: string) => request<FixedIssuesResponse>('GET', `/scans/${id}/fixed`),
    /** Plain links: the browser downloads these with the session cookie. */
    csvUrl: (id: string) => `/api/v1/scans/${id}/export.csv`,
    pdfUrl: (id: string) => `/api/v1/scans/${id}/export.pdf`,
    eventsUrl: (id: string) => `/api/v1/scans/${id}/events`,
  },

  websites: {
    list: (filters: WebsiteListFilters, cursor?: string) =>
      request<Page<Website>>('GET', '/websites', { query: { ...filters, cursor, limit: 50 } }),
    get: (id: string) => request<Website>('GET', `/websites/${id}`),
    create: (body: WebsiteCreateInput) => request<Website>('POST', '/websites', { body }),
    update: (id: string, body: UpdateWebsiteBody) =>
      request<Website>('PATCH', `/websites/${id}`, { body }),
    remove: (id: string) => request<void>('DELETE', `/websites/${id}`),
    checkNow: (id: string) =>
      request<CreateScanResponse>('POST', `/websites/${id}/check-now`, { body: {} }),
    history: (id: string, cursor?: string) =>
      request<Page<WebsiteHistoryItem>>('GET', `/websites/${id}/history`, {
        query: { cursor, limit: 25 },
      }),
    emailDeliveries: (id: string, cursor?: string) =>
      request<Page<EmailDelivery>>('GET', `/websites/${id}/email-deliveries`, {
        query: { cursor, limit: 10 },
      }),
    addRecipient: (id: string, body: RecipientInput) =>
      request<WebsiteRecipient>('POST', `/websites/${id}/recipients`, { body }),
    updateRecipient: (id: string, recipientId: string, body: UpdateRecipientBody) =>
      request<WebsiteRecipient>('PATCH', `/websites/${id}/recipients/${recipientId}`, { body }),
    removeRecipient: (id: string, recipientId: string) =>
      request<void>('DELETE', `/websites/${id}/recipients/${recipientId}`),
  },

  apiKeys: {
    list: () => request<{ items: ApiKey[] }>('GET', '/api-keys'),
    create: (body: CreateApiKeyBody) => request<CreatedApiKey>('POST', '/api-keys', { body }),
    revoke: (id: string) => request<void>('DELETE', `/api-keys/${id}`),
  },
  domains: {
    list: () => request<{ items: AllowedDomain[] }>('GET', '/allowed-domains'),
    create: (body: CreateAllowedDomainBody) =>
      request<AllowedDomain>('POST', '/allowed-domains', { body }),
    remove: (id: string) => request<void>('DELETE', `/allowed-domains/${id}`),
  },
  settings: {
    get: () => request<Settings>('GET', '/settings'),
    update: (body: UpdateSettingsBody) => request<Settings>('PATCH', '/settings', { body }),
    webhookSecret: () => request<{ secret: string }>('GET', '/settings/webhook-secret'),
  },
};
