import type { Check, CheckContext, IssueDraft, NetworkEntry } from './types.js';

/** Latest network entry per URL. */
export function indexNetwork(entries: readonly NetworkEntry[]): Map<string, NetworkEntry> {
  const byUrl = new Map<string, NetworkEntry>();
  for (const entry of entries) byUrl.set(entry.url, entry);
  return byUrl;
}

function isBadStatus(status: number | null): boolean {
  return status !== null && status >= 400;
}

function describeFailure(entry: NetworkEntry | undefined): string {
  if (!entry) return '';
  if (isBadStatus(entry.status)) return ` (HTTP ${String(entry.status)})`;
  if (entry.failure) return ` (${entry.failure.replace(/^net::/, '')})`;
  return '';
}

/**
 * Broken images, missing alt text, and broken `srcset` and CSS background candidates.
 *
 * An image counts as broken when its request failed or answered 4xx/5xx, or when the browser
 * finished with it and it has no pixels and no successful response to explain that (an SVG without
 * intrinsic size legitimately reports width 0). Lazy images are covered because the page is
 * scrolled to the bottom before this runs.
 */
export const imagesCheck: Check = {
  id: 'images',
  label: 'Images',

  async run(ctx: CheckContext): Promise<IssueDraft[]> {
    const drafts: IssueDraft[] = [];
    const network = indexNetwork(ctx.observation.network);
    const seenNetworkUrls = new Set(network.keys());

    for (const img of ctx.dom.images) {
      const url = img.currentSrc ?? img.src;
      const entry = url ? network.get(url) : undefined;
      const requestFailed =
        entry !== undefined && (isBadStatus(entry.status) || entry.failure !== null);
      const loadedOk = entry !== undefined && entry.status !== null && entry.status < 400;
      const noPixels = img.complete && img.naturalWidth === 0 && url !== null;
      const broken = requestFailed || (noPixels && !loadedOk);

      if (broken && url) {
        drafts.push({
          rule: 'images.broken',
          severity: 'critical',
          message: `Image failed to load${describeFailure(entry)}.`,
          selector: img.selector,
          resourceUrl: url,
          evidence: {
            httpStatus: entry?.status ?? null,
            failure: entry?.failure ?? null,
            naturalWidth: img.naturalWidth,
            alt: img.alt,
            lazyLoaded: img.loading === 'lazy',
          },
        });
      }

      const tiny = img.width <= 1 || img.height <= 1;
      if (img.alt === null && !img.decorative && !tiny && url) {
        drafts.push({
          rule: 'images.missing-alt',
          severity: 'warning',
          message: 'Image has no alt attribute. Add alt text, or alt="" if it is decorative.',
          selector: img.selector,
          resourceUrl: url,
          evidence: { naturalWidth: img.naturalWidth },
        });
      }

      // Candidates the browser did not pick are never requested, so check them directly.
      for (const candidate of img.srcset) {
        if (seenNetworkUrls.has(candidate) || candidate === url) continue;
        seenNetworkUrls.add(candidate);
        const result = await ctx.probe(candidate);
        if (result.status === null || result.status >= 400) {
          drafts.push({
            rule: 'images.broken-srcset',
            severity: 'critical',
            message: `A srcset image candidate failed to load (${
              result.status === null
                ? (result.error?.message ?? 'no response')
                : `HTTP ${result.status}`
            }).`,
            selector: img.selector,
            resourceUrl: candidate,
            evidence: { httpStatus: result.status, error: result.error?.message ?? null },
          });
        }
      }
    }

    const seenBackgrounds = new Set<string>();
    for (const bg of ctx.dom.backgrounds) {
      if (seenBackgrounds.has(bg.url)) continue;
      seenBackgrounds.add(bg.url);
      const entry = network.get(bg.url);
      let status: number | null;
      let failure: string | null;
      if (entry) {
        status = entry.status;
        failure = entry.failure;
      } else {
        const result = await ctx.probe(bg.url);
        status = result.status;
        failure = result.error?.message ?? null;
      }
      if (isBadStatus(status) || (status === null && failure !== null)) {
        drafts.push({
          rule: 'images.broken-background',
          severity: 'critical',
          message: `A CSS background image failed to load${
            isBadStatus(status) ? ` (HTTP ${String(status)})` : ''
          }.`,
          selector: bg.selector,
          resourceUrl: bg.url,
          evidence: { httpStatus: status, failure },
        });
      }
    }

    return drafts;
  },
};
