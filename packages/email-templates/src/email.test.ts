import { describe, expect, it } from 'vitest';
import { allClear, attention, failed, firstCheck, FIXTURES, spotless } from './fixtures.js';
import { buildMjml, esc, MAX_ISSUES, MAX_ISSUES_ALL_CLEAR, renderEmail } from './render.js';
import { barHeight, chartFloor, sparklineHtml, SPARKLINE_MAX } from './sparkline.js';
import {
  buildPreheader,
  buildSubject,
  emailVariant,
  newIssueSummary,
  scoreChange,
  shortHost,
} from './subject.js';
import { buildText } from './text.js';
import type { ReportEmailData } from './types.js';

const report = (overrides: Partial<ReportEmailData>): ReportEmailData => ({
  ...attention,
  ...overrides,
});
const counts = (newCritical: number, newWarnings: number, stillOpen = 0) => ({
  newCritical,
  newWarnings,
  stillOpen,
  totalOpen: newCritical + newWarnings + stillOpen,
});

describe('emailVariant', () => {
  it('is all clear when nothing is new and the score held or improved', () => {
    expect(emailVariant(allClear)).toBe('all_clear');
    expect(emailVariant(spotless)).toBe('all_clear');
    expect(emailVariant(report({ counts: counts(0, 0, 4), score: 80, previousScore: 80 }))).toBe(
      'all_clear',
    );
  });

  it('asks for attention when anything is new', () => {
    expect(emailVariant(attention)).toBe('attention');
    expect(emailVariant(report({ counts: counts(0, 1), score: 95, previousScore: 90 }))).toBe(
      'attention',
    );
  });

  it('asks for attention when the score fell even with nothing new', () => {
    expect(emailVariant(report({ counts: counts(0, 0, 3), score: 74, previousScore: 80 }))).toBe(
      'attention',
    );
  });

  it('treats a first check as all clear only when there is nothing wrong at all', () => {
    expect(emailVariant(firstCheck)).toBe('attention');
    expect(
      emailVariant({ ...firstCheck, critical: 0, warnings: 0, counts: counts(0, 0), issues: [] }),
    ).toBe('all_clear');
  });

  it('is its own design for a check that could not run', () => {
    expect(emailVariant(failed)).toBe('failed');
  });
});

describe('subject lines', () => {
  it('says the website, the score and what is new, generated from the result', () => {
    expect(buildSubject(allClear)).toBe(
      '✅ example-estates.co.uk — health score 96 (no new issues)',
    );
    expect(buildSubject(attention)).toBe(
      '⚠️ example-estates.co.uk — health score 61 (3 new critical issues, 2 new warnings)',
    );
  });

  it('gets singular and plural right', () => {
    expect(buildSubject(report({ counts: counts(1, 0), score: 61 }))).toContain(
      '(1 new critical issue)',
    );
    expect(buildSubject(report({ counts: counts(0, 1), score: 61 }))).toContain('(1 new warning)');
    expect(buildSubject(report({ counts: counts(2, 1), score: 61 }))).toContain(
      '(2 new critical issues, 1 new warning)',
    );
  });

  it('explains a score drop that has no new issue behind it', () => {
    const data = report({ counts: counts(0, 0, 3), score: 74, previousScore: 80 });
    expect(buildSubject(data)).toBe(
      '⚠️ example-estates.co.uk — health score 74 (score down 6, no new issues)',
    );
  });

  it('describes a first check without comparing it with anything', () => {
    expect(buildSubject(firstCheck)).toBe(
      '⚠️ example-estates.co.uk — health score 72 (first check: 2 critical issues, 5 warnings)',
    );
    expect(
      buildSubject({
        ...firstCheck,
        critical: 0,
        warnings: 0,
        score: 100,
        counts: counts(0, 0),
        issues: [],
      }),
    ).toBe('✅ example-estates.co.uk — health score 100 (first check, no issues)');
  });

  it('flags a check that could not run', () => {
    expect(buildSubject(failed)).toBe('🚨 example-estates.co.uk — the check could not run');
  });

  it('drops a leading www from the host, as people say it', () => {
    expect(shortHost('www.example.com')).toBe('example.com');
    expect(shortHost('shop.example.com')).toBe('shop.example.com');
    expect(shortHost('WWW.Example.com')).toBe('Example.com');
  });
});

