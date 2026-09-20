export const CHECK_TYPES = [
  'images',
  'links',
  'staging-urls',
  'forms',
  'page-health',
  'seo',
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const CHECK_LABELS: Record<CheckType, string> = {
  images: 'Images',
  links: 'Links',
  'staging-urls': 'Staging URLs',
  forms: 'Forms',
  'page-health': 'Page health',
  seo: 'SEO',
};

export const FORM_MODES = ['detect', 'validate_only', 'submit'] as const;
export type FormMode = (typeof FORM_MODES)[number];

export const SCAN_STATUSES = [
  'queued',
  'discovering',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const ACTIVE_SCAN_STATUSES = ['queued', 'discovering', 'running'] as const;
export const TERMINAL_SCAN_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export function isActiveStatus(status: ScanStatus): boolean {
  return (ACTIVE_SCAN_STATUSES as readonly string[]).includes(status);
}

export function isTerminalStatus(status: ScanStatus): boolean {
  return (TERMINAL_SCAN_STATUSES as readonly string[]).includes(status);
}

/** Internal stage while a scan has status `running`. */
export const SCAN_STAGES = ['pages', 'links', 'finalising'] as const;
export type ScanStage = (typeof SCAN_STAGES)[number];

export const PAGE_STATUSES = ['pending', 'done', 'error'] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const SEVERITIES = ['critical', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ISSUE_STATES = ['open', 'ignored'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const SCOPES = ['scans:read', 'scans:write', 'forms:submit'] as const;
export type Scope = (typeof SCOPES)[number];

export const WEBHOOK_EVENTS = ['scan.completed', 'scan.failed', 'scan.cancelled'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const COMPARISON_LABELS = ['new', 'still_open'] as const;
export type ComparisonLabel = (typeof COMPARISON_LABELS)[number];

export const ID_PREFIXES = {
  user: 'usr',
  session: 'ses',
  apiKey: 'key',
  domain: 'dom',
  scan: 'scn',
  page: 'pg',
  issue: 'iss',
  checkResult: 'chk',
  webhookDelivery: 'whd',
  link: 'lnk',
  linkSource: 'lns',
} as const;
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/** Hostname patterns that indicate a non-production environment. */
export const DEFAULT_STAGING_PATTERNS = [
  'localhost',
  'staging.',
  'dev.',
  '.netlify.app',
  '.vercel.app',
  '.gatsbyjs.io',
] as const;

/** Query parameters removed by URL normalisation. Prefix entries end with `*`. */
export const TRACKING_PARAMS = [
  'utm_*',
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
] as const;

export const USER_AGENT = 'QAHubBot/1.0 (website QA scan)';

export const PROGRESS_WEIGHTS = {
  discoveryEnd: 5,
  pagesEnd: 85,
  linksEnd: 98,
} as const;

/** Pages that must finish before a percentage based ETA is shown. */
export const ETA_MIN_PAGES = 10;
/** Size of the rolling window used for page and link durations. */
export const ROLLING_WINDOW = 20;
/** Assumed link check duration before any link has been verified. */
export const DEFAULT_LINK_MS = 250;
/** Time budget, in seconds, for finalising (score, screenshots, callbacks). */
export const FINALISING_SECONDS = 5;

export const DEFAULT_SCAN_CHECKS: readonly CheckType[] = CHECK_TYPES;
export const DEFAULT_FORM_MODE: FormMode = 'detect';

/** Scopes granted to a signed-in dashboard user. Admin-only routes check the role separately. */
export function scopesForRole(_role: Role): Scope[] {
  return [...SCOPES];
}

/** BullMQ queue names shared by the API (producer) and the worker (consumer). */
export const QUEUES = {
  scan: 'scan',
  callbacks: 'callbacks',
  maintenance: 'maintenance',
} as const;

/** Payload of a job on the scan queue. The job id is the scan id. */
export interface ScanJobData {
  scanId: string;
}
