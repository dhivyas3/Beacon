import { describe, expect, it } from 'vitest';
import { classifyLink, linksOfPage } from './links.js';
import { detectMixedContent, pageHealthCheck } from './page-health.js';
import { stagingUrlsCheck } from './staging-urls.js';
import { emptySnapshot } from '../scan/browser.js';
import type { UrlCheckResult } from '../http/url-checker.js';
import { silentLog } from '../test/harness.js';
import type { CheckContext, NetworkEntry, PageObservation } from './types.js';

function observation(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    finalUrl: 'https://www.example.com/',
    status: 200,
    loadError: null,
    network: [],
    console: [],
    pageErrors: [],
    ...overrides,
  };
}

function net(url: string, extra: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    url,
    method: 'GET',
    resourceType: 'other',
    status: 200,
    failure: null,
    blocked: false,
    ...extra,
  };
}

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    scan: {
      id: 'scn_x',
      rootUrl: 'https://www.example.com/',
      origin: 'https://www.example.com',
      hostname: 'www.example.com',
      checks: [],
      formMode: 'detect',
    },
    settings: {
      stagingPatterns: ['localhost', 'staging.', 'dev.', '.netlify.app'],
      formTestEmail: 'qa@example.com',
    },
    page: { id: 'pg_x', url: 'https://www.example.com/' },
    observation: observation(),
    dom: emptySnapshot(),
    browserPage: undefined as never,
    probe: () => Promise.reject(new Error('probe not expected')),
    links: { register: () => Promise.resolve() },
    isInternal: () => true,
    signal: new AbortController().signal,
    log: silentLog,
    ...overrides,
  };
}

const rules = (drafts: { rule: string }[]) => drafts.map((draft) => draft.rule);

describe('staging-urls check', () => {
  it('flags links, images, scripts, canonicals and requests on staging hosts', async () => {
    const dom = emptySnapshot();
    dom.anchors.push({
      rawHref: 'https://staging.example.com/pricing',
      href: 'https://staging.example.com/pricing',
      text: 'Pricing',
      selector: 'nav a',
      rel: null,
    });
    dom.images.push({
      selector: 'img',
      rawSrc: 'https://demo.netlify.app/logo.png',
      src: 'https://demo.netlify.app/logo.png',
      currentSrc: 'https://demo.netlify.app/logo.png',
      alt: 'x',
      naturalWidth: 10,
      complete: true,
      loading: null,
      width: 10,
      height: 10,
      decorative: false,
      srcset: [],
    });
    dom.references.push(
      {
        tag: 'script',
        attr: 'src',
        url: 'https://dev.example.com/app.js',
        selector: 'script',
        rel: null,
      },
      {
        tag: 'link',
        attr: 'href',
        url: 'http://localhost:3000/',
        selector: 'link',
        rel: 'canonical',
      },
    );
    const ctx = context({
      dom,
      observation: observation({
        network: [net('https://api.dev.example.com/v1/items', { resourceType: 'fetch' })],
      }),
    });

    const drafts = await stagingUrlsCheck.run(ctx);
    const urls = drafts.map((draft) => draft.resourceUrl).sort();
    expect(urls).toEqual([
      'http://localhost:3000/',
      'https://api.dev.example.com/v1/items',
      'https://demo.netlify.app/logo.png',
      'https://dev.example.com/app.js',
      'https://staging.example.com/pricing',
    ]);
    expect(drafts.every((draft) => draft.severity === 'critical')).toBe(true);
    expect(drafts.every((draft) => draft.rule === 'staging-urls.reference')).toBe(true);
    expect(drafts.find((d) => d.resourceUrl?.includes('/pricing'))?.selector).toBe('nav a');
  });

  it('leaves production hosts and the site itself alone', async () => {
    const dom = emptySnapshot();
    dom.anchors.push(
      { rawHref: '/x', href: 'https://www.example.com/x', text: '', selector: null, rel: null },
      {
        rawHref: 'y',
        href: 'https://developer.example.com/y',
        text: '',
        selector: null,
        rel: null,
      },
      { rawHref: 'z', href: 'https://cdn.example.org/z', text: '', selector: null, rel: null },
    );
    expect(await stagingUrlsCheck.run(context({ dom }))).toEqual([]);
  });

  it('does not flag every link when the scanned site is itself a staging site', async () => {
    const dom = emptySnapshot();
    dom.anchors.push({
      rawHref: '/about',
      href: 'https://staging.acme.com/about',
      text: '',
      selector: null,
      rel: null,
    });
    const ctx = context({
      dom,
      scan: { ...context().scan, hostname: 'staging.acme.com' },
    });
    expect(await stagingUrlsCheck.run(ctx)).toEqual([]);
  });

  it('honours custom patterns', async () => {
    const dom = emptySnapshot();
    dom.anchors.push({
      rawHref: 'x',
      href: 'https://preview.acme.io/x',
      text: '',
      selector: null,
      rel: null,
    });
    const ctx = context({
      dom,
      settings: { stagingPatterns: ['preview.'], formTestEmail: 'a@b.co' },
    });
    expect(rules(await stagingUrlsCheck.run(ctx))).toEqual(['staging-urls.reference']);
  });

  it('reports each url once per page', async () => {
    const dom = emptySnapshot();
    for (let i = 0; i < 3; i++) {
      dom.anchors.push({
        rawHref: 'x',
        href: 'https://staging.example.com/same',
        text: '',
        selector: null,
        rel: null,
      });
    }
    expect(await stagingUrlsCheck.run(context({ dom }))).toHaveLength(1);
  });
});

