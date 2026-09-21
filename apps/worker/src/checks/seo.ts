import { matchesStagingPattern } from '@qa-hub/shared';
import type { Check, CheckContext, DomSnapshot, FinalizeContext, IssueDraft } from './types.js';

/** Longer titles are cut off in search results. Short ones are not flagged: "Contact" is fine. */
export const TITLE_MAX = 70;
/** Search engines show about 160 characters, but will read far more. Only absurd lengths are flagged. */
export const DESCRIPTION_MAX = 320;

const OG_REQUIRED = ['og:title', 'og:description', 'og:image'] as const;

export interface SeoInput {
  pageUrl: string;
  dom: DomSnapshot;
  /** Hostname of the site being scanned, to spot canonicals that point elsewhere. */
  hostname: string;
  stagingPatterns: readonly string[];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Page-level SEO findings from what the browser saw, without any network access. Pure so every
 * rule can be tested with a plain object. Severity follows what a launch would suffer: a page
 * hidden from search engines or without a title is critical, missing metadata is a warning.
 */
export function analyseSeo(input: SeoInput): IssueDraft[] {
  const { dom } = input;
  const drafts: IssueDraft[] = [];
  const title = dom.title?.trim() ?? '';
  const description = dom.metaDescription?.trim() ?? '';

  if (title === '') {
    drafts.push({
      rule: 'seo.title-missing',
      severity: 'critical',
      message: 'The page has no title. It appears as a bare address in search results and tabs.',
      subject: null,
    });
  } else if (title.length > TITLE_MAX) {
    drafts.push({
      rule: 'seo.title-long',
      severity: 'warning',
      message: `The title is ${title.length} characters. Search results cut it off after about ${TITLE_MAX}.`,
      subject: null,
      evidence: { title, length: title.length },
    });
  }
  if (dom.titleCount > 1) {
    drafts.push({
      rule: 'seo.title-multiple',
      severity: 'warning',
      message: `The page has ${dom.titleCount} title tags. Only the first is used.`,
      subject: null,
      evidence: { count: dom.titleCount },
    });
  }

  if (description === '') {
    drafts.push({
      rule: 'seo.description-missing',
      severity: 'warning',
      message: 'The page has no meta description, so search engines pick a snippet at random.',
      subject: null,
    });
  } else if (description.length > DESCRIPTION_MAX) {
    drafts.push({
      rule: 'seo.description-long',
      severity: 'warning',
      message: `The meta description is ${description.length} characters. Only the first part is shown.`,
      subject: null,
      evidence: { length: description.length },
    });
  }

  if (dom.canonicalCount === 0 || dom.canonical === null) {
    drafts.push({
      rule: 'seo.canonical-missing',
      severity: 'warning',
      message: 'The page has no canonical link, so duplicates of it may compete in search.',
      subject: null,
    });
  } else {
    if (dom.canonicalCount > 1) {
      drafts.push({
        rule: 'seo.canonical-multiple',
        severity: 'warning',
        message: `The page has ${dom.canonicalCount} canonical links. Search engines may ignore all of them.`,
        subject: null,
        evidence: { count: dom.canonicalCount },
      });
    }
    const canonicalHost = hostOf(dom.canonical);
    // A canonical on a staging host is already reported, as critical, by the staging URLs check.
    if (
      canonicalHost !== null &&
      canonicalHost !== input.hostname &&
      !matchesStagingPattern(canonicalHost, [...input.stagingPatterns])
    ) {
      drafts.push({
        rule: 'seo.canonical-other-host',
        severity: 'warning',
        message: `The canonical link points to a different site (${canonicalHost}).`,
        subject: null,
        resourceUrl: dom.canonical,
        evidence: { canonicalHost },
      });
    }
  }

  const robots = dom.robotsMeta?.toLowerCase() ?? '';
  if (/\bnoindex\b|\bnone\b/.test(robots)) {
    drafts.push({
      rule: 'seo.noindex',
      severity: 'critical',
      message:
        'The page tells search engines not to index it (noindex). It will not appear in search results.',
      subject: null,
      evidence: { robots: dom.robotsMeta },
    });
  }

  if (dom.h1Count === 0) {
    drafts.push({
      rule: 'seo.h1-missing',
      severity: 'warning',
      message: 'The page has no main heading (h1).',
      subject: null,
    });
  }

  if (dom.lang === null || dom.lang.trim() === '') {
    drafts.push({
      rule: 'seo.lang-missing',
      severity: 'warning',
      message:
        'The html element has no lang attribute. Search engines and screen readers guess the language.',
      subject: null,
    });
  }

  const missingOg = OG_REQUIRED.filter((tag) => (dom.ogTags[tag] ?? '').trim() === '');
  if (missingOg.length > 0) {
    drafts.push({
      rule: 'seo.og-missing',
      severity: 'warning',
      message: `Social sharing tags are missing (${missingOg.join(', ')}). Shared links will look bare.`,
      subject: missingOg.join(','),
      evidence: { missing: missingOg },
    });
  }

  return drafts;
}

interface PageSeo {
  pageId: string;
  url: string;
  title: string;
  description: string;
}

/** Findings that need every page: the same title or description used on several pages. */
export function findDuplicates(
  pages: readonly PageSeo[],
): { rule: string; page: PageSeo; value: string; others: string[] }[] {
  const found: { rule: string; page: PageSeo; value: string; others: string[] }[] = [];
  const group = (rule: string, pick: (page: PageSeo) => string): void => {
    const byValue = new Map<string, PageSeo[]>();
    for (const page of pages) {
      const value = pick(page).trim();
      if (value === '') continue;
      const list = byValue.get(value.toLowerCase()) ?? [];
      list.push(page);
      byValue.set(value.toLowerCase(), list);
    }
    for (const list of byValue.values()) {
      if (list.length < 2) continue;
      for (const page of list) {
        found.push({
          rule,
          page,
          value: pick(page).trim(),
          others: list
            .filter((other) => other !== page)
            .slice(0, 3)
            .map((other) => other.url),
        });
      }
    }
  };
  group('seo.title-duplicate', (page) => page.title);
  group('seo.description-duplicate', (page) => page.description);
  return found;
}

/** Per scan, keyed by the scan info object so a finished or failed scan cannot leak memory. */
const collected = new WeakMap<object, PageSeo[]>();

function isSuccess(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/**
 * Titles, descriptions, canonicals, robots directives, headings, language and social tags. Pages
 * that did not answer with a 2xx are skipped, because an error page's title is not an SEO problem
 * and the page health check already reports the error. Sitemap findings come from discovery.
 */
export const seoCheck: Check = {
  id: 'seo',
  label: 'SEO',

  async run(ctx: CheckContext): Promise<IssueDraft[]> {
    if (!isSuccess(ctx.observation.status)) return [];

    const drafts = analyseSeo({
      pageUrl: ctx.page.url,
      dom: ctx.dom,
      hostname: ctx.scan.hostname,
      stagingPatterns: ctx.settings.stagingPatterns,
    });

    const image = ctx.dom.ogTags['og:image']?.trim();
    if (image) {
      let target: string | null = null;
      try {
        target = new URL(image, ctx.page.url).href;
      } catch {
        target = null;
      }
      if (target !== null && /^https?:/i.test(target)) {
        const result = await ctx.probe(target);
        if (result.status === null || result.status >= 400) {
          drafts.push({
            rule: 'seo.og-image-broken',
            severity: 'warning',
            message: `The social sharing image does not load (${
              result.status === null
                ? (result.error?.message ?? 'no response')
                : `HTTP ${result.status}`
            }).`,
            resourceUrl: target,
            evidence: { httpStatus: result.status, error: result.error?.message ?? null },
          });
        }
      }
    }

    const list = collected.get(ctx.scan) ?? [];
    list.push({
      pageId: ctx.page.id,
      url: ctx.page.url,
      title: ctx.dom.title?.trim() ?? '',
      description: ctx.dom.metaDescription?.trim() ?? '',
    });
    collected.set(ctx.scan, list);

    return drafts;
  },

  async finalize(ctx: FinalizeContext): Promise<void> {
    const pages = collected.get(ctx.scan) ?? [];
    collected.delete(ctx.scan);
    const duplicates = findDuplicates(pages);
    if (duplicates.length === 0) return;

    await ctx.sink.add(
      duplicates.map(({ rule, page, value, others }) => ({
        pageId: page.pageId,
        draft: {
          rule,
          severity: 'warning' as const,
          message:
            rule === 'seo.title-duplicate'
              ? `The title "${clip(value)}" is also used by other pages.`
              : `The meta description "${clip(value)}" is also used by other pages.`,
          subject: value.toLowerCase(),
          evidence: { value, alsoOn: others },
        },
      })),
      'seo',
    );
  },
};

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
