import type { Db, Prisma } from '@qa-hub/db';
import {
  computeProgress,
  type ComparisonLabel,
  type Issue,
  type Scan,
  type ScanStage,
} from '@qa-hub/shared';

export const scanInclude = {
  triggeredByUser: { select: { id: true, name: true } },
  triggeredByApiKey: { select: { id: true, name: true } },
} satisfies Prisma.ScanInclude;

export type ScanRow = Prisma.ScanGetPayload<{ include: typeof scanInclude }>;

export const issueInclude = {
  page: { select: { url: true } },
} satisfies Prisma.ScanIssueInclude;

export type IssueRow = Prisma.ScanIssueGetPayload<{ include: typeof issueInclude }>;

export interface ViewContext {
  publicUrl: string;
}

export function statusUrlOf(publicUrl: string, scanId: string): string {
  return `${publicUrl.replace(/\/$/, '')}/api/v1/scans/${scanId}`;
}

export function reportUrlOf(publicUrl: string, scanId: string): string {
  return `${publicUrl.replace(/\/$/, '')}/scans/${scanId}`;
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Position of each queued scan, 1-based, oldest first. */
export async function queuePositions(db: Db): Promise<Map<string, number>> {
  const queued = await db.scan.findMany({
    where: { status: 'queued' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return new Map(queued.map((row, index) => [row.id, index + 1]));
}

/** Maps a scan row to the public `Scan` shape. Progress is always derived by `computeProgress`. */
export function toScanDto(
  row: ScanRow,
  ctx: ViewContext,
  queuePosition: number | null,
  now: Date = new Date(),
): Scan {
  const triggeredBy = row.triggeredByUser
    ? { type: 'user' as const, id: row.triggeredByUser.id, name: row.triggeredByUser.name }
    : row.triggeredByApiKey
      ? { type: 'api_key' as const, id: row.triggeredByApiKey.id, name: row.triggeredByApiKey.name }
      : null;

  return {
    id: row.id,
    url: row.url,
    hostname: row.hostname,
    runNumber: row.runNumber,
    status: row.status,
    checks: row.checks as Scan['checks'],
    formMode: row.formMode,
    callbackUrl: row.callbackUrl,
    metadata: asRecord(row.metadata),
    progress: computeProgress(
      {
        status: row.status,
        stage: row.stage satisfies ScanStage | null,
        pagesFound: row.pagesFound,
        pagesTotal: row.pagesTotal,
        pagesDone: row.pagesDone,
        linksTotal: row.linksTotal,
        linksChecked: row.linksChecked,
        avgPageMs: row.avgPageMs,
        avgLinkMs: row.avgLinkMs,
        pageConcurrency: row.pageConcurrency,
        linkConcurrency: row.linkConcurrency,
        seedDurationMs: row.seedDurationMs,
        progressPercent: row.progressPercent,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        queuePosition,
      },
      now,
    ),
    summary: {
      healthScore: row.healthScore,
      pages: row.pagesTotal,
      critical: row.criticalCount,
      warnings: row.warningCount,
      passed: row.passedCount,
    },
    triggeredBy,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    statusUrl: statusUrlOf(ctx.publicUrl, row.id),
    reportUrl: reportUrlOf(ctx.publicUrl, row.id),
  };
}

export function toIssueDto(
  row: IssueRow,
  ctx: ViewContext,
  comparison: ComparisonLabel | null,
): Issue {
  const evidence =
    row.evidence !== null && typeof row.evidence === 'object' && !Array.isArray(row.evidence)
      ? (row.evidence as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    scanId: row.scanId,
    pageId: row.pageId,
    pageUrl: row.page?.url ?? null,
    checkType: row.checkType as Issue['checkType'],
    severity: row.severity,
    fingerprint: row.fingerprint,
    message: row.message,
    selector: row.selector,
    resourceUrl: row.resourceUrl,
    evidence,
    screenshotUrl:
      row.screenshotPath === null
        ? null
        : `${statusUrlOf(ctx.publicUrl, row.scanId)}/issues/${row.id}/screenshot`,
    state: row.state,
    ignoreNote: row.ignoreNote,
    comparison,
    createdAt: row.createdAt.toISOString(),
  };
}
