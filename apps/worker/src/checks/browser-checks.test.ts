import { freePort } from '@qa-hub/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedPage } from '../scan/browser.js';
import { BrowserSession, captureHighlighted } from '../scan/browser.js';
import {
  createChecker,
  OFFLINE_BROWSER_ARGS,
  offlineResolver,
  silentLog,
  startSites,
  type Sites,
} from '../test/harness.js';
import { imagesCheck } from './images.js';
import { linksCheck } from './links.js';
import { pageHealthCheck } from './page-health.js';
import { stagingUrlsCheck } from './staging-urls.js';
import type { Check, CheckContext, IssueDraft, LinkCandidate } from './types.js';

let sites: Sites;
let browser: BrowserSession;
let checker: ReturnType<typeof createChecker>;
const signal = new AbortController().signal;

beforeAll(async () => {
  sites = await startSites();
  browser = await BrowserSession.launch({
    allowLocal: true,
    resolver: offlineResolver,
    args: OFFLINE_BROWSER_ARGS,
  });
  checker = createChecker();
}, 120_000);

afterAll(async () => {
  await browser.close();
  await checker.client.close();
  await sites.close();
});

interface Run {
  drafts: IssueDraft[];
  registered: LinkCandidate[];
  loaded: LoadedPage;
}

/** Loads a fixture page in Chromium and runs one check on it, the way the scan runner does. */
async function runCheck(check: Check, path: string): Promise<Run> {
  const url = path.startsWith('http') ? path : `${sites.site.url}${path}`;
  const loaded = await browser.load(url, signal);
  const registered: LinkCandidate[] = [];
  const context: CheckContext = {
    scan: {
      id: 'scn_test',
      rootUrl: `${sites.site.url}/`,
      origin: sites.site.url,
      hostname: '127.0.0.1',
      checks: ['images', 'links', 'staging-urls', 'page-health'],
      formMode: 'detect',
    },
    settings: {
      stagingPatterns: ['staging.', 'dev.', '.netlify.app', '.vercel.app'],
      formTestEmail: 'qa@example.com',
    },
    page: { id: 'pg_test', url },
    observation: loaded.observation,
    dom: loaded.dom,
    browserPage: loaded.page,
    probe: (target) =>
      checker.probe.check(target, { external: new URL(target).origin !== sites.site.url }),
    links: {
      register: (_pageId, links) => {
        registered.push(...links);
        return Promise.resolve();
      },
    },
    isInternal: (target) => new URL(target).origin === sites.site.url,
    signal,
    log: silentLog,
  };
  const drafts = await check.run(context);
  return { drafts, registered, loaded };
}

const byRule = (drafts: IssueDraft[], rule: string) =>
  drafts.filter((draft) => draft.rule === rule);
const urlsOf = (drafts: IssueDraft[]) => drafts.map((draft) => draft.resourceUrl ?? '').sort();

