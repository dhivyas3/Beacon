import { USER_AGENT } from '@qa-hub/shared';
import { assertPublicUrl, type HostResolver } from '@qa-hub/net';
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright';
import type { ConsoleEntry, DomSnapshot, NetworkEntry, PageObservation } from '../checks/types.js';
import { SCROLL_SCRIPT, SNAPSHOT_SCRIPT } from './snapshot-script.js';

export interface BrowserOptions {
  /** Extra Chromium flags. Tests use them to keep the browser off the real network. */
  args?: string[];
  allowLocal: boolean;
  resolver?: HostResolver | undefined;
  navigationTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface LoadedPage {
  page: Page;
  observation: PageObservation;
  dom: DomSnapshot;
  close(): Promise<void>;
}

const IGNORED_FAILURES = new Set(['net::ERR_ABORTED']);

/**
 * One headless Chromium for the duration of a scan. Every page gets its own isolated context, and
 * every request the browser makes, including subresources and redirects, passes the SSRF guard.
 */
export class BrowserSession {
  private constructor(
    private readonly browser: Browser,
    private readonly userAgent: string,
    private readonly options: BrowserOptions,
  ) {}

  static async launch(options: BrowserOptions): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless: true, args: options.args ?? [] });
    const probe = await browser.newContext();
    const page = await probe.newPage();
    const base = await page.evaluate('navigator.userAgent');
    await probe.close();
    return new BrowserSession(browser, `${String(base)} ${USER_AGENT}`, options);
  }

  /** Cache of host decisions for the guard, so DNS is resolved once per host. */
  private readonly hostDecisions = new Map<string, Promise<boolean>>();

  private isAllowedRequest(url: string): Promise<boolean> {
    if (/^(data|blob|about):/i.test(url)) return Promise.resolve(true);
    let key: string;
    try {
      key = new URL(url).origin;
    } catch {
      return Promise.resolve(false);
    }
    let decision = this.hostDecisions.get(key);
    if (!decision) {
      decision = assertPublicUrl(url, {
        allowLocal: this.options.allowLocal,
        ...(this.options.resolver ? { resolver: this.options.resolver } : {}),
      }).then(
        () => true,
        () => false,
      );
      this.hostDecisions.set(key, decision);
    }
    return decision;
  }

  private async newContext(): Promise<BrowserContext> {
    const context = await this.browser.newContext({
      userAgent: this.userAgent,
      viewport: { width: 1366, height: 900 },
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await context.route('**/*', async (route) => {
      if (await this.isAllowedRequest(route.request().url())) {
        await route.continue().catch(() => undefined);
      } else {
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
    return context;
  }

  /** Opens a page, waits for it to settle, scrolls it, and captures what it looks like. */
  async load(url: string, signal: AbortSignal): Promise<LoadedPage> {
    const context = await this.newContext();
    const onAbort = (): void => void context.close().catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });

    const network: NetworkEntry[] = [];
    const byRequest = new Map<Request, NetworkEntry>();
    const consoleEntries: ConsoleEntry[] = [];
    const pageErrors: string[] = [];

    try {
      const page = await context.newPage();

      page.on('request', (request) => {
        const entry: NetworkEntry = {
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          status: null,
          failure: null,
          blocked: false,
        };
        byRequest.set(request, entry);
        network.push(entry);
      });
      page.on('response', (response) => {
        const entry = byRequest.get(response.request());
        if (entry) entry.status = response.status();
      });
      page.on('requestfailed', (request) => {
        const entry = byRequest.get(request);
        if (!entry) return;
        entry.failure = request.failure()?.errorText ?? 'request failed';
        entry.blocked = entry.failure === 'net::ERR_BLOCKED_BY_CLIENT';
      });
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const location = message.location();
        consoleEntries.push({
          type: message.type(),
          text: message.text(),
          location: location.url ? `${location.url}:${location.lineNumber}` : null,
        });
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));

      let status: number | null = null;
      let loadError: string | null = null;
      try {
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: this.options.navigationTimeoutMs ?? 30_000,
        });
        status = response?.status() ?? null;
      } catch (error) {
        loadError =
          error instanceof Error
            ? (error.message.split('\n')[0] ?? 'Navigation failed')
            : 'Navigation failed';
      }

      const idle = this.options.idleTimeoutMs ?? 10_000;
      let dom: DomSnapshot;
      if (loadError === null) {
        await page.waitForLoadState('networkidle', { timeout: idle }).catch(() => undefined);
        await page.evaluate(SCROLL_SCRIPT).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
        dom = await page.evaluate(SNAPSHOT_SCRIPT);
      } else {
        dom = emptySnapshot();
      }

      const observation: PageObservation = {
        finalUrl: page.url() || url,
        status,
        loadError,
        // Requests aborted before any response (navigating away, cancelled media) are noise. An
        // aborted request that did get a status, such as a 404 script, is a real failure.
        network: network.filter(
          (entry) =>
            !(entry.failure && IGNORED_FAILURES.has(entry.failure) && entry.status === null),
        ),
        console: consoleEntries,
        pageErrors,
      };

      return {
        page,
        observation,
        dom,
        close: async () => {
          signal.removeEventListener('abort', onAbort);
          await context.close().catch(() => undefined);
        },
      };
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
  }
}

export function emptySnapshot(): DomSnapshot {
  return {
    title: null,
    titleCount: 0,
    metaDescription: null,
    canonical: null,
    canonicalCount: 0,
    robotsMeta: null,
    lang: null,
    h1Count: 0,
    ogTags: {},
    images: [],
    backgrounds: [],
    anchors: [],
    references: [],
    forms: [],
  };
}

/**
 * Outlines an element in red, scrolls it into view and takes a viewport screenshot. With no
 * selector, or one that does not match, the screenshot shows the page as it is.
 */
export async function captureHighlighted(page: Page, selector: string | null): Promise<Buffer> {
  let highlighted = false;
  if (selector) {
    highlighted = Boolean(
      await page
        .evaluate(
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            el.setAttribute('data-qa-prev-outline', el.style.outline || '');
            el.style.outline = '3px solid #ef4444';
            el.style.outlineOffset = '2px';
            return true;
          })()`,
        )
        .catch(() => false),
    );
  }
  try {
    return await page.screenshot({ type: 'png', fullPage: false, timeout: 10_000 });
  } finally {
    if (highlighted && selector) {
      await page
        .evaluate(
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el) { el.style.outline = el.getAttribute('data-qa-prev-outline') || ''; el.removeAttribute('data-qa-prev-outline'); }
          })()`,
        )
        .catch(() => undefined);
    }
  }
}
