import { Prisma, type Db } from '@beacon/db';
import type { CheckType, Severity } from '@beacon/shared';

/** Excel reads a CSV as UTF-8 only when it starts with this. */
export const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** Cells that a spreadsheet would run as a formula are prefixed so they stay text. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  const first = text.charAt(0);
  if (first === '=' || first === '+' || first === '-' || first === '@' || first === '\t') {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const CSV_COLUMNS = [
  'severity',
  'check',
  'state',
  'page_url',
  'message',
  'resource_url',
  'selector',
  'found_at',
  'ignore_note',
  'fingerprint',
] as const;

export interface CsvIssue {
  severity: string;
  checkType: string;
  state: string;
  pageUrl: string | null;
  message: string;
  resourceUrl: string | null;
  selector: string | null;
  createdAt: Date;
  ignoreNote: string | null;
  fingerprint: string;
}

export function csvLine(issue: CsvIssue): string {
  return [
    issue.severity,
    issue.checkType,
    issue.state,
    issue.pageUrl,
    issue.message,
    issue.resourceUrl,
    issue.selector,
    issue.createdAt.toISOString(),
    issue.ignoreNote,
    issue.fingerprint,
  ]
    .map(csvCell)
    .join(',');
}

/** Every issue of a scan, most severe first, one row per occurrence. Opens in Excel with a BOM. */
export async function buildIssuesCsv(db: Db, scanId: string): Promise<string> {
  const lines: string[] = [CSV_COLUMNS.join(',')];
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.scanIssue.findMany({
      where: { scanId },
      orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: { page: { select: { url: true } } },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const row of rows) {
      lines.push(csvLine({ ...row, pageUrl: row.page?.url ?? null }));
    }
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1]?.id;
  }
  return `${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`;
}

export interface ReportGroup {
  severity: Severity;
  checkType: CheckType;
  message: string;
  affectedPages: number;
  occurrences: number;
  sampleUrls: string[];
}

interface GroupRow {
  severity: Severity;
  checkType: string;
  message: string;
  affectedPages: number;
  occurrences: number;
  sampleUrls: string[] | null;
}

/**
 * The open problems of a scan, one per fingerprint, most severe and widest first. Asks for one
 * more than `limit` so the caller can say how many were left out.
 */
export async function listReportGroups(
  db: Db,
  scanId: string,
  limit: number,
): Promise<{ groups: ReportGroup[]; omitted: number }> {
  const rows = await db.$queryRaw<GroupRow[]>(Prisma.sql`
    SELECT
      MIN(i."severity")::text AS "severity",
      (array_agg(i."checkType" ORDER BY i."createdAt", i."id"))[1] AS "checkType",
      (array_agg(i."message" ORDER BY i."createdAt", i."id"))[1] AS "message",
      COUNT(DISTINCT i."pageId")::int AS "affectedPages",
      COUNT(*)::int AS "occurrences",
      (array_agg(DISTINCT pp."url") FILTER (WHERE pp."url" IS NOT NULL))[1:3] AS "sampleUrls"
    FROM "ScanIssue" i
    LEFT JOIN "ScanPage" pp ON pp."id" = i."pageId"
    WHERE i."scanId" = ${scanId} AND i."state" = 'open' AND i."severity" <> 'info'
    GROUP BY i."fingerprint"
    ORDER BY MIN(i."severity"), COUNT(DISTINCT i."pageId") DESC, i."fingerprint"
    LIMIT ${limit + 1}`);
  return {
    groups: rows.slice(0, limit).map((row) => ({
      ...row,
      checkType: row.checkType as CheckType,
      sampleUrls: row.sampleUrls ?? [],
    })),
    omitted: Math.max(0, rows.length - limit),
  };
}
