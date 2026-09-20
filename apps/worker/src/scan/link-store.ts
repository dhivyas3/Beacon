import type { Db } from '@qa-hub/db';
import { newId } from '@qa-hub/shared';
import { classifyLink } from '../checks/links.js';
import type { IssueSink, LinkCandidate, LinkCollector, LinkVerification } from '../checks/types.js';
import type { UrlChecker } from '../http/url-checker.js';
import type { Logger } from '../logger.js';
import { runPool } from '../util/async.js';
import type { ProgressTracker } from './progress.js';

export interface LinkStoreOptions {
  db: Db;
  scanId: string;
  /** Links on this origin are internal, everything else is external. */
  origin: string;
  checker: UrlChecker;
  progress: ProgressTracker;
  linkConcurrency: number;
  externalConcurrency: number;
  signal: AbortSignal;
  log: Logger;
}

interface KnownLink {
  id: string;
  /** Resolves once the row exists, so sources never reference a link that is not stored yet. */
  inserted: Promise<unknown>;
}

/**
 * Every unique link found during a scan, stored once. Pages register the links they contain while
 * they are checked. When all pages are done, `verifyAll` requests each unique URL exactly once and
 * turns problems into one finding per page that contains the link.
 */
export class LinkStore implements LinkCollector, LinkVerification {
  private readonly known = new Map<string, KnownLink>();
  private readonly sources = new Set<string>();

  constructor(private readonly options: LinkStoreOptions) {}

  private isInternal(url: string): boolean {
    try {
      return new URL(url).origin === this.options.origin;
    } catch {
      return false;
    }
  }

  async register(pageId: string, links: LinkCandidate[]): Promise<void> {
    if (links.length === 0) return;
    const { db, scanId } = this.options;

    const fresh: { id: string; url: string; kind: 'internal' | 'external' }[] = [];
    const waits: Promise<unknown>[] = [];
    const sourceRows: {
      id: string;
      linkId: string;
      pageId: string;
      selector: string | null;
      text: string | null;
    }[] = [];

    // Decide synchronously which links are new, so parallel pages cannot insert the same link twice.
    const created = links.filter((link) => !this.known.has(link.url));
    let insert: Promise<unknown> = Promise.resolve();
    for (const link of created) {
      fresh.push({
        id: newId('lnk'),
        url: link.url,
        kind: this.isInternal(link.url) ? 'internal' : 'external',
      });
    }
    if (fresh.length > 0) {
      insert = db.scanLink.createMany({
        data: fresh.map((row) => ({ ...row, scanId })),
        skipDuplicates: true,
      });
      for (const row of fresh) this.known.set(row.url, { id: row.id, inserted: insert });
      this.options.progress.linksTotal = this.known.size;
    }

    for (const link of links) {
      const entry = this.known.get(link.url);
      if (!entry) continue;
      waits.push(entry.inserted);
      const key = `${entry.id}:${pageId}`;
      if (this.sources.has(key)) continue;
      this.sources.add(key);
      sourceRows.push({
        id: newId('lns'),
        linkId: entry.id,
        pageId,
        selector: link.selector,
        text: link.text || null,
      });
    }

    await Promise.all(waits);
    if (sourceRows.length > 0) {
      await db.scanLinkSource.createMany({ data: sourceRows, skipDuplicates: true });
    }
  }

  async verifyAll(sink: IssueSink): Promise<void> {
    const { db, scanId, checker, progress, signal, log } = this.options;
    const pending = await db.scanLink.findMany({ where: { scanId, state: 'pending' } });
    const internal = pending.filter((link) => link.kind === 'internal');
    const external = pending.filter((link) => link.kind === 'external');
    progress.linksTotal = Math.max(progress.linksTotal, this.known.size);

    const verify = async (link: (typeof pending)[number]): Promise<void> => {
      const isExternal = link.kind === 'external';
      const result = await checker.check(link.url, { external: isExternal });
      if (signal.aborted) return;

      await db.scanLink.update({
        where: { id: link.id },
        data: {
          state: 'done',
          httpStatus: result.status,
          redirectHops: result.hops,
          finalUrl: result.finalUrl,
          error: result.error?.message ?? null,
          checkedAt: new Date(),
        },
      });
      progress.linkChecked(result.durationMs);

      const drafts = classifyLink(result, isExternal);
      if (drafts.length === 0) return;
      const sources = await db.scanLinkSource.findMany({ where: { linkId: link.id } });
      await sink.add(
        sources.flatMap((source) =>
          drafts.map((draft) => ({
            pageId: source.pageId,
            draft: {
              ...draft,
              selector: source.selector,
              evidence: { ...draft.evidence, linkText: source.text },
            },
          })),
        ),
        'links',
      );
    };

    const onError = (error: unknown, link: (typeof pending)[number]): void => {
      log.warn({ err: error, url: link.url }, 'link verification failed');
    };
    await Promise.all([
      runPool(internal, this.options.linkConcurrency, verify, { signal, onError }),
      runPool(external, this.options.externalConcurrency, verify, { signal, onError }),
    ]);
  }
}
