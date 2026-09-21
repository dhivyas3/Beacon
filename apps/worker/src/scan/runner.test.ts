import { computeHealthScore, newId } from '@beacon/shared';
import { freePort } from '@beacon/testkit';
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
    const discovery = seo.filter((i) => ruleOf(i).startsWith('seo.not-in-sitemap'));
    expect(discovery.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('checks the SEO basics of every page it scans', async () => {
    const seo = (await issues()).filter((i) => i.checkType === 'seo');
    const rulesOn = (path: string) =>
      seo
        .filter((i) => i.page?.url === at(path))
        .map(ruleOf)
        .filter((rule) => rule !== 'seo.not-in-sitemap')
        .sort();
    expect(rulesOn('/no-meta')).toEqual([
      'seo.canonical-missing',
      'seo.description-missing',
      'seo.h1-missing',
      'seo.lang-missing',
      'seo.noindex',
      'seo.og-missing',
      'seo.title-missing',
    ]);
    expect(seo.find((i) => ruleOf(i) === 'seo.noindex')?.severity).toBe('critical');
    // Complete pages, and pages that share a template but not a title, are clean.
    expect(rulesOn('/about')).toEqual([]);
    expect(rulesOn('/products/1')).toEqual([]);
    expect(seo.some((i) => ruleOf(i).endsWith('-duplicate'))).toBe(false);
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

  it('identifies itself as BeaconBot on every request', () => {
    const all = [...world.sites.site.requests, ...world.sites.external.requests];
    expect(all.length).toBeGreaterThan(50);
    expect(all.every((request) => request.userAgent.includes('BeaconBot/1.0'))).toBe(true);
  });
});

describe('scans that check forms', () => {
  const formScan = async (formMode: 'detect' | 'validate_only' | 'submit') => {
    const id = await insertQueuedScan(world.db, `${world.sites.site.url}/`, {
      checks: ['forms'],
      formMode,
    });
    world.sites.site.reset();
    await runScan(deps(), id);
    const issues = await world.db.scanIssue.findMany({
      where: { scanId: id },
      include: { page: true },
    });
    return { id, issues, submissions: [...world.sites.site.submissions] };
  };

  it('detect mode never submits anything and finds nothing wrong with the markup', async () => {
    const { id, issues, submissions } = await formScan('detect');
    expect((await world.db.scan.findUniqueOrThrow({ where: { id } })).status).toBe('completed');
    expect(submissions).toEqual([]);
    expect(issues).toEqual([]);
  }, 120_000);

  it('validate_only mode reports validation problems but sends nothing at all', async () => {
    const { issues, submissions } = await formScan('validate_only');
    expect(submissions).toEqual([]);
    const found = issues.map((i) => [i.page?.url.replace(world.sites.site.url, ''), ruleOf(i)]);
    expect(found).toEqual([['/form-broken', 'forms.no-validation']]);
    expect(issues[0]?.severity).toBe('warning');
  }, 120_000);

  it('submit mode submits each distinct form once, identifies itself, and reports what breaks', async () => {
    const { id, issues, submissions } = await formScan('submit');
    expect(submissions.map((s) => s.path).sort()).toEqual([
      '/api/forms/500',
      '/api/forms/broken',
      '/api/forms/good',
    ]);
    expect(submissions.every((s) => s.testHeader === 'form-submission')).toBe(true);
    expect(submissions.every((s) => s.userAgent.includes('BeaconBot/1.0'))).toBe(true);

    const byPage = (path: string) =>
      issues
        .filter((i) => i.page?.url === `${world.sites.site.url}${path}`)
        .map(ruleOf)
        .sort();
    expect(byPage('/form-good')).toEqual([]);
    expect(byPage('/form-500')).toEqual(['forms.submit-failed']);
    expect(byPage('/form-broken')).toContain('forms.no-validation');

    const failed = issues.find((i) => ruleOf(i) === 'forms.submit-failed');
    expect(failed?.severity).toBe('critical');
    expect(failed?.message).toContain('HTTP 500');
    expect(failed?.evidence).toMatchObject({ rule: 'forms.submit-failed', httpStatus: 500 });
    // The screenshot is what visitors saw after submitting, not a highlight of the button.
    expect(failed?.screenshotPath).toBeTruthy();
    const stored = await world.storage.get(failed?.screenshotPath as string);
    expect(stored?.data.subarray(1, 4).toString()).toBe('PNG');
    // Nothing the check took a picture of is left in the evidence.
    expect(JSON.stringify(failed?.evidence)).not.toContain('screenshotPng');

    const scan = await world.db.scan.findUniqueOrThrow({ where: { id } });
    expect(scan.status).toBe('completed');
    expect(scan.criticalCount).toBe(1);
    const result = await world.db.checkResult.findFirstOrThrow({
      where: { scanId: id, checkType: 'forms' },
    });
    expect(result.issuesFound).toBe(scan.criticalCount + scan.warningCount);
  }, 180_000);
});

/** A small deterministic generator, so a "random" sample is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('scans of a website: page selection', () => {
  let websiteId: string;
  const pathOf = (url: string) => url.replace(world.sites.site.url, '') || '/';

  beforeAll(async () => {
    const owner = await world.db.user.create({
      data: { id: newId('usr'), email: 'owner@example.com', passwordHash: 'x', name: 'Owner' },
    });
    const site = world.sites.site.url;
    const website = await world.db.website.create({
      data: {
        id: newId('web'),
        name: 'Fixture',
        url: `${site}/`,
        hostname: new URL(site).hostname,
        ownerId: owner.id,
        checkFrequency: 'monthly',
        scheduleDayOfMonth: 1,
        enabledChecks: ['page-health', 'seo'],
      },
    });
    websiteId = website.id;
  });

  async function pagesOf(scanId: string): Promise<string[]> {
    const rows = await world.db.scanPage.findMany({ where: { scanId }, orderBy: { url: 'asc' } });
    return rows.map((row) => pathOf(row.url));
  }

  it('checks exactly the listed pages and never runs discovery', async () => {
    const site = world.sites.site.url;
    const id = await insertQueuedScan(world.db, `${site}/`, {
      checks: ['page-health', 'seo'],
      pageSelectionMode: 'static_list',
      staticPageUrls: [`${site}/about`, `${site}/contact`, `${site}/about?utm_source=x`],
    });
    world.sites.site.reset();
    await runScan(deps(), id);

    const scan = await world.db.scan.findUniqueOrThrow({ where: { id } });
    expect(scan.status).toBe('completed');
    expect(scan.pagesTotal).toBe(2);
    expect(scan.pagesDone).toBe(2);
    expect(await pagesOf(id)).toEqual(['/about', '/contact']);

    // No sitemap or robots.txt was fetched, and nothing was crawled.
    const paths = world.sites.site.requests.map((request) => request.path);
    expect(paths).not.toContain('/sitemap.xml');
    expect(paths).not.toContain('/robots.txt');
    expect(paths).not.toContain('/');
    // Without discovery there are no findings about the sitemap.
    const issues = await world.db.scanIssue.findMany({ where: { scanId: id } });
    expect(issues.map(ruleOf).filter((rule) => rule.includes('sitemap'))).toEqual([]);
  }, 120_000);

  it('fails clearly when a listed page is not on the site', async () => {
    const site = world.sites.site.url;
    const id = await insertQueuedScan(world.db, `${site}/`, {
      checks: ['page-health'],
      pageSelectionMode: 'static_list',
      staticPageUrls: ['https://elsewhere.example.org/x'],
    });
    await runScan(deps(), id);
    const scan = await world.db.scan.findUniqueOrThrow({ where: { id } });
    expect(scan.status).toBe('failed');
    expect(scan.errorMessage).toContain('not on http://127.0.0.1');
  }, 60_000);

  it('checks a sample that always has the homepage and pinned pages, then a fresh, wider one next time', async () => {
    const site = world.sites.site.url;
    const options = {
      checks: ['page-health' as const, 'seo' as const],
      websiteId,
      pageSelectionMode: 'random_sample' as const,
      sampleSize: 5,
      pinnedPageUrls: [`${site}/contact`],
    };

    const firstId = await insertQueuedScan(world.db, `${site}/`, options);
    await runScan(deps({ random: seeded(1) }), firstId);
    const first = await pagesOf(firstId);
    expect(first).toHaveLength(5);
    expect(first).toContain('/');
    expect(first).toContain('/contact');

    const secondId = await insertQueuedScan(world.db, `${site}/`, options);
    await runScan(deps({ random: seeded(2) }), secondId);
    const second = await pagesOf(secondId);
    expect(second).toHaveLength(5);
    expect(second).toContain('/');
    expect(second).toContain('/contact');

    // Everything not required is new the second time, because the site has more than enough pages.
    const optional = (pages: string[]) => pages.filter((p) => p !== '/' && p !== '/contact');
    expect(optional(second).filter((page) => optional(first).includes(page))).toEqual([]);

    // Pages checked so far grow from one check to the next.
    const distinct = await world.db.scanPage.findMany({
      where: { scan: { websiteId } },
      distinct: ['url'],
      select: { url: true },
    });
    expect(distinct.length).toBe(new Set([...first, ...second]).size);
    expect(distinct.length).toBeGreaterThan(5);

    // The second check is compared with the first, and the website's last check is updated.
    const scans = await world.db.scan.findMany({ where: { id: { in: [firstId, secondId] } } });
    expect(scans.find((s) => s.id === secondId)?.previousScanId).toBe(firstId);
    expect(scans.find((s) => s.id === firstId)?.previousScanId).toBeNull();
    const website = await world.db.website.findUniqueOrThrow({ where: { id: websiteId } });
    expect(website.lastCheckAt).not.toBeNull();
    expect(website.lastRunError).toBeNull();
  }, 240_000);

  it('a scan of a sample still reports what discovery learned about the whole site', async () => {
    const latest = await world.db.scan.findMany({
      where: { websiteId },
      orderBy: { runNumber: 'desc' },
      take: 1,
    });
    const issues = await world.db.scanIssue.findMany({
      where: { scanId: latest[0]?.id as string, checkType: 'seo' },
    });
    // The fixture has a sitemap, so there is nothing to say about a missing one.
    expect(issues.map(ruleOf)).not.toContain('seo.no-sitemap');
  });

  it('never compares a check of the website with a one-off scan of the same host', async () => {
    const latest = await world.db.scan.findMany({
      where: { websiteId },
      orderBy: { runNumber: 'desc' },
      take: 1,
    });
    const previous = await world.db.scan.findUniqueOrThrow({
      where: { id: latest[0]?.previousScanId as string },
    });
    expect(previous.websiteId).toBe(websiteId);
  });

  it('leaves the reason on the website when a check fails, and clears it when one completes', async () => {
    const dead = `http://127.0.0.1:${await freePort()}`;
    const id = await insertQueuedScan(world.db, `${dead}/`, {
      checks: ['page-health'],
      websiteId,
      pageSelectionMode: 'random_sample',
      sampleSize: 3,
    });
    await runScan(deps(), id);
    expect((await world.db.scan.findUniqueOrThrow({ where: { id } })).status).toBe('failed');
    let website = await world.db.website.findUniqueOrThrow({ where: { id: websiteId } });
    expect(website.lastRunError).toMatch(/^Could not reach/);
    expect(website.lastCheckAt).not.toBeNull();

    const site = world.sites.site.url;
    const ok = await insertQueuedScan(world.db, `${site}/`, {
      checks: ['page-health'],
      websiteId,
      pageSelectionMode: 'static_list',
      staticPageUrls: [`${site}/about`],
    });
    await runScan(deps(), ok);
    website = await world.db.website.findUniqueOrThrow({ where: { id: websiteId } });
    expect(website.lastRunError).toBeNull();
  }, 120_000);

  it('a scan of no website updates no website', async () => {
    const before = await world.db.website.findUniqueOrThrow({ where: { id: websiteId } });
    const site = world.sites.site.url;
    const id = await insertQueuedScan(world.db, `${site}/`, {
      checks: ['page-health'],
      pageSelectionMode: 'static_list',
      staticPageUrls: [`${site}/about`],
    });
    await runScan(deps(), id);
    const after = await world.db.website.findUniqueOrThrow({ where: { id: websiteId } });
    expect(after.lastCheckAt).toEqual(before.lastCheckAt);
  }, 60_000);
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
    const fresh = await import('@beacon/fixtures');
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
