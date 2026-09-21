import type {
  ApiKey,
  AllowedDomain,
  EmailDelivery,
  GroupedIssue,
  Issue,
  Page,
  Progress,
  Scan,
  ScanDetail,
  ScanPage,
  SessionResponse,
  Settings,
  Website,
  WebsiteHistoryItem,
  WebsiteRecipient,
} from '@beacon/shared';

export function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    phase: 'queued',
    percent: 0,
    pagesFound: 0,
    pagesDone: 0,
    pagesTotal: 0,
    linksChecked: 0,
    linksTotal: 0,
    pagesPerMinute: 0,
    elapsedSeconds: 0,
    etaSeconds: null,
    estimating: false,
    estimatedFinishAt: null,
    queuePosition: null,
    ...overrides,
  };
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${String(++counter).padStart(12, '0')}`;

export function scan(overrides: Partial<Scan> = {}): Scan {
  const id = overrides.id ?? nextId('scn');
  return {
    id,
    url: 'https://www.example.com/',
    hostname: 'www.example.com',
    runNumber: 1,
    status: 'completed',
    checks: ['images', 'links', 'staging-urls', 'page-health'],
    formMode: 'detect',
    callbackUrl: null,
    metadata: null,
    progress: progress({
      phase: 'completed',
      percent: 100,
      pagesDone: 20,
      pagesTotal: 20,
      elapsedSeconds: 252,
    }),
    summary: { healthScore: 82, pages: 20, critical: 3, warnings: 11, passed: 12 },
    triggeredBy: { type: 'api_key', id: 'key_000000000001', name: 'n8n production' },
    triggeredByType: 'manual_api',
    website: null,
    pageSelectionMode: 'full',
    errorMessage: null,
    createdAt: '2026-09-18T10:00:00.000Z',
    startedAt: '2026-09-18T10:00:05.000Z',
    finishedAt: '2026-09-18T10:04:17.000Z',
    statusUrl: `http://qa.test/api/v1/scans/${id}`,
    reportUrl: `http://qa.test/scans/${id}`,
    ...overrides,
  };
}

export function detail(overrides: Partial<ScanDetail> = {}): ScanDetail {
  return {
    ...scan(),
    checkResults: [
      { checkType: 'images', pagesChecked: 20, issuesFound: 2 },
      { checkType: 'links', pagesChecked: 20, issuesFound: 0 },
      { checkType: 'page-health', pagesChecked: 20, issuesFound: 1 },
    ],
    previousScan: null,
    scoreChange: null,
    fixedIssueCount: 0,
    ...overrides,
  };
}

export function issue(overrides: Partial<Issue> = {}): Issue {
  const id = overrides.id ?? nextId('iss');
  return {
    id,
    scanId: 'scn_000000000001',
    pageId: 'pg_000000000001',
    pageUrl: 'https://www.example.com/about',
    checkType: 'images',
    severity: 'critical',
    fingerprint: 'fp-1',
    message: 'Image failed to load (HTTP 404).',
    selector: 'main .gallery img:nth-of-type(3)',
    resourceUrl: 'https://www.example.com/media/oak.jpg',
    evidence: { rule: 'images.broken', httpStatus: 404 },
    screenshotUrl: null,
    state: 'open',
    ignoreNote: null,
    comparison: null,
    createdAt: '2026-09-18T10:01:00.000Z',
    ...overrides,
  };
}

export function group(overrides: Partial<GroupedIssue> = {}): GroupedIssue {
  const sample = overrides.sample ?? issue();
  return {
    fingerprint: sample.fingerprint,
    checkType: sample.checkType,
    severity: sample.severity,
    message: sample.message,
    affectedPages: 3,
    occurrences: 3,
    state: 'open',
    comparison: null,
    sample,
    ...overrides,
  };
}

export function scanPage(overrides: Partial<ScanPage> = {}): ScanPage {
  return {
    id: nextId('pg'),
    scanId: 'scn_000000000001',
    url: 'https://www.example.com/about',
    status: 'done',
    httpStatus: 200,
    durationMs: 900,
    template: null,
    criticalCount: 1,
    warningCount: 0,
    ...overrides,
  };
}

export function pageOf<T>(items: T[], nextCursor: string | null = null): Page<T> {
  return { items, nextCursor };
}

