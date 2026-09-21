import { findPreviousScan, Prisma, type Db } from '@beacon/db';
import type {
  EmailData,
  EmailIssue,
  EmailLinks,
  FailedEmailData,
  HistoryPoint,
  ReportEmailData,
} from '@beacon/email-templates';
import { CHECK_LABELS, signRecipientToken, type CheckType, type TriggerType } from '@beacon/shared';

export interface ReportContext {
  publicUrl: string;
  /** The secret that signs the links in emails. */
  secret: string;
}

interface Recipient {
  id: string;
  email: string;
  name?: string | null;
}

const TRIGGER_LABEL: Record<TriggerType, string> = {
  manual_ui: 'Started from the dashboard',
  manual_api: 'Started through the API',
  scheduled: 'Scheduled check',
  n8n: 'Started by n8n',
  monday: 'Started by monday.com',
};

/** How many past checks feed the sparkline. */
const HISTORY = 12;
/** More distinct issues than this are counted as this many. The email lists ten anyway. */
const MAX_GROUPS = 5000;

function base(publicUrl: string): string {
  return publicUrl.replace(/\/$/, '');
}

/** The links in one recipient's email. The unsubscribe link asks first, because a mail scanner opens links. */
export async function linksFor(
  ctx: ReportContext,
  scanId: string,
  websiteId: string,
  recipientId: string,
): Promise<{ links: EmailLinks; listUnsubscribeUrl: string }> {
  const token = await signRecipientToken(ctx.secret, recipientId);
  const preferences = `${base(ctx.publicUrl)}/api/v1/email/preferences/${token}`;
  return {
    links: {
      report: `${base(ctx.publicUrl)}/scans/${scanId}`,
      website: `${base(ctx.publicUrl)}/websites/${websiteId}`,
      preferences,
      unsubscribe: `${preferences}?choice=unsubscribe`,
    },
    // The address a mail client POSTs to, with no page in between, as RFC 8058 describes.
    listUnsubscribeUrl: `${preferences}/unsubscribe`,
  };
}

function pathOf(url: string | null): string {
  if (url === null) return '';
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return url;
  }
}

function selectionLabel(mode: string, pages: number, staticCount: number): string {
  if (mode === 'static_list')
    return `${staticCount} chosen ${staticCount === 1 ? 'page' : 'pages'}`;
  if (mode === 'random_sample')
    return `${pages} ${pages === 1 ? 'page' : 'pages'} sampled, homepage included`;
  return `All ${pages} ${pages === 1 ? 'page' : 'pages'}`;
}

interface IssueGroup {
  severity: 'critical' | 'warning';
  checkType: string;
  message: string;
  pageUrl: string | null;
  pages: number;
  isNew: boolean;
}

/**
 * The scan's open critical and warning issues, one per distinct problem. A broken footer link on
 * two hundred pages is one problem "on 200 pages", not two hundred rows. A problem is new when the
 * previous check did not have it. With no previous check nothing is new, because there is nothing
 * to be new compared with.
 */
async function issueGroups(
  db: Db,
  scanId: string,
  previousId: string | null,
): Promise<IssueGroup[]> {
  const rows = await db.$queryRaw<
    {
      severity: string;
      checkType: string;
      message: string;
      pageUrl: string | null;
      pages: number;
      isNew: boolean;
    }[]
  >(Prisma.sql`
    WITH grouped AS (
      SELECT DISTINCT ON (i."fingerprint")
        i."fingerprint", i."severity"::text AS severity, i."checkType", i."message",
        p."url" AS "pageUrl", i."createdAt",
        COUNT(*) OVER (PARTITION BY i."fingerprint")::int AS pages
      FROM "ScanIssue" i
      LEFT JOIN "ScanPage" p ON p."id" = i."pageId"
      WHERE i."scanId" = ${scanId} AND i."state" = 'open' AND i."severity" IN ('critical', 'warning')
      ORDER BY i."fingerprint", (i."severity" = 'critical') DESC, i."createdAt", i."id"
    )
    SELECT g.severity, g."checkType", g."message", g."pageUrl", g.pages,
      ${previousId}::text IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "ScanIssue" q WHERE q."scanId" = ${previousId} AND q."fingerprint" = g."fingerprint"
      ) AS "isNew"
    FROM grouped g
    ORDER BY "isNew" DESC, (g.severity = 'critical') DESC, g.pages DESC, g."createdAt", g."fingerprint"
    LIMIT ${MAX_GROUPS}`);
  return rows.map((row) => ({
    ...row,
    severity: row.severity === 'critical' ? 'critical' : 'warning',
  }));
}

