import { normalizeUrl } from '@qa-hub/shared';
import type { UrlCheckResult } from '../http/url-checker.js';
import type { Check, CheckContext, FinalizeContext, IssueDraft, LinkCandidate } from './types.js';

/** Statuses external sites commonly return to bots even though the page works for people. */
const BOT_BLOCKED_STATUSES = new Set([401, 403, 429, 999]);

/** Every distinct http(s) link on a page, normalised, without links to the page itself. */
export function linksOfPage(ctx: CheckContext): LinkCandidate[] {
  const own = normalizeUrl(ctx.page.url);
  const seen = new Set<string>();
  const links: LinkCandidate[] = [];
  for (const anchor of ctx.dom.anchors) {
    if (!anchor.href) continue;
    const url = normalizeUrl(anchor.href);
    if (url === null || seen.has(url)) continue;
    // In-page anchors such as "#contact" point at the current page.
    if (url === own && anchor.rawHref?.startsWith('#')) continue;
    seen.add(url);
    links.push({ url, selector: anchor.selector, text: anchor.text });
  }
  return links;
}

/**
 * Turns the result of verifying one link into findings. Returns nothing for a healthy link.
 * `external` links that answer 401/403/429/999 are warnings, because those sites often refuse
 * automated requests even though the page works in a browser.
 */
export function classifyLink(result: UrlCheckResult, external: boolean): IssueDraft[] {
  const evidence = {
    httpStatus: result.status,
    finalUrl: result.finalUrl,
    hops: result.hops,
    method: result.method,
    external,
  };

  if (result.error) {
    if (result.error.code === 'aborted') return [];
    return [
      {
        rule: 'links.unreachable',
        severity: 'critical',
        message: `Link could not be reached: ${result.error.message}`,
        resourceUrl: result.url,
        evidence: { ...evidence, error: result.error },
      },
    ];
  }

  if (result.redirectLimitReached) {
    return [
      {
        rule: 'links.redirect-loop',
        severity: 'critical',
        message: 'Link redirects too many times or in a loop.',
        resourceUrl: result.url,
        evidence: { ...evidence, chain: result.chain },
      },
    ];
  }

  const status = result.status;
  if (status !== null && status >= 400) {
    if (external && BOT_BLOCKED_STATUSES.has(status)) {
      return [
        {
          rule: 'links.unverifiable',
          severity: 'warning',
          message: `The site did not allow an automated check (HTTP ${status}), so this link could not be verified.`,
          resourceUrl: result.url,
          evidence,
        },
      ];
    }
    return [
      {
        rule: 'links.broken',
        severity: 'critical',
        message: `Broken link (HTTP ${status}).`,
        resourceUrl: result.url,
        evidence,
      },
    ];
  }

  if (result.hops >= 3) {
    return [
      {
        rule: 'links.redirect-chain',
        severity: 'warning',
        message: `Link redirects ${result.hops} times before reaching its destination. Point it at the final URL.`,
        resourceUrl: result.url,
        evidence: { ...evidence, chain: result.chain },
      },
    ];
  }
  return [];
}

/**
 * Collects every `<a href>` on every page, de-duplicated across the whole scan, and verifies each
 * unique URL once when all pages are done. A broken link on 200 pages is one request and 200
 * findings that group into one row.
 */
export const linksCheck: Check = {
  id: 'links',
  label: 'Links',

  async run(ctx: CheckContext): Promise<IssueDraft[]> {
    await ctx.links.register(ctx.page.id, linksOfPage(ctx));
    return [];
  },

  async finalize(ctx: FinalizeContext): Promise<void> {
    await ctx.links.verifyAll(ctx.sink);
  },
};
