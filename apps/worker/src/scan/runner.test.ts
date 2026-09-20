import { computeHealthScore } from '@qa-hub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorld,
  insertQueuedScan,
  OFFLINE_BROWSER_ARGS,
  offlineResolver,
  silentLog,
  waitFor,
  type TestWorld,
} from '../test/harness.js';
import { runScan, type RunnerDeps } from './runner.js';

let world: TestWorld;

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    db: world.db,
    config: world.config,
    storage: world.storage,
    log: silentLog,
    resolver: offlineResolver,
    browserArgs: OFFLINE_BROWSER_ARGS,
    backoff: { maxRetries: 3, baseMs: 5, maxMs: 50 },
    flushMs: 50,
    ...overrides,
  };
}

beforeAll(async () => {
  world = await createWorld();
}, 120_000);

afterAll(async () => {
  await world.close();
});

interface Sample {
  status: string;
  stage: string | null;
  percent: number;
  pagesDone: number;
  pagesTotal: number;
  heartbeatAt: number | null;
}

/** Samples the scan row while it runs, the way the dashboard would see it. */
function watch(scanId: string): { stop(): Promise<Sample[]> } {
  const samples: Sample[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const row = await world.db.scan.findUnique({ where: { id: scanId } });
      if (row) {
        samples.push({
          status: row.status,
          stage: row.stage,
          percent: row.progressPercent,
          pagesDone: row.pagesDone,
          pagesTotal: row.pagesTotal,
          heartbeatAt: row.heartbeatAt?.getTime() ?? null,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      const last = await world.db.scan.findUnique({ where: { id: scanId } });
      if (last) {
        samples.push({
          status: last.status,
          stage: last.stage,
          percent: last.progressPercent,
          pagesDone: last.pagesDone,
          pagesTotal: last.pagesTotal,
          heartbeatAt: last.heartbeatAt?.getTime() ?? null,
        });
      }
      return samples;
    },
  };
}

const ruleOf = (issue: { evidence: unknown }): string => (issue.evidence as { rule: string }).rule;

describe('a complete scan of the fixture site', () => {
  let scanId: string;
  let samples: Sample[];
  let site: string;
  let external: string;

  beforeAll(async () => {
    site = world.sites.site.url;
    external = world.sites.external.url;
    scanId = await insertQueuedScan(world.db, `${site}/`, {
      checks: ['images', 'links', 'staging-urls', 'page-health', 'seo'],
    });
    world.sites.site.reset();
    world.sites.external.reset();

    const watcher = watch(scanId);
    await runScan(deps(), scanId);
    samples = await watcher.stop();
  }, 180_000);

  const at = (path: string) => `${site}${path}`;

  async function issues() {
    return world.db.scanIssue.findMany({ where: { scanId }, include: { page: true } });
  }

  it('completes with consistent totals and a health score', async () => {
    const scan = await world.db.scan.findUniqueOrThrow({ where: { id: scanId } });
    expect(scan.status).toBe('completed');
    expect(scan.stage).toBeNull();
    expect(scan.errorMessage).toBeNull();
    expect(scan.finishedAt).not.toBeNull();
    expect(scan.pagesTotal).toBeGreaterThanOrEqual(17);
    expect(scan.pagesDone).toBe(scan.pagesTotal);
    expect(scan.pagesFound).toBe(scan.pagesTotal);

    const all = await issues();
    const critical = all.filter((i) => i.severity === 'critical' && i.state === 'open').length;
    const warnings = all.filter((i) => i.severity === 'warning' && i.state === 'open').length;
    expect(scan.criticalCount).toBe(critical);
    expect(scan.warningCount).toBe(warnings);
    expect(critical).toBeGreaterThan(10);
    expect(scan.healthScore).toBe(
      computeHealthScore({ critical, warnings, pagesTotal: scan.pagesTotal }),
    );

    const clean = await world.db.scanPage.count({
      where: { scanId, status: 'done', criticalCount: 0, warningCount: 0 },
    });
    expect(scan.passedCount).toBe(clean);
    expect(scan.linksChecked).toBe(scan.linksTotal);
  });

  it('never moves progress backwards and fixes the page total once discovery ends', () => {
    const percents = samples.map((sample) => sample.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(samples.at(-1)?.status).toBe('completed');

    const totals = new Set(samples.map((s) => s.pagesTotal).filter((total) => total > 0));
    expect(totals.size).toBe(1);

    const done = samples.map((s) => s.pagesDone);
    expect(done).toEqual([...done].sort((a, b) => a - b));

    // queued/discovering -> running -> completed, and the page and link stages were both seen.
    const statuses = [...new Set(samples.map((s) => s.status))];
    expect(statuses).toEqual(expect.arrayContaining(['running', 'completed']));
    expect(statuses.indexOf('running')).toBeLessThan(statuses.indexOf('completed'));
    const stages = new Set(samples.map((s) => s.stage));
    expect(stages.has('pages')).toBe(true);
    expect(stages.has('links')).toBe(true);
  });

  it('keeps a heartbeat while the scan runs', () => {
    const beats = new Set(samples.map((s) => s.heartbeatAt).filter((t) => t !== null));
    expect(beats.size).toBeGreaterThanOrEqual(3);
  });

  it('records a check result for every check that ran, proving it ran', async () => {
    const results = await world.db.checkResult.findMany({ where: { scanId } });
    const byCheck = new Map(results.map((r) => [r.checkType, r]));
    expect([...byCheck.keys()].sort()).toEqual([
      'images',
      'links',
      'page-health',
      'seo',
      'staging-urls',
    ]);
    const scan = await world.db.scan.findUniqueOrThrow({ where: { id: scanId } });
    for (const result of results) expect(result.pagesChecked).toBe(scan.pagesTotal);

    const all = await issues();
    for (const [checkType, result] of byCheck) {
      const expected = all.filter(
        (i) => i.checkType === checkType && i.severity !== 'info' && i.state === 'open',
      ).length;
      expect(result.issuesFound, checkType).toBe(expected);
    }
  });

  it('discovers pages from the sitemap index and by crawling, and groups them by template', async () => {
    const pages = await world.db.scanPage.findMany({ where: { scanId } });
    const urls = new Set(pages.map((p) => p.url));
    for (const path of [
      '/',
      '/about',
      '/sitemap-only',
      '/orphan',
      '/products/2',
      '/missing-page',
    ]) {
      expect(urls, path).toContain(path === '/' ? `${site}/` : at(path));
    }
    expect(pages.every((p) => p.status === 'done' || p.status === 'error')).toBe(true);
    expect(pages.filter((p) => p.template === '/products/:slug')).toHaveLength(3);
    expect(pages.find((p) => p.url === at('/missing-page'))?.httpStatus).toBe(404);
  });

  it('finds the image problems on the home page', async () => {
    const home = (await issues()).filter(
      (i) => i.page?.url === `${site}/` && i.checkType === 'images',
    );
    const rules = (rule: string) =>
      home.filter((i) => ruleOf(i) === rule).map((i) => i.resourceUrl);

    expect(rules('images.broken').sort()).toEqual(
      [
        at('/images/hero-missing.jpg'),
        at('/images/lazy-missing.jpg'),
        at('/images/logo-missing.png'),
        'https://cdn.dev.acme-fixture.test/logo.png',
      ].sort(),
    );
    expect(rules('images.broken-srcset')).toEqual([at('/images/srcset-2x-missing.svg')]);
    expect(rules('images.broken-background')).toEqual([at('/images/bg-missing.jpg')]);
    expect(rules('images.missing-alt')).toHaveLength(1);
    expect(home.find((i) => i.resourceUrl?.endsWith('lazy-missing.jpg'))?.severity).toBe(
      'critical',
    );
  });

  it('groups a problem shared by many pages under one fingerprint', async () => {
    const logo = (await issues()).filter(
      (i) => ruleOf(i) === 'images.broken' && i.resourceUrl === at('/images/logo-missing.png'),
    );
    expect(new Set(logo.map((i) => i.pageId)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(logo.map((i) => i.fingerprint)).size).toBe(1);
  });

  it('finds staging urls', async () => {
    const staging = (await issues()).filter((i) => i.checkType === 'staging-urls');
    expect(staging.map((i) => i.resourceUrl).sort()).toEqual([
      'https://acme-fixture.netlify.app/',
      'https://cdn.dev.acme-fixture.test/logo.png',
      'https://staging.acme-fixture.test/pricing',
    ]);
    expect(staging.every((i) => i.severity === 'critical' && i.page?.url === `${site}/`)).toBe(
      true,
    );
  });

  it('finds console errors, exceptions and failing requests', async () => {
    const page = (await issues()).filter((i) => i.page?.url === at('/console-errors'));
    const rules = page.map(ruleOf);
    expect(rules).toEqual(
      expect.arrayContaining([
        'page-health.console-error',
        'page-health.js-exception',
        'page-health.failed-request',
      ]),
    );
    const script = page.find((i) => i.resourceUrl?.endsWith('/js/missing.js'));
    expect(script?.severity).toBe('critical');
  });

  it('reports a 404 page as critical and the scan carries on', async () => {
    const page = (await issues()).filter(
      (i) => i.page?.url === at('/missing-page') && i.checkType === 'page-health',
    );
    expect(page.map((i) => [ruleOf(i), i.severity])).toEqual([
      ['page-health.http-status', 'critical'],
    ]);
  });

  it('verifies each unique link once and turns a broken one into an issue per page that has it', async () => {
    const links = await world.db.scanLink.findMany({ where: { scanId } });
    expect(new Set(links.map((l) => l.url)).size).toBe(links.length);
    expect(links.every((l) => l.state === 'done')).toBe(true);

    const missing = links.filter((l) => l.url === at('/missing-page'));
    expect(missing).toHaveLength(1);
    const sources = await world.db.scanLinkSource.count({ where: { linkId: missing[0]?.id } });
    expect(sources).toBeGreaterThanOrEqual(5);

    const broken = (await issues()).filter(
      (i) => ruleOf(i) === 'links.broken' && i.resourceUrl === at('/missing-page'),
    );
    expect(broken).toHaveLength(sources);
    expect(new Set(broken.map((i) => i.fingerprint)).size).toBe(1);
    expect(broken.every((i) => i.severity === 'critical')).toBe(true);

    // Requested exactly once, however many pages link to it.
    const heads = world.sites.site.requests.filter(
      (r) => r.path === '/missing-page' && r.method === 'HEAD',
    );
    expect(heads).toHaveLength(1);
  });

  it('classifies links: redirect chains, HEAD-hostile servers, external sites and unreachable hosts', async () => {
    const found = (await issues()).filter((i) => i.checkType === 'links');
    const byUrl = (url: string) => found.filter((i) => i.resourceUrl === url).map(ruleOf);

    expect(byUrl(at('/redirect-chain/1'))).toEqual(['links.redirect-chain']);
    expect(found.find((i) => i.resourceUrl === at('/redirect-chain/1'))?.severity).toBe('warning');
    expect(byUrl(at('/old-page'))).toEqual([]); // one redirect is fine
    expect(byUrl(at('/no-head'))).toEqual([]);
    expect(byUrl(at('/forbidden-head'))).toEqual([]);
    expect(byUrl(at('/download.pdf'))).toEqual([]);

    expect(byUrl(`${external}/gone`)).toEqual(['links.broken']);
    expect(byUrl(`${external}/blocked`)).toEqual(['links.unverifiable']);
    expect(found.find((i) => i.resourceUrl === `${external}/blocked`)?.severity).toBe('warning');
    expect(byUrl(`${external}/ok.html`)).toEqual([]);
    expect(byUrl(`${external}/busy`)).toEqual([]); // 429 twice, then fine after backing off
    expect(world.sites.external.requests.filter((r) => r.path === '/busy')).toHaveLength(3);

    expect(byUrl('https://staging.acme-fixture.test/pricing')).toEqual(['links.unreachable']);
  });

  it('warns about pages missing from the sitemap', async () => {
    const seo = (await issues()).filter((i) => i.checkType === 'seo');
    const notInSitemap = seo
      .filter((i) => ruleOf(i) === 'seo.not-in-sitemap')
      .map((i) => i.page?.url);
    expect(notInSitemap).toContain(at('/orphan'));
    expect(notInSitemap).not.toContain(at('/about'));
    expect(seo.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('does not run checks on a page that only redirects', async () => {
    const pages = await world.db.scanPage.findMany({
      where: { scanId, url: { in: [at('/old-page'), at('/redirect-chain/1')] } },
    });
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.status).toBe('done');
      const own = (await issues()).filter(
        (i) => i.pageId === page.id && i.checkType !== 'links' && i.checkType !== 'seo',
      );
      expect(own).toEqual([]);
    }
  });

  it('stores highlighted screenshots for critical issues with an element, and none for warnings', async () => {
    const all = await issues();
    const shot = all.find((i) => ruleOf(i) === 'images.broken' && i.screenshotPath);
    expect(shot).toBeDefined();
    const stored = await world.storage.get(shot?.screenshotPath ?? '');
    expect(stored?.contentType).toBe('image/png');
    expect(stored?.data.subarray(1, 4).toString()).toBe('PNG');

    expect(
      all.filter((i) => i.severity !== 'critical').every((i) => i.screenshotPath === null),
    ).toBe(true);
    // Link findings are made after the pages are closed, so they have no screenshot.
    expect(all.filter((i) => i.checkType === 'links').every((i) => i.screenshotPath === null)).toBe(
      true,
    );

    // The 404 page has no element to outline, so it gets one plain screenshot of the page.
    const notFound = all.find((i) => ruleOf(i) === 'page-health.http-status');
    expect(notFound?.screenshotPath).toBeTruthy();

    const perPage = new Map<string, number>();
    for (const issue of all.filter((i) => i.screenshotPath && i.pageId)) {
      perPage.set(issue.pageId as string, (perPage.get(issue.pageId as string) ?? 0) + 1);
    }
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(6);
  });

  it('identifies itself as QAHubBot on every request', () => {
    const all = [...world.sites.site.requests, ...world.sites.external.requests];
    expect(all.length).toBeGreaterThan(50);
    expect(all.every((request) => request.userAgent.includes('QAHubBot/1.0'))).toBe(true);
  });
});

describe('scan lifecycle', () => {
  it('does nothing for a scan that is not queued', async () => {
    const id = await insertQueuedScan(world.db, `${world.sites.site.url}/`);
    await world.db.scan.update({ where: { id }, data: { status: 'cancelled' } });
    world.sites.site.reset();
    await runScan(deps(), id);
    expect((await world.db.scan.findUniqueOrThrow({ where: { id } })).status).toBe('cancelled');
    expect(world.sites.site.requests).toHaveLength(0);
  });

  it('fails clearly when the site cannot be reached', async () => {
    const dead = await world.sites.site.close().then(() => world.sites.site.url);
    const id = await insertQueuedScan(world.db, `${dead}/`);
    await runScan(deps(), id);
    const scan = await world.db.scan.findUniqueOrThrow({ where: { id } });
    expect(scan.status).toBe('failed');
    expect(scan.errorMessage).toMatch(/^Could not reach http:\/\/127\.0\.0\.1:\d+\//);
    expect(scan.finishedAt).not.toBeNull();
    expect(await world.db.scanPage.count({ where: { scanId: id } })).toBe(0);
    // Restart the fixture for the tests below.
    const fresh = await import('@qa-hub/fixtures');
    world.sites.site = await fresh.startFixtureSite({ externalUrl: world.sites.external.url });
  }, 60_000);

  it('stops when the scan is cancelled, closes its browser and leaves the status alone', async () => {
    const id = await insertQueuedScan(world.db, `${world.sites.site.url}/`, { pageConcurrency: 1 });
    const running = runScan(deps(), id);

    await waitFor(
      async () => (await world.db.scan.findUniqueOrThrow({ where: { id } })).pagesDone >= 1,
      { label: 'the first page to finish' },
    );
    await world.db.scan.updateMany({
      where: { id },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    const cancelledAt = Date.now();
    await running;
    expect(Date.now() - cancelledAt).toBeLessThan(15_000);

    const scan = await world.db.scan.findUniqueOrThrow({ where: { id } });
    expect(scan.status).toBe('cancelled');
    expect(scan.errorMessage).toBeNull();
    expect(scan.pagesDone).toBeLessThan(scan.pagesTotal);
    expect(scan.progressPercent).toBeLessThan(100);

    // Nothing keeps working after the scan returned: no more requests reach the site.
    const before = world.sites.site.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(world.sites.site.requests.length).toBe(before);
  }, 90_000);

  it('fails a running scan with a clear message when the worker shuts down', async () => {
    const id = await insertQueuedScan(world.db, `${world.sites.site.url}/`, { pageConcurrency: 1 });
    const shutdown = new AbortController();
    const running = runScan(deps({ shutdownSignal: shutdown.signal }), id);
    await waitFor(
      async () => (await world.db.scan.findUniqueOrThrow({ where: { id } })).pagesDone >= 1,
      { label: 'the first page to finish' },
    );
    shutdown.abort();
    await running;

    const scan = await world.db.scan.findUniqueOrThrow({ where: { id } });
    expect(scan.status).toBe('failed');
    expect(scan.errorMessage).toMatch(/worker restarted/);
    expect(scan.finishedAt).not.toBeNull();
  }, 90_000);

  it('reports completion to the caller so callbacks can be sent', async () => {
    const id = await insertQueuedScan(world.db, `${world.sites.site.url}/`, {
      checks: ['staging-urls'],
    });
    const finished: [string, string][] = [];
    await runScan(
      deps({ onFinished: (scanId, status) => void finished.push([scanId, status]) }),
      id,
    );
    expect(finished).toEqual([[id, 'completed']]);
  }, 120_000);
});