describe('page loading', () => {
  it('waits for the page, scrolls it and captures what it looks like', async () => {
    const { loaded } = await runCheck(imagesCheck, '/');
    try {
      expect(loaded.observation).toMatchObject({ status: 200, loadError: null });
      expect(loaded.dom.title).toBe('Fixture home');
      expect(loaded.dom.h1Count).toBe(1);
      expect(loaded.dom.canonical).toBe(`${sites.site.url}/`);
      expect(loaded.dom.images.length).toBeGreaterThanOrEqual(6);
      expect(loaded.dom.forms).toEqual([]);
      // The lazy image sits ~3000px down. Scrolling made the browser request it.
      expect(
        loaded.observation.network.some((entry) => entry.url.endsWith('/images/lazy-missing.jpg')),
      ).toBe(true);
    } finally {
      await loaded.close();
    }
  });

  it('follows redirects and reports the final url', async () => {
    const loaded = await browser.load(`${sites.site.url}/old-page`, signal);
    try {
      expect(loaded.observation.finalUrl).toBe(`${sites.site.url}/about`);
      expect(loaded.observation.status).toBe(200);
    } finally {
      await loaded.close();
    }
  });

  it('reports a page that cannot be loaded instead of throwing', async () => {
    const loaded = await browser.load(`http://127.0.0.1:${await freePort()}/`, signal);
    try {
      expect(loaded.observation.loadError).toMatch(/ERR_CONNECTION_REFUSED/);
      expect(loaded.observation.status).toBeNull();
      expect(loaded.dom.images).toEqual([]);
    } finally {
      await loaded.close();
    }
  });

  it('identifies itself as QAHubBot in its user agent', async () => {
    sites.site.reset();
    const loaded = await browser.load(`${sites.site.url}/about`, signal);
    await loaded.close();
    const agents = sites.site.requests.map((request) => request.userAgent);
    expect(agents.length).toBeGreaterThan(0);
    expect(
      agents.every((agent) => agent.includes('QAHubBot/1.0') && agent.includes('Chrome')),
    ).toBe(true);
  });

  it('blocks requests to private addresses when local targets are not allowed', async () => {
    const strict = await BrowserSession.launch({ allowLocal: false, args: OFFLINE_BROWSER_ARGS });
    try {
      const loaded = await strict.load(`${sites.site.url}/about`, signal);
      try {
        expect(loaded.observation.loadError).toMatch(/ERR_BLOCKED_BY_CLIENT/);
        expect(loaded.observation.network.every((entry) => entry.blocked)).toBe(true);
      } finally {
        await loaded.close();
      }
    } finally {
      await strict.close();
    }
  });

  it('gives up on a cancelled scan without hanging', async () => {
    const controller = new AbortController();
    const pending = browser.load(`${sites.site.url}/`, controller.signal);
    controller.abort();
    const outcome = await pending.then(
      async (loaded) => {
        await loaded.close();
        return 'loaded';
      },
      () => 'aborted',
    );
    expect(['loaded', 'aborted']).toContain(outcome);
  });
});

describe('images check', () => {
  it('finds broken, lazy-loaded, srcset, background and missing-alt images on the home page', async () => {
    const { drafts, loaded } = await runCheck(imagesCheck, '/');
    await loaded.close();
    const at = (path: string) => `${sites.site.url}${path}`;

    const broken = urlsOf(byRule(drafts, 'images.broken'));
    expect(broken).toEqual(
      [
        at('/images/hero-missing.jpg'),
        at('/images/lazy-missing.jpg'),
        at('/images/logo-missing.png'),
        'https://cdn.dev.acme-fixture.test/logo.png',
      ].sort(),
    );
    expect(byRule(drafts, 'images.broken').every((draft) => draft.severity === 'critical')).toBe(
      true,
    );

    const lazy = byRule(drafts, 'images.broken').find((d) =>
      d.resourceUrl?.endsWith('lazy-missing.jpg'),
    );
    expect(lazy?.selector).toBe('#lazy-broken');
    expect(lazy?.evidence).toMatchObject({ httpStatus: 404, lazyLoaded: true });
    expect(lazy?.message).toBe('Image failed to load (HTTP 404).');

    expect(urlsOf(byRule(drafts, 'images.broken-srcset'))).toEqual([
      at('/images/srcset-2x-missing.svg'),
    ]);
    expect(urlsOf(byRule(drafts, 'images.broken-background'))).toEqual([
      at('/images/bg-missing.jpg'),
    ]);

    const missingAlt = byRule(drafts, 'images.missing-alt');
    expect(missingAlt).toHaveLength(1);
    expect(missingAlt[0]).toMatchObject({ severity: 'warning', selector: '#no-alt' });
  });

  it('reports only the shared broken logo on an otherwise healthy page', async () => {
    const { drafts, loaded } = await runCheck(imagesCheck, '/about');
    await loaded.close();
    expect(drafts.map((d) => [d.rule, d.severity])).toEqual([['images.broken', 'critical']]);
    expect(drafts[0]?.resourceUrl).toBe(`${sites.site.url}/images/logo-missing.png`);
  });

  it('does not treat a working SVG without intrinsic size as broken', async () => {
    const { drafts, loaded } = await runCheck(imagesCheck, '/products/1');
    await loaded.close();
    expect(byRule(drafts, 'images.broken').map((d) => d.resourceUrl)).toEqual([
      `${sites.site.url}/images/logo-missing.png`,
    ]);
  });
});

