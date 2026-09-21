import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCheckRunner, type CheckRunner } from '../test/harness.js';
import { analyseSeo, findDuplicates, seoCheck, TITLE_MAX } from './seo.js';
import type { DomSnapshot, IssueDraft } from './types.js';

function dom(overrides: Partial<DomSnapshot> = {}): DomSnapshot {
  return {
    title: 'A good page title',
    titleCount: 1,
    metaDescription: 'A description of the page that is worth reading.',
    canonical: 'https://www.example.com/page',
    canonicalCount: 1,
    robotsMeta: null,
    lang: 'en',
    h1Count: 1,
    ogTags: { 'og:title': 't', 'og:description': 'd', 'og:image': 'https://www.example.com/i.png' },
    images: [],
    backgrounds: [],
    anchors: [],
    references: [],
    forms: [],
    ...overrides,
  };
}

const analyse = (overrides: Partial<DomSnapshot> = {}): IssueDraft[] =>
  analyseSeo({
    pageUrl: 'https://www.example.com/page',
    dom: dom(overrides),
    hostname: 'www.example.com',
    stagingPatterns: ['staging.', '.netlify.app'],
  });

const rules = (drafts: IssueDraft[]): string[] => drafts.map((draft) => draft.rule).sort();

describe('analyseSeo', () => {
  it('finds nothing wrong with a complete page', () => {
    expect(analyse()).toEqual([]);
  });

  it('treats a missing or blank title as critical', () => {
    for (const title of [null, '', '   ']) {
      const drafts = analyse({ title, titleCount: title === null ? 0 : 1 });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ rule: 'seo.title-missing', severity: 'critical' });
    }
  });

  it('flags titles that are too long, at the boundary, but not short ones', () => {
    expect(rules(analyse({ title: 'Contact' }))).toEqual([]);
    expect(rules(analyse({ title: 'x'.repeat(TITLE_MAX) }))).toEqual([]);
    const long = analyse({ title: 'x'.repeat(TITLE_MAX + 1) });
    expect(long[0]).toMatchObject({ rule: 'seo.title-long', severity: 'warning' });
    expect(long[0]?.message).toContain(String(TITLE_MAX + 1));
  });

  it('flags more than one title tag', () => {
    expect(rules(analyse({ titleCount: 2 }))).toEqual(['seo.title-multiple']);
  });

  it('flags a missing, blank or absurdly long description', () => {
    expect(rules(analyse({ metaDescription: null }))).toEqual(['seo.description-missing']);
    expect(rules(analyse({ metaDescription: '  ' }))).toEqual(['seo.description-missing']);
    expect(rules(analyse({ metaDescription: 'd'.repeat(321) }))).toEqual(['seo.description-long']);
    expect(rules(analyse({ metaDescription: 'd'.repeat(320) }))).toEqual([]);
  });

  it('flags a missing canonical and duplicates of it', () => {
    expect(rules(analyse({ canonical: null, canonicalCount: 0 }))).toEqual([
      'seo.canonical-missing',
    ]);
    expect(rules(analyse({ canonicalCount: 2 }))).toEqual(['seo.canonical-multiple']);
  });

  it('flags a canonical that points at another site, but leaves staging hosts to the staging check', () => {
    const other = analyse({ canonical: 'https://www.example.org/page' });
    expect(other[0]).toMatchObject({
      rule: 'seo.canonical-other-host',
      severity: 'warning',
      resourceUrl: 'https://www.example.org/page',
    });
    expect(rules(analyse({ canonical: 'https://shop.staging.example.com/page' }))).toEqual([]);
    expect(rules(analyse({ canonical: 'https://my-site.netlify.app/page' }))).toEqual([]);
  });

  it('treats noindex as critical, however it is written', () => {
    for (const robots of ['noindex', 'NOINDEX, follow', 'index, noindex', 'none']) {
      const drafts = analyse({ robotsMeta: robots });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ rule: 'seo.noindex', severity: 'critical' });
    }
    expect(analyse({ robotsMeta: 'index, follow' })).toEqual([]);
    expect(analyse({ robotsMeta: 'nofollow' })).toEqual([]);
  });

  it('flags a missing h1 and a missing lang', () => {
    expect(rules(analyse({ h1Count: 0 }))).toEqual(['seo.h1-missing']);
    expect(rules(analyse({ lang: null }))).toEqual(['seo.lang-missing']);
    expect(rules(analyse({ lang: '' }))).toEqual(['seo.lang-missing']);
  });

  it('lists exactly which social tags are missing', () => {
    const drafts = analyse({ ogTags: { 'og:title': 't' } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'seo.og-missing',
      severity: 'warning',
      evidence: { missing: ['og:description', 'og:image'] },
    });
    expect(drafts[0]?.message).toContain('og:description, og:image');
    expect(
      rules(analyse({ ogTags: { 'og:title': '', 'og:description': 'd', 'og:image': 'i' } })),
    ).toEqual(['seo.og-missing']);
  });

  it('gives page-level rules no subject, so identical problems group across pages', () => {
    for (const draft of analyse({ title: null, metaDescription: null, h1Count: 0 })) {
      expect(draft.subject).toBeNull();
    }
  });
});

