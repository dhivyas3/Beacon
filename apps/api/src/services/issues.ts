import { findPreviousScan, Prisma, type Db } from '@beacon/db';
import {
  computeHealthScore,
  type ComparisonLabel,
  type FixedIssue,
  type GroupedIssue,
  type Issue,
  type ListIssuesQuery,
  type Page,
  type UpdateIssueBody,
} from '@beacon/shared';
import { ApiError, notFound } from '../lib/errors.js';
import { decodeCursor, encodeCursor, paginateById } from '../lib/pagination.js';
import { issueInclude, toIssueDto, type IssueRow, type ViewContext } from './scan-view.js';

interface ScanRef {
  id: string;
  hostname: string;
  websiteId: string | null;
  previousScanId: string | null;
  createdAt: Date;
}

/**
 * Labels fingerprints as `new` or `still_open` relative to the previous completed scan of the
 * same website (or of no website, for one-off scans). Returns null when there is no previous scan, so the UI shows no labels at all.
 */
export async function comparisonLabels(
  db: Db,
  scan: ScanRef,
  fingerprints: string[],
): Promise<Map<string, ComparisonLabel> | null> {
  const previous = await findPreviousScan(db, scan);
  if (!previous) return null;

  const known = new Set(
    (
      await db.scanIssue.findMany({
        where: { scanId: previous.id, fingerprint: { in: fingerprints } },
        distinct: ['fingerprint'],
        select: { fingerprint: true },
      })
    ).map((row) => row.fingerprint),
  );
  return new Map(fingerprints.map((fp) => [fp, known.has(fp) ? 'still_open' : 'new']));
}

function buildWhere(scanId: string, query: ListIssuesQuery): Prisma.ScanIssueWhereInput {
  return {
    scanId,
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.checkType ? { checkType: query.checkType } : {}),
    ...(query.state ? { state: query.state } : {}),
    ...(query.pageId ? { pageId: query.pageId } : {}),
    ...(query.fingerprint ? { fingerprint: query.fingerprint } : {}),
  };
}