describe('page-health check', () => {
  it('flags a page that will not load and stops there', async () => {
    const drafts = await pageHealthCheck.run(
      context({
        observation: observation({ loadError: 'net::ERR_CONNECTION_REFUSED', status: null }),
      }),
    );
    expect(rules(drafts)).toEqual(['page-health.load-failed']);
    expect(drafts[0]?.severity).toBe('critical');
  });

  it('flags 4xx and 5xx as critical, other non-2xx as warnings, and 200 as fine', async () => {
    const run = (status: number) =>
      pageHealthCheck.run(context({ observation: observation({ status }) }));
    expect((await run(404))[0]).toMatchObject({
      rule: 'page-health.http-status',
      severity: 'critical',
    });
    expect((await run(500))[0]?.severity).toBe('critical');
    expect((await run(304))[0]?.severity).toBe('warning');
    expect(await run(200)).toEqual([]);
  });

  it('turns console errors and uncaught exceptions into warnings', async () => {
    const drafts = await pageHealthCheck.run(
      context({
        observation: observation({
          console: [{ type: 'error', text: 'Widget failed after 250 ms', location: 'app.js:10' }],
          pageErrors: ['TypeError: x is not a function'],
        }),
      }),
    );
    expect(drafts.map((d) => [d.rule, d.severity])).toEqual([
      ['page-health.console-error', 'warning'],
      ['page-health.js-exception', 'warning'],
    ]);
    // Numbers are normalised so the same error groups across pages and runs.
    expect(drafts[0]?.subject).toBe('Widget failed after # ms');
  });

  it('separates failing scripts and styles (critical) from other failed requests (warning)', async () => {
    const drafts = await pageHealthCheck.run(
      context({
        observation: observation({
          network: [
            net('https://www.example.com/app.js', { resourceType: 'script', status: 404 }),
            net('https://www.example.com/site.css', { resourceType: 'stylesheet', status: 500 }),
            net('https://www.example.com/api/items', { resourceType: 'fetch', status: 500 }),
            net('https://www.example.com/font.woff2', {
              resourceType: 'font',
              status: null,
              failure: 'net::ERR_CONNECTION_RESET',
            }),
            net('https://www.example.com/photo.jpg', { resourceType: 'image', status: 404 }),
            net('https://www.example.com/ok.js', { resourceType: 'script' }),
          ],
        }),
      }),
    );
    const bySeverity = Object.fromEntries(
      drafts.map((d) => [new URL(d.resourceUrl ?? '').pathname, d.severity]),
    );
    expect(bySeverity).toEqual({
      '/app.js': 'critical',
      '/site.css': 'critical',
      '/api/items': 'warning',
      '/font.woff2': 'warning',
    });
  });

  it('does not report the main document twice and leaves images to the images check', async () => {
    const drafts = await pageHealthCheck.run(
      context({
        observation: observation({
          status: 404,
          finalUrl: 'https://www.example.com/gone',
          network: [
            net('https://www.example.com/gone', { resourceType: 'document', status: 404 }),
            net('https://www.example.com/a.png', { resourceType: 'image', status: 404 }),
          ],
        }),
      }),
    );
    expect(rules(drafts)).toEqual(['page-health.http-status']);
  });

  it('does not repeat the console line Chrome logs for every failed resource', async () => {
    const drafts = await pageHealthCheck.run(
      context({
        observation: observation({
          console: [
            {
              type: 'error',
              text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
              location: null,
            },
          ],
        }),
      }),
    );
    expect(drafts).toEqual([]);
  });

  it('reports blocked private requests as information, not as page failures', async () => {
    const drafts = await pageHealthCheck.run(
      context({
        observation: observation({
          network: [
            net('http://169.254.169.254/latest', {
              status: null,
              failure: 'net::ERR_BLOCKED_BY_CLIENT',
              blocked: true,
            }),
          ],
        }),
      }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ rule: 'page-health.blocked-request', severity: 'info' });
  });

  it('ignores the Chrome duplicate of a mixed content warning in the console', async () => {
    const text =
      "Mixed Content: The page at 'https://www.example.com/' was loaded over HTTPS, but requested an insecure script 'http://cdn.example.org/a.js'. This request has been blocked.";
    const drafts = await pageHealthCheck.run(
      context({ observation: observation({ console: [{ type: 'error', text, location: null }] }) }),
    );
    expect(rules(drafts)).toEqual(['page-health.mixed-content']);
    expect(drafts[0]).toMatchObject({
      severity: 'critical',
      resourceUrl: 'http://cdn.example.org/a.js',
    });
  });
});