describe('findDuplicates', () => {
  const page = (id: string, title: string, description = '') => ({
    pageId: id,
    url: `https://www.example.com/${id}`,
    title,
    description,
  });

  it('reports every page that shares a title, ignoring case and blanks', () => {
    const found = findDuplicates([
      page('a', 'Products'),
      page('b', 'products'),
      page('c', 'Contact'),
      page('d', ''),
      page('e', ''),
    ]);
    expect(found.map((entry) => [entry.rule, entry.page.pageId]).sort()).toEqual([
      ['seo.title-duplicate', 'a'],
      ['seo.title-duplicate', 'b'],
    ]);
    expect(found[0]?.others).toEqual(['https://www.example.com/b']);
  });

  it('checks descriptions separately, and lists at most three other pages', () => {
    const pages = ['a', 'b', 'c', 'd', 'e'].map((id) => page(id, `Title ${id}`, 'Same words'));
    const found = findDuplicates(pages);
    expect(found).toHaveLength(5);
    expect(found.every((entry) => entry.rule === 'seo.description-duplicate')).toBe(true);
    expect(found[0]?.others).toHaveLength(3);
  });

  it('finds nothing when every page is unique', () => {
    expect(findDuplicates([page('a', 'A', 'x'), page('b', 'B', 'y')])).toEqual([]);
  });
});

describe('the seo check in a browser', () => {
  let runner: CheckRunner;
  beforeAll(async () => {
    runner = await createCheckRunner();
  }, 120_000);
  afterAll(async () => {
    await runner.close();
  });

  const run = async (path: string) => {
    const { drafts, loaded } = await runner.run(seoCheck, path);
    await loaded.close();
    return drafts;
  };

  it('finds nothing on a complete page', async () => {
    expect(rules(await run('/about'))).toEqual([]);
  });

  it('finds every problem on a page with none of the metadata', async () => {
    const drafts = await run('/no-meta');
    expect(rules(drafts)).toEqual([
      'seo.canonical-missing',
      'seo.description-missing',
      'seo.h1-missing',
      'seo.lang-missing',
      'seo.noindex',
      'seo.og-missing',
      'seo.title-missing',
    ]);
    expect(
      drafts
        .filter((draft) => draft.severity === 'critical')
        .map((d) => d.rule)
        .sort(),
    ).toEqual(['seo.noindex', 'seo.title-missing']);
  });

  it('reads duplicate tags, a foreign canonical, robots directives and a broken share image', async () => {
    const drafts = await run('/seo-bad');
    expect(rules(drafts)).toEqual([
      'seo.canonical-multiple',
      'seo.canonical-other-host',
      'seo.description-missing',
      'seo.h1-missing',
      'seo.lang-missing',
      'seo.noindex',
      'seo.og-image-broken',
      'seo.og-missing',
      'seo.title-long',
      'seo.title-multiple',
    ]);
    const broken = drafts.find((draft) => draft.rule === 'seo.og-image-broken');
    expect(broken).toMatchObject({
      severity: 'warning',
      resourceUrl: `${runner.sites.site.url}/images/missing-og.jpg`,
      evidence: { httpStatus: 404 },
    });
    expect(drafts.find((draft) => draft.rule === 'seo.og-missing')?.evidence).toEqual({
      missing: ['og:title'],
    });
  });

  it('does not judge a page that is not a success', async () => {
    expect(await run('/missing-page')).toEqual([]);
  });

  it('reports pages that share a title once the whole scan is done', async () => {
    const scan = runner.scanInfo();
    for (const path of ['/seo-dup-a', '/seo-dup-b', '/about']) {
      const { loaded } = await runner.run(seoCheck, path, { scan });
      await loaded.close();
    }
    const added: { pageId: string | null; draft: IssueDraft }[] = [];
    await seoCheck.finalize?.({
      scan,
      settings: { stagingPatterns: [], formTestEmail: 'qa@example.com' },
      sink: {
        add: (items) => {
          added.push(...items);
          return Promise.resolve(items.length);
        },
      },
      links: { verifyAll: () => Promise.resolve() },
      signal: new AbortController().signal,
      log: (await import('../test/harness.js')).silentLog,
    });
    // Both pages, for both the title and the description; /about is unique.
    expect(added.map((item) => item.draft.rule).sort()).toEqual([
      'seo.description-duplicate',
      'seo.description-duplicate',
      'seo.title-duplicate',
      'seo.title-duplicate',
    ]);
    expect(new Set(added.map((item) => item.draft.subject)).size).toBe(2);
    expect(added[0]?.draft.message).toContain('Shared title');
  });
});