/**
 * The scores of a website's last completed checks, oldest first. The email is sent after the check
 * completes, so the newest of them is the check the email is about.
 */
async function scoreHistory(db: Db, websiteId: string): Promise<HistoryPoint[]> {
  const rows = await db.scan.findMany({
    where: {
      websiteId,
      status: 'completed',
      healthScore: { not: null },
      finishedAt: { not: null },
    },
    orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
    take: HISTORY,
    select: { healthScore: true, finishedAt: true },
  });
  return rows.reverse().map((row) => ({
    score: row.healthScore as number,
    at: (row.finishedAt as Date).toISOString(),
  }));
}

/**
 * Everything one recipient's email needs, or null when the scan is not a check of a website, is
 * still running, or was cancelled. Completed checks give a report, failed checks a failure notice.
 */
export async function buildEmailData(
  db: Db,
  ctx: ReportContext,
  scanId: string,
  recipient: Recipient,
): Promise<{ data: EmailData; listUnsubscribeUrl: string } | null> {
  const scan = await db.scan.findUnique({ where: { id: scanId }, include: { website: true } });
  if (!scan?.website || scan.finishedAt === null) return null;
  if (scan.status !== 'completed' && scan.status !== 'failed') return null;

  const website = scan.website;
  const { links, listUnsubscribeUrl } = await linksFor(ctx, scan.id, website.id, recipient.id);
  const common = {
    website: { name: website.name, url: website.url, hostname: website.hostname },
    recipient: { name: recipient.name ?? null, email: recipient.email },
    links,
  };
  const trigger = TRIGGER_LABEL[scan.triggeredByType];

  if (scan.status === 'failed') {
    const lastCompleted = await db.scan.findFirst({
      where: { websiteId: website.id, status: 'completed', id: { not: scan.id } },
      orderBy: { finishedAt: 'desc' },
      select: { healthScore: true },
    });
    const failed: FailedEmailData = {
      ...common,
      kind: 'failed',
      check: { runNumber: scan.runNumber, finishedAt: scan.finishedAt.toISOString(), trigger },
      reason: scan.errorMessage ?? 'The check stopped because of an unexpected error.',
      lastScore: lastCompleted?.healthScore ?? null,
    };
    return { data: failed, listUnsubscribeUrl };
  }

  const previous = await findPreviousScan(db, scan);
  const groups = await issueGroups(db, scan.id, previous?.id ?? null);

  const newCritical = groups.filter((g) => g.isNew && g.severity === 'critical').length;
  const newWarnings = groups.filter((g) => g.isNew && g.severity === 'warning').length;
  const newTotal = newCritical + newWarnings;
  const issues: EmailIssue[] = groups.slice(0, 10).map((group) => ({
    severity: group.severity,
    check: CHECK_LABELS[group.checkType as CheckType] ?? group.checkType,
    page: pathOf(group.pageUrl),
    message: group.message,
    pages: group.pages,
    isNew: group.isNew,
  }));

  const history = await scoreHistory(db, website.id);
  const report: ReportEmailData = {
    ...common,
    kind: 'report',
    check: {
      runNumber: scan.runNumber,
      finishedAt: scan.finishedAt.toISOString(),
      pagesChecked: scan.pagesTotal,
      selection: selectionLabel(
        scan.pageSelectionMode,
        scan.pagesTotal,
        scan.staticPageUrls.length,
      ),
      trigger,
    },
    score: scan.healthScore ?? 0,
    previousScore: previous?.healthScore ?? null,
    critical: scan.criticalCount,
    warnings: scan.warningCount,
    history,
    counts: {
      newCritical,
      newWarnings,
      stillOpen: groups.length - newTotal,
      totalOpen: groups.length,
    },
    issues,
    isFirstCheck: previous === null,
  };
  return { data: report, listUnsubscribeUrl };
}