describe('detectMixedContent', () => {
  it('finds http resources on an https page and rates active content higher', () => {
    const hits = detectMixedContent(
      'https://www.example.com/',
      [
        net('http://cdn.example.org/app.js', { resourceType: 'script' }),
        net('http://cdn.example.org/pic.jpg', { resourceType: 'image' }),
        net('https://cdn.example.org/fine.js', { resourceType: 'script' }),
      ],
      [{ url: 'http://cdn.example.org/widget.js', tag: 'script' }],
      [],
    );
    expect(hits.map((hit) => [hit.url, hit.active])).toEqual([
      ['http://cdn.example.org/app.js', true],
      ['http://cdn.example.org/pic.jpg', false],
      ['http://cdn.example.org/widget.js', true],
    ]);
  });

  it('finds nothing on an http page, and ignores localhost', () => {
    expect(
      detectMixedContent('http://www.example.com/', [net('http://a.example.org/x.js')], [], []),
    ).toEqual([]);
    expect(
      detectMixedContent('https://www.example.com/', [net('http://localhost:3000/x.js')], [], []),
    ).toEqual([]);
  });

  it('reads the url out of Chrome mixed content console messages', () => {
    const hits = detectMixedContent(
      'https://www.example.com/',
      [],
      [],
      ["Mixed Content: requested an insecure image 'http://img.example.org/p.png'."],
    );
    expect(hits).toEqual([
      { url: 'http://img.example.org/p.png', active: false, source: 'console' },
    ]);
  });
});

describe('links check helpers', () => {
  function result(overrides: Partial<UrlCheckResult> = {}): UrlCheckResult {
    return {
      url: 'https://x.example/a',
      status: 200,
      finalUrl: 'https://x.example/a',
      hops: 0,
      chain: [],
      redirectLimitReached: false,
      error: null,
      method: 'HEAD',
      durationMs: 5,
      ...overrides,
    };
  }

  it('leaves healthy links alone', () => {
    expect(classifyLink(result(), false)).toEqual([]);
    expect(classifyLink(result({ hops: 2, status: 200 }), false)).toEqual([]);
  });

  it('reports 4xx and 5xx as critical broken links', () => {
    expect(classifyLink(result({ status: 404 }), false)[0]).toMatchObject({
      rule: 'links.broken',
      severity: 'critical',
    });
    expect(classifyLink(result({ status: 503 }), true)[0]?.severity).toBe('critical');
  });

  it('reports a redirect chain of three or more hops as a warning', () => {
    const drafts = classifyLink(
      result({
        hops: 3,
        chain: [
          { url: 'a', status: 301 },
          { url: 'b', status: 301 },
          { url: 'c', status: 302 },
        ],
      }),
      false,
    );
    expect(drafts[0]).toMatchObject({ rule: 'links.redirect-chain', severity: 'warning' });
    expect(drafts[0]?.message).toContain('3 times');
  });

  it('reports a redirect loop and unreachable hosts as critical', () => {
    expect(classifyLink(result({ redirectLimitReached: true, status: 302 }), false)[0]?.rule).toBe(
      'links.redirect-loop',
    );
    const unreachable = classifyLink(
      result({
        status: null,
        error: { code: 'dns', message: 'The domain name could not be resolved.' },
      }),
      true,
    );
    expect(unreachable[0]).toMatchObject({ rule: 'links.unreachable', severity: 'critical' });
  });

  it('downgrades bot-blocking statuses on external sites to a warning', () => {
    for (const status of [401, 403, 429, 999]) {
      const external = classifyLink(result({ status }), true);
      expect(external[0]).toMatchObject({ rule: 'links.unverifiable', severity: 'warning' });
    }
    expect(classifyLink(result({ status: 403 }), false)[0]?.rule).toBe('links.broken');
    expect(classifyLink(result({ status: 404 }), true)[0]?.rule).toBe('links.broken');
  });

  it('says nothing about a check that was cancelled', () => {
    expect(
      classifyLink(result({ status: null, error: { code: 'aborted', message: 'stopped' } }), false),
    ).toEqual([]);
  });

  it('collects each distinct link once and skips in-page anchors', () => {
    const dom = emptySnapshot();
    const add = (rawHref: string, href: string | null) =>
      dom.anchors.push({ rawHref, href, text: 'link', selector: 'a', rel: null });
    add('/a', 'https://www.example.com/a');
    add('/a?utm_source=x#top', 'https://www.example.com/a?utm_source=x#top');
    add('#contact', 'https://www.example.com/#contact');
    add('mailto:hi@example.com', null);
    add('https://other.org/x', 'https://other.org/x');
    const links = linksOfPage(context({ dom }));
    expect(links.map((link) => link.url)).toEqual([
      'https://www.example.com/a',
      'https://other.org/x',
    ]);
  });
});