describe('preheader', () => {
  it('leads with what matters and the trend', () => {
    expect(buildPreheader(allClear)).toBe(
      'All clear. Nothing new needs your attention. Up 4 since the last check.',
    );
    expect(buildPreheader(attention)).toBe(
      '3 new critical issues, 2 new warnings. Down 17 since the last check.',
    );
    expect(buildPreheader(failed)).toContain('could not be checked');
    expect(buildPreheader(spotless)).toContain('Unchanged since the last check.');
  });
});

describe('scoreChange and newIssueSummary', () => {
  it('are null and empty when there is nothing to compare', () => {
    expect(scoreChange(firstCheck)).toBeNull();
    expect(scoreChange(attention)).toBe(-17);
    expect(newIssueSummary(report({ counts: counts(0, 0) }))).toBe('');
  });
});

describe('sparkline', () => {
  const points = (scores: number[]) =>
    scores.map((score, index) => ({ score, at: `2026-0${(index % 9) + 1}-01T00:00:00.000Z` }));

  it('needs at least two checks to say anything about a trend', () => {
    expect(sparklineHtml([])).toBe('');
    expect(sparklineHtml(points([80]))).toBe('');
    expect(sparklineHtml(points([80, 85]))).not.toBe('');
  });

  it('is made of table cells only, so Gmail and Outlook keep it', () => {
    const html = sparklineHtml(points([70, 80, 90]));
    expect(html).toContain('<table');
    expect(html).not.toMatch(/<(img|svg|canvas|script|style)/i);
    expect(html).not.toContain('data:');
  });

  it('shows at most the last twelve checks, with the latest in its score colour', () => {
    const html = sparklineHtml(points(Array.from({ length: 30 }, (_, i) => 50 + i)));
    expect(html.match(/<td valign="bottom"/g)).toHaveLength(SPARKLINE_MAX);
    // 79 is in the good band's neighbour (fair), so the last bar is amber. The others are grey.
    expect(html.match(/background-color:#d97706;border-radius/g)).toHaveLength(1);
    expect(html.match(/background-color:#d4d4d8/g)).toHaveLength(SPARKLINE_MAX - 1);
  });

  it('draws a fall as a shorter bar, scaled to the recent range', () => {
    expect(chartFloor([91, 61])).toBe(41);
    expect(chartFloor([10])).toBe(0);
    expect(chartFloor([])).toBe(0);
    expect(barHeight(91, 41)).toBeGreaterThan(barHeight(61, 41));
    expect(barHeight(100, 41)).toBe(44);
    expect(barHeight(0, 0)).toBe(4);
    expect(barHeight(150, 0)).toBe(44);
    expect(barHeight(-5, 0)).toBe(4);
    // A flat, perfect history is all full bars rather than a divide by zero.
    expect(barHeight(100, 100)).toBe(44);
  });
});

describe('escaping', () => {
  it('escapes markup so a page title or message cannot inject into the email', () => {
    expect(esc(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    );
  });

  it('does not let hostile content from a scanned site through', async () => {
    const hostile = report({
      website: {
        name: '<script>alert(1)</script>',
        url: 'https://x.test/"onmouseover="x',
        hostname: 'x.test',
      },
      recipient: { name: '<b>Sam</b>', email: 'a"b@example.com' },
      issues: [
        {
          severity: 'critical',
          check: 'SEO',
          page: '/<svg onload=alert(1)>',
          message: '</td><script>steal()</script>',
          pages: 1,
          isNew: true,
        },
      ],
    });
    const { html, text } = await renderEmail(hostile);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('</td><script');
    expect(html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
    expect(html).not.toContain('"onmouseover="x');
    // Plain text is not HTML, so it is left as written.
    expect(text).toContain('</td><script>steal()</script>');
  });
});

describe('the rendered email', () => {
  it.each(Object.entries(FIXTURES))('%s renders without MJML errors', async (_name, data) => {
    const email = await renderEmail(data);
    expect(email.subject.length).toBeGreaterThan(10);
    expect(
      email.html.startsWith('<!doctype html>') || email.html.startsWith('<!DOCTYPE html>'),
    ).toBe(true);
    expect(email.text.length).toBeGreaterThan(50);
  });

  it.each(Object.entries(FIXTURES))(
    '%s is small enough that Gmail does not clip it (under 102 KB)',
    async (_name, data) => {
      const { html } = await renderEmail(data);
      expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(100 * 1024);
    },
  );

  it.each(Object.entries(FIXTURES))(
    '%s is safe for email clients: table layout, inline styles, no scripts or remote assets',
    async (_name, data) => {
      const { html } = await renderEmail(data);
      expect(html).toContain('<table');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<link[^>]+stylesheet/i);
      expect(html).not.toMatch(/<img/i);
      expect(html).not.toMatch(/@import/);
      expect(html).not.toMatch(/fonts.googleapis/);
      expect(html).not.toMatch(/javascript:/i);
      // Styles are inline, which is what survives Gmail and Outlook.
      expect(html.match(/style="/g)?.length ?? 0).toBeGreaterThan(30);
      // Opted out of forced dark mode, so the palette is what people see.
      expect(html).toContain('name="color-scheme"');
      // 600px, the usual maximum for an email.
      expect(html).toContain('max-width:600px');
      expect(html).toContain('lang="en"');
    },
  );

  it('states the preheader and the title', async () => {
    const email = await renderEmail(attention);
    expect(email.html).toContain(`<title>${esc(email.subject)}</title>`);
    expect(email.html).toContain(esc(email.preheader));
  });

  it('shows the score, the counts, both links a person needs, and the manage and unsubscribe links', async () => {
    const { html } = await renderEmail(attention);
    for (const expected of ['Poor', 'Pages checked']) expect(html).toContain(expected);
    for (const value of [61, 8, 4, 9]) expect(html).toMatch(new RegExp(`>\\s*${value}\\s*<`));
    expect(html).toContain(`href="${attention.links.report}"`);
    expect(html).toContain(`href="${attention.links.preferences}"`);
    expect(html).toContain(`href="${attention.links.unsubscribe}"`);
    expect(html).toContain(`href="${attention.links.website}"`);
    expect(html).toContain('View full report');
    expect(html).toContain('Manage email preferences');
  });

  it('uses the dashboard palette: indigo for attention, green for all clear, red for a failure', async () => {
    expect((await renderEmail(attention)).html).toContain('background-color:#4f46e5');
    const clear = (await renderEmail(allClear)).html;
    expect(clear).toContain('background-color:#16a34a');
    expect(clear).not.toContain('background-color:#4f46e5');
    expect((await renderEmail(failed)).html).toContain('background-color:#dc2626');
  });

  it('is visibly calmer when all clear: green, framed as all clear, fewer rows', async () => {
    const email = await renderEmail(allClear);
    expect(email.variant).toBe('all_clear');
    expect(email.html).toContain('All clear');
    expect(email.html).toContain('Nothing new needs your attention');
    expect(email.html).not.toContain('New since the last check');
  });

  it('says so when there is nothing to fix at all', async () => {
    const email = await renderEmail(spotless);
    expect(email.html).toContain('Nothing needs attention');
    expect(email.html).not.toContain('View all');
  });

  it('lists new issues first, marks them, and points at the rest', async () => {
    const { html } = await renderEmail(attention);
    const firstNew = html.indexOf('Image failed to load');
    const firstOld = html.indexOf('Broken link: /brochure-2025.pdf');
    expect(firstNew).toBeGreaterThan(-1);
    expect(firstNew).toBeLessThan(firstOld);
    expect(html.match(/>New</g)).toHaveLength(5);
    expect(html).toContain('Also still open from earlier checks: <strong>8</strong>');
  });

  it(`never lists more than ${MAX_ISSUES} issues, and links to the rest`, async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      severity: 'warning' as const,
      check: 'SEO',
      page: `/page-${i}`,
      message: `Problem number ${i}`,
      pages: 1,
      isNew: i < 3,
    }));
    const data = report({ issues: many, counts: counts(0, 3, 37) });
    const { html } = await renderEmail(data);
    expect(html.match(/Problem number/g)).toHaveLength(MAX_ISSUES);
    expect(html).toContain('View all 40 issues');
    expect(html).toContain('Problem number 9');
    expect(html).not.toContain('Problem number 10<');
  });

  it(`lists at most ${MAX_ISSUES_ALL_CLEAR} in the calm version`, async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      severity: 'warning' as const,
      check: 'SEO',
      page: `/page-${i}`,
      message: `Older problem ${i}`,
      pages: 1,
      isNew: false,
    }));
    const { html } = await renderEmail({ ...allClear, issues: many, counts: counts(0, 0, 12) });
    expect(html.match(/Older problem/g)).toHaveLength(MAX_ISSUES_ALL_CLEAR);
    expect(html).toContain('View all 12 issues');
  });

  it('stays under Gmail’s clipping limit in the worst case', async () => {
    const long = 'x'.repeat(240);
    const many = Array.from({ length: 10 }, (_, i) => ({
      severity: 'critical' as const,
      check: 'Page health',
      page: `/a/very/long/path/${'segment/'.repeat(8)}${i}`,
      message: `${long} ${i}`,
      pages: 1,
      isNew: true,
    }));
    const { html } = await renderEmail(report({ issues: many, counts: counts(10, 0, 50) }));
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(100 * 1024);
  });

  it('greets by first name, or not at all, and explains a first check', async () => {
    expect((await renderEmail(attention)).html).toContain('Hi Sam,');
    const anonymous = await renderEmail({
      ...attention,
      recipient: { name: null, email: 'x@example.com' },
    });
    expect(anonymous.html).not.toContain('Hi ');
    const first = await renderEmail(firstCheck);
    expect(first.html).toContain('first check of');
    expect(first.html).toContain('nothing to compare with yet');
    expect(first.html).not.toMatch(/since the last check \(was/);
  });

  it('shows a rise, a fall and no change differently, with a word as well as a colour', async () => {
    expect((await renderEmail(allClear)).html).toContain('+4');
    expect((await renderEmail(attention)).html).toContain('&minus;17');
    expect((await renderEmail(spotless)).html).toContain('No change');
  });

  it('gives a failed check its reason and a way back', async () => {
    const { html, variant } = await renderEmail(failed);
    expect(variant).toBe('failed');
    expect(html).toContain('Could not reach https://www.example-estates.co.uk/');
    expect(html).toContain('last check that completed scored <strong>61</strong>');
    expect(html).toContain('View details');
  });

  it('shows a problem that repeats across pages once, with how many pages it is on', async () => {
    const { html, text } = await renderEmail(attention);
    expect(html).toContain('and 5 other pages');
    expect(html.match(/Broken link: \/brochure-2025\.pdf/g)).toHaveLength(1);
    expect(text).toContain('and 5 other pages');
  });

  it('builds valid MJML source that mentions no unresolved placeholders', () => {
    const mjml = buildMjml(attention, 'Subject', 'Preheader');
    expect(mjml).not.toMatch(/undefined|\[object|NaN/);
  });
});

describe('the plain text version', () => {
  it('carries the same facts, and the links, without markup', () => {
    const text = buildText(attention);
    expect(text).toContain('Health score: 61 / 100');
    expect(text).toContain('-17 since the last check (was 78).');
    expect(text).toContain('New since the last check: 3 new critical issues, 2 new warnings.');
    expect(text).toContain(
      '- [NEW] CRITICAL: Image failed to load (HTTP 404). (/property/12-oak-lane, Images)',
    );
    expect(text).toContain(`View the full report: ${attention.links.report}`);
    expect(text).toContain(`Unsubscribe: ${attention.links.unsubscribe}`);
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it('handles all clear, a first check and a failure', () => {
    expect(buildText(allClear)).toContain('Nothing new since the last check.');
    expect(buildText(firstCheck)).toContain('First check: nothing to compare with yet.');
    expect(buildText(failed)).toContain('could not be checked');
    expect(buildText(failed)).toContain('The last check that completed scored 61.');
  });

  it('says how many more there are past the ten shown', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      severity: 'warning' as const,
      check: 'SEO',
      page: `/p${i}`,
      message: `m${i}`,
      pages: 1,
      isNew: false,
    }));
    expect(buildText(report({ issues: many, counts: counts(0, 0, 25) }))).toContain(
      '...and 15 more.',
    );
  });
});
