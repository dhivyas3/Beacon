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

/** How often a website is checked. `manual` means only when someone asks. */
export const CHECK_FREQUENCIES = ['manual', 'daily', 'weekly', 'monthly'] as const;
export type CheckFrequency = (typeof CHECK_FREQUENCIES)[number];

/**
 * Which pages a scan checks. `full` discovers and checks every page. `static_list` checks exactly
 * the listed URLs. `random_sample` discovers every page, then checks a sample of them.
 */
export const PAGE_SELECTION_MODES = ['full', 'static_list', 'random_sample'] as const;
export type PageSelectionMode = (typeof PAGE_SELECTION_MODES)[number];

/** Where a scan came from, shown in the dashboard and in history. */
export const TRIGGER_TYPES = ['manual_ui', 'manual_api', 'scheduled', 'n8n', 'monday'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Triggers an API caller may claim for itself with the `source` field. */
export const EXTERNAL_TRIGGER_SOURCES = ['n8n', 'monday'] as const;
export type ExternalTriggerSource = (typeof EXTERNAL_TRIGGER_SOURCES)[number];

/** Progress of a notification: waiting or being retried, delivered, given up on, or deliberately not sent. */
export const DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** What a recipient wants to be emailed about. */
export const NOTIFY_PREFERENCES = ['every_check', 'new_issues_only'] as const;
export type NotifyPreference = (typeof NOTIFY_PREFERENCES)[number];

export const SAMPLE_SIZE = { min: 1, max: 100, default: 10 } as const;
export const MAX_STATIC_PAGES = 50;
export const MAX_PINNED_PAGES = 20;
export const MAX_RECIPIENTS = 20;

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
  website: 'web',
  recipient: 'rcp',
  emailDelivery: 'eml',
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

export const USER_AGENT = 'BeaconBot/1.0 (website health monitor)';

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
  /** One job per finished scan: decides which callbacks and emails it owes. */
  notifications: 'notifications',
  /** One job per email to send, retried on its own. */
  emails: 'emails',
} as const;

/** Payload of a job on the scan queue. The job id is the scan id. */
export interface ScanJobData {
  scanId: string;
}
