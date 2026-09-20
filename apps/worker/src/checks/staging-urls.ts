import { matchesStagingPattern } from '@qa-hub/shared';
import type { Check, CheckContext, IssueDraft } from './types.js';

interface Reference {
  url: string;
  tag: string;
  attribute: string;
  selector: string | null;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Every URL the page points at or loads: links, images, scripts, styles, canonical, frames. */
export function collectReferences(ctx: CheckContext): Reference[] {
  const refs: Reference[] = [];
  for (const anchor of ctx.dom.anchors) {
    if (anchor.href) {
      refs.push({ url: anchor.href, tag: 'a', attribute: 'href', selector: anchor.selector });
    }
  }
  for (const img of ctx.dom.images) {
    const sources = [img.src, img.currentSrc, ...img.srcset];
    for (const src of sources) {
      if (src) refs.push({ url: src, tag: 'img', attribute: 'src', selector: img.selector });
    }
  }
  for (const bg of ctx.dom.backgrounds) {
    refs.push({ url: bg.url, tag: 'css', attribute: 'background-image', selector: bg.selector });
  }
  for (const ref of ctx.dom.references) {
    refs.push({ url: ref.url, tag: ref.tag, attribute: ref.attr, selector: ref.selector });
  }
  // Requests made by scripts never appear in the markup.
  for (const entry of ctx.observation.network) {
    refs.push({ url: entry.url, tag: 'network', attribute: entry.resourceType, selector: null });
  }
  return refs;
}

/**
 * Finds links, images, scripts, styles, canonicals and requests that point at staging or
 * development hosts (`localhost`, `staging.`, `dev.`, `*.netlify.app`, ... configurable), which is
 * the classic "we forgot to change the URL before launch" mistake. The site's own hostname is
 * exempt, so scanning a staging site does not flag every page.
 */
export const stagingUrlsCheck: Check = {
  id: 'staging-urls',
  label: 'Staging URLs',

  run(ctx: CheckContext): Promise<IssueDraft[]> {
    const drafts: IssueDraft[] = [];
    const seen = new Set<string>();

    for (const ref of collectReferences(ctx)) {
      if (seen.has(ref.url)) continue;
      const hostname = hostnameOf(ref.url);
      if (hostname === null || hostname === ctx.scan.hostname) continue;
      if (!matchesStagingPattern(hostname, ctx.settings.stagingPatterns)) continue;
      seen.add(ref.url);
      drafts.push({
        rule: 'staging-urls.reference',
        severity: 'critical',
        message: `Points to a staging or development address (${hostname}).`,
        selector: ref.selector,
        resourceUrl: ref.url,
        evidence: { hostname, tag: ref.tag, attribute: ref.attribute },
      });
    }
    return Promise.resolve(drafts);
  },
};
