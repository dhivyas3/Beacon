import { setMaxListeners } from 'node:events';
import { findPreviousScan, loadStoredSettings, type Db, type Prisma } from '@beacon/db';
import { createSafeClient, type HostResolver } from '@beacon/net';
import {
  computeHealthScore,
  computeTemplates,
  isHostAllowed,
  newId,
  normalizeUrl,
  USER_AGENT,
  type CheckType,
  type Progress,
} from '@beacon/shared';
import type { Storage } from '@beacon/storage';
import { checksFor } from '../checks/index.js';
import type { Check, CheckContext, IssueDraft } from '../checks/types.js';
import type { WorkerConfig } from '../config.js';
import {
  DEFAULT_BACKOFF,
  ResourceProbe,
  UrlChecker,
  type BackoffOptions,
} from '../http/url-checker.js';
import type { Logger } from '../logger.js';
import { runPool } from '../util/async.js';
import { HostThrottle, RateLimiter } from '../util/rate-limit.js';
import { BrowserSession } from './browser.js';
import { discoverPages, DiscoveryError, type DiscoveryResult } from './discovery.js';
import { IssueWriter } from './issue-writer.js';
import { LinkStore } from './link-store.js';
import { ProgressTracker } from './progress.js';
import { loadLastChecked, sampledDiscovery, staticPages } from './page-selection.js';
import { PageScreenshots } from './screenshots.js';
import { recordWebsiteOutcome } from './website-outcome.js';

export interface RunnerDeps {
  db: Db;
  config: WorkerConfig;
  storage: Storage;
  log: Logger;
  /** Replaces system DNS. Tests use it to keep every lookup local. */
  resolver?: HostResolver;
  /** Extra Chromium flags. */
  browserArgs?: string[];
  backoff?: BackoffOptions;
  /** How often progress is written. Default 2000 ms. */
  flushMs?: number;
  /** Time allowed for one page, in milliseconds. Default 90 seconds. */
  pageTimeoutMs?: number;
  /** Aborted when the worker is shutting down. Running scans are then failed with a clear message. */
  shutdownSignal?: AbortSignal;
  /** Live progress, for streaming to dashboards. */
  onProgress?: (scanId: string, progress: Progress) => void;
  /** A number in [0, 1) used to sample pages. Tests replace it to be deterministic. */
  random?: () => number;
  /** Called once a scan reaches a final state, to send callbacks. */
  onFinished?: (scanId: string, status: 'completed' | 'failed') => Promise<void> | void;
}

const GENERIC_FAILURE =
  'The scan stopped because of an unexpected error. An admin can find details in the worker logs.';
export const SHUTDOWN_FAILURE = 'The worker restarted while this scan was running. Start it again.';

function sameUrl(a: string, b: string): boolean {
  return (normalizeUrl(a) ?? a) === (normalizeUrl(b) ?? b);
}

/**
 * Runs one scan from start to finish: discovery, page checks in a browser pool, link
 * verification, finalising. Safe to call for a scan that is not `queued` (it does nothing).
 *
 * Cancelling a scan, or the reaper failing it, changes the row's status. The progress tracker
 * notices on its next write, and the scan stops taking new pages, closes its browser and returns
 * without overwriting the status it was given.
 */