export function session(role: 'admin' | 'member' = 'admin'): SessionResponse {
  return {
    user: {
      id: 'usr_000000000001',
      email: 'dana@example.com',
      name: 'Dana',
      role,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    scopes: ['scans:read', 'scans:write', 'forms:submit'],
  };
}

export function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultChecks: ['images', 'links', 'staging-urls', 'page-health'],
    defaultFormMode: 'detect',
    formTestEmail: 'qa-test@example.com',
    webhookSecretPreview: '••••••••cdef',
    maxPages: 2000,
    pageConcurrency: 5,
    stagingPatterns: ['staging.', '.netlify.app'],
    ...overrides,
  };
}

export function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: nextId('key'),
    name: 'n8n production',
    prefix: 'bcn_7Hk2mP9x',
    scopes: ['scans:read', 'scans:write'],
    createdAt: '2026-09-01T09:00:00.000Z',
    lastUsedAt: '2026-09-18T10:00:00.000Z',
    revokedAt: null,
    createdByName: 'Dana',
    ...overrides,
  };
}

export function domain(overrides: Partial<AllowedDomain> = {}): AllowedDomain {
  return {
    id: nextId('dom'),
    hostname: '*.example.com',
    note: 'Client site',
    createdAt: '2026-09-01T09:00:00.000Z',
    createdByName: 'Dana',
    ...overrides,
  };
}

export function recipient(overrides: Partial<WebsiteRecipient> = {}): WebsiteRecipient {
  const id = overrides.id ?? nextId('rcp');
  return {
    id,
    email: 'owner@example-estates.co.uk',
    name: 'Sam Owner',
    isActive: true,
    notify: 'every_check',
    createdAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

export function website(overrides: Partial<Website> = {}): Website {
  const id = overrides.id ?? nextId('web');
  return {
    id,
    name: 'Example Estates',
    url: 'https://www.example-estates.co.uk/',
    hostname: 'www.example-estates.co.uk',
    owner: { id: 'usr_000000000001', name: 'Dana' },
    checkFrequency: 'monthly',
    scheduleDayOfWeek: null,
    scheduleDayOfMonth: 1,
    scheduleHourUtc: 6,
    pageSelectionMode: 'random_sample',
    staticPageUrls: [],
    pinnedPageUrls: [],
    sampleSize: 8,
    enabledChecks: ['images', 'links', 'seo'],
    formMode: 'validate_only',
    isActive: true,
    emailEnabled: true,
    lastCheckAt: '2026-09-01T06:04:12.000Z',
    nextCheckAt: '2026-10-01T06:00:00.000Z',
    lastRunError: null,
    recipients: [recipient()],
    latest: {
      scanId: 'scn_000000000100',
      runNumber: 7,
      status: 'completed',
      healthScore: 94,
      critical: 0,
      warnings: 3,
      pages: 8,
      finishedAt: '2026-09-01T06:04:12.000Z',
      scoreChange: 4,
      triggeredByType: 'scheduled',
    },
    pagesEverChecked: 41,
    activeScanId: null,
    emailStatus: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-09-01T06:04:12.000Z',
    ...overrides,
  };
}

export function historyItem(overrides: Partial<WebsiteHistoryItem> = {}): WebsiteHistoryItem {
  return {
    scanId: nextId('scn'),
    runNumber: 1,
    triggeredByType: 'scheduled',
    healthScore: 90,
    critical: 0,
    warnings: 2,
    pages: 8,
    startedAt: '2026-09-01T06:00:05.000Z',
    finishedAt: '2026-09-01T06:04:12.000Z',
    ...overrides,
  };
}

export function emailDelivery(overrides: Partial<EmailDelivery> = {}): EmailDelivery {
  return {
    id: nextId('eml'),
    scanId: 'scn_000000000100',
    email: 'owner@example-estates.co.uk',
    subject: '✅ www.example-estates.co.uk — health score 94 (no new issues)',
    status: 'sent',
    attempts: 1,
    provider: 'resend',
    providerMessageId: 'msg_1',
    error: null,
    createdAt: '2026-09-01T06:04:20.000Z',
    sentAt: '2026-09-01T06:04:22.000Z',
    ...overrides,
  };
}