export async function listIssues(
  db: Db,
  ctx: ViewContext,
  scan: ScanRef,
  query: ListIssuesQuery,
): Promise<Page<Issue>> {
  const where = buildWhere(scan.id, query);
  const { rows, nextCursor } = await paginateById(query.limit, query.cursor, (args) =>
    db.scanIssue.findMany({
      where,
      orderBy:
        query.sort === 'newest'
          ? [{ createdAt: 'desc' }, { id: 'desc' }]
          : [{ severity: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: issueInclude,
      ...args,
    }),
  );
  const labels = await comparisonLabels(db, scan, [...new Set(rows.map((row) => row.fingerprint))]);
  return {
    items: rows.map((row) => toIssueDto(row, ctx, labels?.get(row.fingerprint) ?? null)),
    nextCursor,
  };
}

interface GroupRow {
  fingerprint: string;
  sampleId: string;
  occurrences: number;
  affectedPages: number;
  allIgnored: boolean;
}

/** Groups identical issues across pages: one row per fingerprint with "affects N pages". */
export async function listGroupedIssues(
  db: Db,
  ctx: ViewContext,
  scan: ScanRef,
  query: ListIssuesQuery,
): Promise<Page<GroupedIssue>> {
  const conditions = [Prisma.sql`i."scanId" = ${scan.id}`];
  if (query.severity) conditions.push(Prisma.sql`i."severity" = ${query.severity}::"Severity"`);
  if (query.checkType) conditions.push(Prisma.sql`i."checkType" = ${query.checkType}`);
  if (query.state) conditions.push(Prisma.sql`i."state" = ${query.state}::"IssueState"`);
  if (query.pageId) conditions.push(Prisma.sql`i."pageId" = ${query.pageId}`);
  if (query.fingerprint) conditions.push(Prisma.sql`i."fingerprint" = ${query.fingerprint}`);

  const offset = query.cursor === undefined ? 0 : Number.parseInt(decodeCursor(query.cursor), 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError(
      'bad_request',
      'The cursor is not valid. Use the nextCursor value from a previous response.',
    );
  }

  const groups = await db.$queryRaw<GroupRow[]>(Prisma.sql`
    SELECT
      i."fingerprint" AS "fingerprint",
      (array_agg(i."id" ORDER BY i."createdAt", i."id"))[1] AS "sampleId",
      COUNT(*)::int AS "occurrences",
      COUNT(DISTINCT i."pageId")::int AS "affectedPages",
      BOOL_AND(i."state" = 'ignored') AS "allIgnored"
    FROM "ScanIssue" i
    WHERE ${Prisma.join(conditions, ' AND ')}
    GROUP BY i."fingerprint"
    ORDER BY MIN(i."severity"), COUNT(DISTINCT i."pageId") DESC, i."fingerprint"
    LIMIT ${query.limit + 1} OFFSET ${offset}`);

  const pageGroups = groups.slice(0, query.limit);
  const samples = await db.scanIssue.findMany({
    where: { id: { in: pageGroups.map((group) => group.sampleId) } },
    include: issueInclude,
  });
  const sampleById = new Map(samples.map((row) => [row.id, row]));
  const labels = await comparisonLabels(
    db,
    scan,
    pageGroups.map((group) => group.fingerprint),
  );

  const items: GroupedIssue[] = [];
  for (const group of pageGroups) {
    const sample = sampleById.get(group.sampleId);
    if (!sample) continue;
    const comparison = labels?.get(group.fingerprint) ?? null;
    const dto = toIssueDto(sample, ctx, comparison);
    items.push({
      fingerprint: group.fingerprint,
      checkType: dto.checkType,
      severity: dto.severity,
      message: dto.message,
      affectedPages: group.affectedPages,
      occurrences: group.occurrences,
      state: group.allIgnored ? 'ignored' : 'open',
      comparison,
      sample: dto,
    });
  }

  return {
    items,
    nextCursor: groups.length > query.limit ? encodeCursor(String(offset + query.limit)) : null,
  };
}

interface FixedRow {
  fingerprint: string;
  checkType: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  affectedPages: number;
}

/**
 * Problems the previous check had that this scan no longer has. A scan of a sample only re-checks
 * some pages, and an issue on a page that was not looked at again is unseen, not fixed, so for
 * those scans only pages present in both scans (and site-wide issues) count.
 */
export async function listFixedIssues(
  db: Db,
  scan: { id: string; pageSelectionMode: 'full' | 'static_list' | 'random_sample' },
  previousScanId: string,
): Promise<FixedIssue[]> {
  const onlyRechecked =
    scan.pageSelectionMode === 'full'
      ? Prisma.empty
      : Prisma.sql`AND (i."pageId" IS NULL OR pp."url" IN (SELECT "url" FROM "ScanPage" WHERE "scanId" = ${scan.id}))`;
  const rows = await db.$queryRaw<FixedRow[]>(Prisma.sql`
    SELECT
      i."fingerprint" AS "fingerprint",
      (array_agg(i."checkType" ORDER BY i."createdAt", i."id"))[1] AS "checkType",
      MIN(i."severity")::text AS "severity",
      (array_agg(i."message" ORDER BY i."createdAt", i."id"))[1] AS "message",
      COUNT(DISTINCT i."pageId")::int AS "affectedPages"
    FROM "ScanIssue" i
    LEFT JOIN "ScanPage" pp ON pp."id" = i."pageId"
    WHERE i."scanId" = ${previousScanId} ${onlyRechecked}
      AND NOT EXISTS (
        SELECT 1 FROM "ScanIssue" c WHERE c."scanId" = ${scan.id} AND c."fingerprint" = i."fingerprint"
      )
    GROUP BY i."fingerprint"
    ORDER BY MIN(i."severity"), COUNT(DISTINCT i."pageId") DESC, i."fingerprint"`);
  return rows.map((row) => ({ ...row, checkType: row.checkType as FixedIssue['checkType'] }));
}

/**
 * Marks an issue ignored or open again. For a completed scan the open critical and warning counts,
 * the affected page's and check's counts and the health score are recomputed, so the report reflects only what
 * still needs attention. Running scans are left alone: the worker counts open issues at the end.
 */
export async function updateIssue(
  db: Db,
  ctx: ViewContext,
  scanId: string,
  issueId: string,
  body: UpdateIssueBody,
): Promise<Issue> {
  const existing = await db.scanIssue.findFirst({ where: { id: issueId, scanId } });
  if (!existing) throw notFound('Issue', issueId);

  const row = await db.$transaction(async (tx): Promise<IssueRow> => {
    const updated = await tx.scanIssue.update({
      where: { id: issueId },
      data: {
        state: body.state,
        ignoreNote: body.state === 'ignored' ? (body.ignoreNote ?? null) : null,
      },
      include: issueInclude,
    });

    const scan = await tx.scan.findUniqueOrThrow({
      where: { id: scanId },
      select: { status: true, pagesTotal: true },
    });
    if (scan.status === 'completed') {
      const [critical, warnings] = await Promise.all([
        tx.scanIssue.count({ where: { scanId, state: 'open', severity: 'critical' } }),
        tx.scanIssue.count({ where: { scanId, state: 'open', severity: 'warning' } }),
      ]);
      await tx.scan.update({
        where: { id: scanId },
        data: {
          criticalCount: critical,
          warningCount: warnings,
          healthScore: computeHealthScore({ critical, warnings, pagesTotal: scan.pagesTotal }),
        },
      });
      // The per-check total shown on the report chips follows the same open-issue rule.
      const checkOpen = await tx.scanIssue.count({
        where: { scanId, checkType: existing.checkType, state: 'open', severity: { not: 'info' } },
      });
      await tx.checkResult.updateMany({
        where: { scanId, checkType: existing.checkType },
        data: { issuesFound: checkOpen },
      });
      if (existing.pageId) {
        const [pageCritical, pageWarnings] = await Promise.all([
          tx.scanIssue.count({
            where: { pageId: existing.pageId, state: 'open', severity: 'critical' },
          }),
          tx.scanIssue.count({
            where: { pageId: existing.pageId, state: 'open', severity: 'warning' },
          }),
        ]);
        await tx.scanPage.update({
          where: { id: existing.pageId },
          data: { criticalCount: pageCritical, warningCount: pageWarnings },
        });
      }
    }
    return updated;
  });

  const scanRef = await db.scan.findUniqueOrThrow({
    where: { id: scanId },
    select: { id: true, hostname: true, websiteId: true, previousScanId: true, createdAt: true },
  });
  const labels = await comparisonLabels(db, scanRef, [row.fingerprint]);
  return toIssueDto(row, ctx, labels?.get(row.fingerprint) ?? null);
}