export async function runScan(deps: RunnerDeps, scanId: string): Promise<void> {
  const { db, config, storage } = deps;
  const log = deps.log.child({ scanId });

  const claimed = await db.scan.updateMany({
    where: { id: scanId, status: 'queued' },
    data: { status: 'discovering', stage: null, startedAt: new Date(), heartbeatAt: new Date() },
  });
  if (claimed.count === 0) {
    log.info('scan is not queued, nothing to do');
    return;
  }
  const scan = await db.scan.findUniqueOrThrow({ where: { id: scanId } });
  const requested = scan.checks as CheckType[];
  const checks = checksFor(requested);
  const skipped = requested.filter((id) => !checks.some((check) => check.id === id));
  if (skipped.length > 0) log.info({ skipped }, 'checks not available in this version are skipped');

  const controller = new AbortController();
  const signal = controller.signal;
  // Every in-flight request and pause listens for the abort. With parallel pages and links that is
  // routinely more than Node's default of ten, and all of them are released when the work ends.
  setMaxListeners(1000, signal);
  const stopOnShutdown = (): void => controller.abort();
  deps.shutdownSignal?.addEventListener('abort', stopOnShutdown, { once: true });

  const progress = new ProgressTracker(
    db,
    scanId,
    {
      pageConcurrency: scan.pageConcurrency,
      linkConcurrency: scan.linkConcurrency,
      seedDurationMs: scan.seedDurationMs,
      createdAt: scan.createdAt,
      startedAt: new Date(),
    },
    log,
    {
      flushMs: deps.flushMs ?? 2000,
      onLost: () => controller.abort(),
      ...(deps.onProgress ? { publish: (p: Progress) => deps.onProgress?.(scanId, p) } : {}),
    },
  );
  progress.start();

  const failScan = async (message: string): Promise<void> => {
    await progress.flush().catch(() => undefined);
    const failed = await db.scan.updateMany({
      where: { id: scanId, status: { in: ['discovering', 'running'] } },
      data: { status: 'failed', stage: null, errorMessage: message, finishedAt: new Date() },
    });
    if (failed.count === 1) {
      await recordWebsiteOutcome(db, log, scan, { status: 'failed', message });
      await deps.onFinished?.(scanId, 'failed');
    }
  };

  /**
   * The scan was told to stop. If someone else cancelled or failed it, the row already says so and
   * nothing more is written. If the worker itself is shutting down, the scan is failed with a
   * message that says to start it again.
   */
  const halt = async (): Promise<void> => {
    if (deps.shutdownSignal?.aborted) await failScan(SHUTDOWN_FAILURE);
    else log.info('scan stopped by cancellation');
  };

  const client = createSafeClient({
    allowLocal: config.ALLOW_LOCAL_TARGETS,
    userAgent: USER_AGENT,
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
  });
  const limiter = new RateLimiter(config.SCAN_RATE_LIMIT_RPS);
  let browser: BrowserSession | null = null;

  try {
    const settings = await loadStoredSettings(db, {
      defaultChecks: config.DEFAULT_CHECKS,
      defaultFormMode: 'detect',
      formTestEmail: config.FORM_TEST_EMAIL,
      stagingPatterns: config.STAGING_PATTERNS,
    });
    const allowedEntries = (await db.allowedDomain.findMany({ select: { hostname: true } })).map(
      (entry) => entry.hostname,
    );

    // ---- Discovery ----------------------------------------------------------------------------
    // Which pages are checked depends on the scan. A list is used as given, with no discovery. A
    // sample discovers everything, then narrows it. A full scan checks everything it discovers.
    const isAllowed = (hostname: string): boolean => isHostAllowed(hostname, allowedEntries);
    let discovery: DiscoveryResult;
    if (scan.pageSelectionMode === 'static_list') {
      discovery = staticPages({
        url: scan.url,
        pages: scan.staticPageUrls,
        allowedEntries,
      });
      progress.pagesFound = discovery.pages.length;
    } else {
      discovery = await discoverPages({
        startUrl: scan.url,
        maxPages: config.MAX_PAGES,
        client,
        limiter,
        concurrency: scan.pageConcurrency,
        signal,
        log,
        onProgress: (found) => {
          progress.pagesFound = found;
        },
        isHostAllowed: isAllowed,
      });
      if (signal.aborted) return halt();
      if (scan.pageSelectionMode === 'random_sample') {
        const lastChecked = scan.websiteId
          ? await loadLastChecked(db, scan.websiteId, scanId)
          : new Map<string, number>();
        const discovered = discovery.pages.length;
        discovery = sampledDiscovery(discovery, {
          size: scan.sampleSize,
          pinned: scan.pinnedPageUrls,
          lastChecked,
          random: deps.random ?? Math.random,
        });
        log.info({ discovered, sampled: discovery.pages.length }, 'sampled pages to check');
      }
    }

    const templates = computeTemplates(discovery.pages.map((page) => page.url));
    const pageRows = discovery.pages.map((page) => ({
      id: newId('pg'),
      scanId,
      url: page.url,
      template: templates.get(page.url) ?? null,
    }));
    for (let i = 0; i < pageRows.length; i += 1000) {
      await db.scanPage.createMany({ data: pageRows.slice(i, i + 1000) });
    }

    // The total is fixed here and never changes, so progress cannot move backwards.
    const moved = await db.scan.updateMany({
      where: { id: scanId, status: 'discovering' },
      data: {
        status: 'running',
        stage: 'pages',
        pagesFound: pageRows.length,
        pagesTotal: pageRows.length,
      },
    });
    if (moved.count === 0) return halt();
    progress.status = 'running';
    progress.stage = 'pages';
    progress.pagesFound = pageRows.length;
    progress.pagesTotal = pageRows.length;
    await progress.flush();

    const writer = new IssueWriter(db, scanId, progress);
    if (scan.pageSelectionMode !== 'static_list') {
      await writeDiscoveryFindings(writer, requested, discovery, pageRows);
    }

    // ---- Pages --------------------------------------------------------------------------------
    browser = await BrowserSession.launch({
      allowLocal: config.ALLOW_LOCAL_TARGETS,
      ...(deps.resolver ? { resolver: deps.resolver } : {}),
      ...(deps.browserArgs ? { args: deps.browserArgs } : {}),
    });

    const checker = new UrlChecker({
      client,
      limiter,
      hostThrottle: new HostThrottle(config.EXTERNAL_HOST_DELAY_MS),
      signal,
      backoff: deps.backoff ?? DEFAULT_BACKOFF,
    });
    const probeCache = new ResourceProbe(checker);
    const links = new LinkStore({
      db,
      scanId,
      origin: discovery.origin,
      checker,
      progress,
      linkConcurrency: scan.linkConcurrency,
      externalConcurrency: config.EXTERNAL_LINK_CONCURRENCY,
      signal,
      log,
    });
    const scanInfo = {
      id: scanId,
      rootUrl: discovery.rootUrl,
      origin: discovery.origin,
      hostname: new URL(discovery.rootUrl).hostname,
      checks: requested,
      formMode: scan.formMode,
    };
    const checkSettings = {
      stagingPatterns: settings.stagingPatterns,
      formTestEmail: settings.formTestEmail,
    };
    const isInternal = (url: string): boolean => {
      try {
        return new URL(url).origin === discovery.origin;
      } catch {
        return false;
      }
    };
    const session = browser;

    const processPage = async (row: (typeof pageRows)[number]): Promise<void> => {
      const started = Date.now();
      const pageSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(deps.pageTimeoutMs ?? 90_000),
      ]);
      await limiter.take(signal);
      let loaded: Awaited<ReturnType<BrowserSession['load']>>;
      try {
        loaded = await session.load(row.url, pageSignal);
      } catch (error) {
        if (signal.aborted) return;
        const message = pageSignal.aborted
          ? 'The page took too long to check.'
          : 'The page could not be checked.';
        log.warn({ err: error, url: row.url }, 'page load failed');
        await writer.add([{ pageId: row.id, draft: loadFailure(message) }], 'page-health');
        await markPage(db, row.id, 'error', null, Date.now() - started);
        progress.pageDone(Date.now() - started);
        return;
      }

      try {
        if (signal.aborted) return;
        const { observation, dom } = loaded;
        // A page that redirects elsewhere is covered by link checks, and the target is scanned
        // on its own, so running the checks again would only duplicate findings.
        const redirected =
          observation.loadError === null && !sameUrl(observation.finalUrl, row.url);
        const drafts: { check: Check; draft: IssueDraft }[] = [];

        if (!redirected) {
          const context: CheckContext = {
            scan: scanInfo,
            settings: checkSettings,
            page: { id: row.id, url: row.url },
            observation,
            dom,
            browserPage: loaded.page,
            probe: (url) => probeCache.check(url, { external: !isInternal(url) }),
            links,
            isInternal,
            signal: pageSignal,
            log,
          };
          for (const check of checks) {
            try {
              for (const draft of await check.run(context)) drafts.push({ check, draft });
            } catch (error) {
              if (signal.aborted) return;
              log.warn({ err: error, check: check.id, url: row.url }, 'check failed on page');
            }
          }
        }

        const screenshots = new PageScreenshots(loaded.page, storage, scanId, signal);
        for (const check of checks) {
          const items = drafts
            .filter((entry) => entry.check.id === check.id)
            .map((entry) => ({ pageId: row.id, draft: entry.draft }));
          if (items.length > 0) {
            await writer.add(items, check.id, { screenshot: (r) => screenshots.forIssue(r) });
          }
        }

        const failed = observation.loadError !== null;
        await markPage(
          db,
          row.id,
          failed ? 'error' : 'done',
          observation.status,
          Date.now() - started,
        );
        progress.pageDone(Date.now() - started);
      } finally {
        await loaded.close();
      }
    };

    await runPool(pageRows, scan.pageConcurrency, processPage, {
      signal,
      onError: (error, row) => {
        if (!signal.aborted) log.error({ err: error, url: row.url }, 'page processing crashed');
      },
    });
    if (signal.aborted) return halt();
    await browser.close();
    browser = null;

    // ---- Site-wide steps: link verification and any other finalize hooks -----------------------
    progress.stage = 'links';
    await db.scan.updateMany({
      where: { id: scanId, status: 'running' },
      data: { stage: 'links' },
    });
    await progress.flush();
    for (const check of checks) {
      if (!check.finalize) continue;
      await check.finalize({
        scan: scanInfo,
        settings: checkSettings,
        sink: writer,
        links,
        signal,
        log,
      });
      if (signal.aborted) return halt();
    }

    // ---- Finalise ------------------------------------------------------------------------------
    progress.stage = 'finalising';
    await progress.flush();
    const [critical, warnings, passed, grouped] = await Promise.all([
      db.scanIssue.count({ where: { scanId, state: 'open', severity: 'critical' } }),
      db.scanIssue.count({ where: { scanId, state: 'open', severity: 'warning' } }),
      db.scanPage.count({
        where: { scanId, status: 'done', criticalCount: 0, warningCount: 0 },
      }),
      db.scanIssue.groupBy({
        by: ['checkType', 'severity'],
        where: { scanId, state: 'open' },
        _count: { _all: true },
      }),
    ]);

    const issuesByCheck = new Map<string, number>();
    for (const row of grouped) {
      if (row.severity === 'info') continue;
      issuesByCheck.set(row.checkType, (issuesByCheck.get(row.checkType) ?? 0) + row._count._all);
    }
    // A result for every check that ran, so the report can show what passed, plus any check that
    // reported findings on its own (discovery findings count towards `seo`).
    const resultTypes = new Set<string>([
      ...checks.map((check) => check.id),
      ...issuesByCheck.keys(),
    ]);
    await db.checkResult.createMany({
      data: [...resultTypes].map((checkType) => ({
        id: newId('chk'),
        scanId,
        checkType,
        pagesChecked: progress.pagesDone,
        issuesFound: issuesByCheck.get(checkType) ?? 0,
      })),
      skipDuplicates: true,
    });

    const previous = await findPreviousScan(db, { ...scan, previousScanId: null });
    const done = await db.scan.updateMany({
      where: { id: scanId, status: 'running' },
      data: {
        status: 'completed',
        previousScanId: previous?.id ?? null,
        stage: null,
        criticalCount: critical,
        warningCount: warnings,
        passedCount: passed,
        pagesDone: progress.pagesDone,
        linksTotal: progress.linksTotal,
        linksChecked: progress.linksChecked,
        healthScore: computeHealthScore({ critical, warnings, pagesTotal: pageRows.length }),
        progressPercent: 100,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
    if (done.count === 1) {
      log.info({ critical, warnings, pages: pageRows.length }, 'scan completed');
      await recordWebsiteOutcome(db, log, scan, { status: 'completed' });
      await deps.onFinished?.(scanId, 'completed');
    }
  } catch (error) {
    if (signal.aborted) return halt();
    const message = error instanceof DiscoveryError ? error.message : GENERIC_FAILURE;
    if (!(error instanceof DiscoveryError)) log.error({ err: error }, 'scan failed');
    await failScan(message);
  } finally {
    progress.stop();
    deps.shutdownSignal?.removeEventListener('abort', stopOnShutdown);
    await browser?.close();
    await client.close();
  }
}

function loadFailure(message: string): IssueDraft {
  return {
    rule: 'page-health.load-failed',
    severity: 'critical',
    message,
    subject: null,
    evidence: { error: message },
  };
}

async function markPage(
  db: Db,
  pageId: string,
  status: 'done' | 'error',
  httpStatus: number | null,
  durationMs: number,
): Promise<void> {
  const data: Prisma.ScanPageUpdateInput = { status, httpStatus, durationMs };
  await db.scanPage.update({ where: { id: pageId }, data });
}

/**
 * Findings that come from discovery itself rather than from looking at a page. A page reachable by
 * links but absent from the sitemap is a warning. If there is no sitemap at all, saying so once is
 * more useful than one warning per page.
 */
async function writeDiscoveryFindings(
  writer: IssueWriter,
  requested: readonly CheckType[],
  discovery: DiscoveryResult,
  pageRows: { id: string; url: string }[],
): Promise<void> {
  if (!requested.includes('seo')) return;
  const idByUrl = new Map(pageRows.map((row) => [row.url, row.id]));

  if (!discovery.sitemapFound) {
    await writer.add(
      [
        {
          pageId: null,
          draft: {
            rule: 'seo.no-sitemap',
            severity: 'warning',
            message:
              'No sitemap.xml was found. A sitemap helps search engines discover every page.',
            subject: null,
            evidence: { robotsTxtFound: discovery.robots.found },
          },
        },
      ],
      'seo',
    );
    return;
  }

  const items = discovery.pages
    .filter((page) => page.foundByCrawl && !page.inSitemap)
    .flatMap((page) => {
      const pageId = idByUrl.get(page.url);
      return pageId
        ? [
            {
              pageId,
              draft: {
                rule: 'seo.not-in-sitemap',
                severity: 'warning' as const,
                message: 'This page is linked from the site but missing from the sitemap.',
                subject: null,
                resourceUrl: page.url,
                evidence: { sitemaps: discovery.sitemapUrls },
              },
            },
          ]
        : [];
    });
  if (items.length > 0) await writer.add(items, 'seo');
}