describe('staging-urls check', () => {
  it('finds staging links, images and alternates on the home page', async () => {
    const { drafts, loaded } = await runCheck(stagingUrlsCheck, '/');
    await loaded.close();
    expect(urlsOf(drafts)).toEqual([
      'https://acme-fixture.netlify.app/',
      'https://cdn.dev.acme-fixture.test/logo.png',
      'https://staging.acme-fixture.test/pricing',
    ]);
    expect(drafts.every((d) => d.severity === 'critical')).toBe(true);
    const anchor = drafts.find((d) => d.resourceUrl?.includes('/pricing'));
    expect(anchor?.evidence).toMatchObject({ hostname: 'staging.acme-fixture.test', tag: 'a' });
    expect(anchor?.selector).toBeTruthy();
  });

  it('finds nothing on a clean page', async () => {
    const { drafts, loaded } = await runCheck(stagingUrlsCheck, '/about');
    await loaded.close();
    expect(drafts).toEqual([]);
  });
});

describe('page-health check', () => {
  it('reports console errors, exceptions and failing requests', async () => {
    const { drafts, loaded } = await runCheck(pageHealthCheck, '/console-errors');
    await loaded.close();

    expect(byRule(drafts, 'page-health.console-error').map((d) => d.evidence?.text)).toEqual([
      'Fixture console error: widget failed to initialise',
    ]);
    expect(byRule(drafts, 'page-health.js-exception')[0]?.message).toContain(
      'Fixture uncaught exception',
    );

    const failed = byRule(drafts, 'page-health.failed-request');
    const bySeverity = Object.fromEntries(
      failed.map((d) => [new URL(d.resourceUrl ?? '').pathname, d.severity]),
    );
    expect(bySeverity).toEqual({ '/js/missing.js': 'critical', '/api/broken': 'warning' });
  });

  it('reports a page that returns 404', async () => {
    const { drafts, loaded } = await runCheck(pageHealthCheck, '/missing-page');
    await loaded.close();
    expect(drafts).toEqual([
      expect.objectContaining({ rule: 'page-health.http-status', severity: 'critical' }),
    ]);
    expect(drafts[0]?.message).toBe('The page returned HTTP 404.');
  });

  it('reports a page that cannot load as critical', async () => {
    const { drafts, loaded } = await runCheck(
      pageHealthCheck,
      `http://127.0.0.1:${await freePort()}/`,
    );
    await loaded.close();
    expect(drafts).toEqual([
      expect.objectContaining({ rule: 'page-health.load-failed', severity: 'critical' }),
    ]);
  });

  it('is quiet on a healthy page', async () => {
    const { drafts, loaded } = await runCheck(pageHealthCheck, '/about');
    await loaded.close();
    // The shared logo is an image failure, which the images check owns.
    expect(drafts).toEqual([]);
  });
});

describe('links check', () => {
  it('registers every distinct http(s) link on the page', async () => {
    const { registered, loaded } = await runCheck(linksCheck, '/');
    await loaded.close();
    const urls = registered.map((link) => link.url);

    expect(urls).toContain(`${sites.site.url}/about`);
    expect(urls).toContain(`${sites.site.url}/missing-page`);
    expect(urls).toContain(`${sites.site.url}/download.pdf`);
    expect(urls).toContain(`${sites.external.url}/gone`);
    expect(urls).toContain('https://staging.acme-fixture.test/pricing');
    expect(urls.some((url) => url.startsWith('mailto:') || url.startsWith('tel:'))).toBe(false);
    expect(urls.some((url) => url.includes('#'))).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
    expect(registered.find((link) => link.url.endsWith('/gone'))).toMatchObject({
      text: 'External broken',
    });
  });
});

describe('captureHighlighted', () => {
  it('takes a PNG with the element outlined, then restores the page', async () => {
    const loaded = await browser.load(`${sites.site.url}/`, signal);
    try {
      const png = await captureHighlighted(loaded.page, '#broken-hero');
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.length).toBeGreaterThan(1000);
      const outline = await loaded.page.evaluate(
        `document.querySelector('#broken-hero').style.outline`,
      );
      expect(outline).toBe('');
    } finally {
      await loaded.close();
    }
  });

  it('still takes a plain screenshot when the selector matches nothing or is invalid', async () => {
    const loaded = await browser.load(`${sites.site.url}/about`, signal);
    try {
      for (const selector of ['#does-not-exist', '???[[', null]) {
        const png = await captureHighlighted(loaded.page, selector);
        expect(png.subarray(1, 4).toString()).toBe('PNG');
      }
    } finally {
      await loaded.close();
    }
  });
});
