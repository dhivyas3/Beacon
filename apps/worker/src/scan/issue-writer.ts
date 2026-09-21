import type { Db, Prisma } from '@beacon/db';
import type { CheckType } from '@beacon/shared';
import { newId } from '@beacon/shared';
import type { IssueDraft, IssueSink } from '../checks/types.js';
import { fingerprintOf } from '../util/fingerprint.js';
import type { ProgressTracker } from './progress.js';

export interface ScreenshotRequest {
  id: string;
  pageId: string | null;
  draft: IssueDraft;
}

export interface AddOptions {
  /** Called once per new issue. Returns the storage key of a screenshot, or null for none. */
  screenshot?: (request: ScreenshotRequest) => Promise<string | null>;
}

/**
 * Stores findings as they are produced, not at the end of the scan.
 *
 * It fingerprints each finding, drops repeats of the same problem on the same page, keeps the
 * running critical and warning counts (scan and page) up to date, and reports them to the progress
 * tracker so the dashboard can show them live.
 */
export class IssueWriter implements IssueSink {
  private readonly seen = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly scanId: string,
    private readonly progress: ProgressTracker,
  ) {}

  async add(
    items: { pageId: string | null; draft: IssueDraft }[],
    checkType: CheckType,
    options: AddOptions = {},
  ): Promise<number> {
    const rows: Prisma.ScanIssueCreateManyInput[] = [];
    const perPage = new Map<string, { critical: number; warning: number }>();
    let critical = 0;
    let warnings = 0;

    for (const { pageId, draft } of items) {
      const subject = draft.subject !== undefined ? draft.subject : (draft.resourceUrl ?? null);
      const fingerprint = fingerprintOf(checkType, draft.rule, subject);
      const key = `${pageId ?? '-'}|${fingerprint}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);

      const id = newId('iss');
      const screenshotPath = options.screenshot
        ? await options.screenshot({ id, pageId, draft }).catch(() => null)
        : null;

      rows.push({
        id,
        scanId: this.scanId,
        pageId,
        checkType,
        severity: draft.severity,
        fingerprint,
        message: draft.message,
        selector: draft.selector ?? null,
        resourceUrl: draft.resourceUrl ?? null,
        evidence: { rule: draft.rule, ...(draft.evidence ?? {}) },
        screenshotPath,
      });

      if (draft.severity === 'critical') critical += 1;
      if (draft.severity === 'warning') warnings += 1;
      if (pageId && draft.severity !== 'info') {
        const counts = perPage.get(pageId) ?? { critical: 0, warning: 0 };
        if (draft.severity === 'critical') counts.critical += 1;
        else counts.warning += 1;
        perPage.set(pageId, counts);
      }
    }

    if (rows.length === 0) return 0;
    await this.db.scanIssue.createMany({ data: rows });
    for (const [pageId, counts] of perPage) {
      await this.db.scanPage.update({
        where: { id: pageId },
        data: {
          criticalCount: { increment: counts.critical },
          warningCount: { increment: counts.warning },
        },
      });
    }
    this.progress.addIssues(critical, warnings);
    return rows.length;
  }
}
