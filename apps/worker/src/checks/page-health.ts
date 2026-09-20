import { normalizeMessage } from '../util/fingerprint.js';
import type { Check, CheckContext, IssueDraft, NetworkEntry } from './types.js';

/** Resource types where a failure breaks the page rather than just a detail of it. */
const BLOCKING_TYPES = new Set(['script', 'stylesheet', 'document']);
/** Images are reported by the images check, so they are not repeated here. */
const COVERED_ELSEWHERE = new Set(['image']);
const ACTIVE_MIXED_TYPES = new Set([
  'script',
  'stylesheet',
  'xhr',
  'fetch',
  'document',
  'font',
  'websocket',
]);

function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

export interface MixedContentHit {
  url: string;
  active: boolean;
  source: 'request' | 'markup' | 'console';
}

/**
 * Insecure (http://) resources loaded by a secure (https://) page. Active content such as scripts
 * and styles is blocked by browsers and breaks the page, passive content such as images degrades
 * the padlock. Pure function so it can be tested without a browser.
 */
export function detectMixedContent(
  pageUrl: string,
  network: readonly NetworkEntry[],
  references: readonly { url: string; tag: string }[],
  consoleTexts: readonly string[],
): MixedContentHit[] {
  if (!pageUrl.startsWith('https://')) return [];
  const hits = new Map<string, MixedContentHit>();
  const add = (hit: MixedContentHit): void => {
    if (!hit.url.startsWith('http://') || isLocalHost(hit.url)) return;
    if (!hits.has(hit.url)) hits.set(hit.url, hit);
  };

  for (const entry of network) {
    add({ url: entry.url, active: ACTIVE_MIXED_TYPES.has(entry.resourceType), source: 'request' });
  }
  for (const ref of references) {
    add({
      url: ref.url,
      active: ref.tag === 'script' || ref.tag === 'iframe' || ref.tag === 'link',
      source: 'markup',
    });
  }
  for (const text of consoleTexts) {
    if (!/^Mixed Content:/i.test(text)) continue;
    const url = /'(http:\/\/[^']+)'/.exec(text)?.[1];
    if (url)
      add({ url, active: /script|stylesheet|XMLHttpRequest|fetch/i.test(text), source: 'console' });
  }
  return [...hits.values()];
}

/**
 * Overall health of a page: the document itself, JavaScript errors, failing requests and mixed
 * content. Console errors and uncaught exceptions are warnings because they may or may not affect
 * what a visitor sees. A missing script or stylesheet, or a page that will not load, is critical.
 */
export const pageHealthCheck: Check = {
  id: 'page-health',
  label: 'Page health',

  run(ctx: CheckContext): Promise<IssueDraft[]> {
    const { observation, dom } = ctx;
    const drafts: IssueDraft[] = [];

    if (observation.loadError !== null) {
      drafts.push({
        rule: 'page-health.load-failed',
        severity: 'critical',
        message: `The page could not be loaded: ${observation.loadError}`,
        subject: null,
        evidence: { error: observation.loadError },
      });
      return Promise.resolve(drafts);
    }

    if (observation.status !== null && (observation.status < 200 || observation.status >= 300)) {
      const bad = observation.status >= 400;
      drafts.push({
        rule: 'page-health.http-status',
        severity: bad ? 'critical' : 'warning',
        message: `The page returned HTTP ${String(observation.status)}.`,
        subject: String(observation.status),
        evidence: { httpStatus: observation.status, finalUrl: observation.finalUrl },
      });
    }

    for (const entry of observation.console) {
      if (/^Mixed Content:/i.test(entry.text)) continue; // reported as mixed content below
      // Chrome logs every failed resource as a console error too. The request itself is reported
      // below (or by the images check), so this would only repeat it.
      if (/^Failed to load resource/i.test(entry.text)) continue;
      drafts.push({
        rule: 'page-health.console-error',
        severity: 'warning',
        message: `JavaScript console error: ${entry.text.slice(0, 200)}`,
        subject: normalizeMessage(entry.text),
        evidence: { text: entry.text.slice(0, 1000), location: entry.location },
      });
    }

    for (const message of observation.pageErrors) {
      drafts.push({
        rule: 'page-health.js-exception',
        severity: 'warning',
        message: `Uncaught JavaScript exception: ${message.slice(0, 200)}`,
        subject: normalizeMessage(message),
        evidence: { message: message.slice(0, 1000) },
      });
    }

    const seen = new Set<string>();
    for (const entry of observation.network) {
      if (COVERED_ELSEWHERE.has(entry.resourceType)) continue;
      if (entry.blocked) {
        if (seen.has(entry.url)) continue;
        seen.add(entry.url);
        drafts.push({
          rule: 'page-health.blocked-request',
          severity: 'info',
          message: 'A request to a private or internal address was blocked for safety.',
          resourceUrl: entry.url,
          evidence: { resourceType: entry.resourceType },
        });
        continue;
      }
      const failed = entry.failure !== null || (entry.status !== null && entry.status >= 400);
      if (!failed || seen.has(entry.url)) continue;
      // The main document is reported above.
      if (entry.resourceType === 'document' && entry.url === observation.finalUrl) continue;
      seen.add(entry.url);
      const detail =
        entry.status !== null && entry.status >= 400
          ? `HTTP ${entry.status}`
          : (entry.failure ?? 'failed').replace(/^net::/, '');
      drafts.push({
        rule: 'page-health.failed-request',
        severity: BLOCKING_TYPES.has(entry.resourceType) ? 'critical' : 'warning',
        message: `A ${entry.resourceType} request failed (${detail}).`,
        resourceUrl: entry.url,
        evidence: {
          method: entry.method,
          resourceType: entry.resourceType,
          httpStatus: entry.status,
          failure: entry.failure,
        },
      });
    }

    const mixed = detectMixedContent(
      observation.finalUrl,
      observation.network.filter((entry) => !entry.blocked),
      [
        ...dom.references,
        ...dom.images.flatMap((img) => (img.src ? [{ url: img.src, tag: 'img' }] : [])),
      ],
      observation.console.map((entry) => entry.text),
    );
    for (const hit of mixed) {
      drafts.push({
        rule: 'page-health.mixed-content',
        severity: hit.active ? 'critical' : 'warning',
        message: `This secure page loads ${hit.active ? 'active' : 'passive'} content over insecure HTTP.`,
        resourceUrl: hit.url,
        evidence: { active: hit.active, detectedFrom: hit.source },
      });
    }

    return Promise.resolve(drafts);
  },
};
