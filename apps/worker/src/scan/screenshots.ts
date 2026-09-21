import { screenshotKey, type Storage } from '@beacon/storage';
import type { Page } from 'playwright';
import { captureHighlighted } from './browser.js';
import type { ScreenshotRequest } from './issue-writer.js';

/** Highlighted screenshots per page. Keeps a page with hundreds of broken images affordable. */
export const MAX_HIGHLIGHTED_PER_PAGE = 5;

/**
 * Screenshot policy for one loaded page: every critical issue gets a screenshot with its element
 * outlined in red, up to a cap. Critical issues with no element (the page returned 500, say) share
 * one plain screenshot of the page. Other severities get none.
 */
export class PageScreenshots {
  private highlighted = 0;
  private shared: Promise<string | null> | null = null;

  constructor(
    private readonly page: Page,
    private readonly storage: Storage,
    private readonly scanId: string,
    private readonly signal: AbortSignal,
  ) {}

  async forIssue(request: ScreenshotRequest): Promise<string | null> {
    // A check that took its own screenshot, such as a form's page after it was submitted, wins.
    if (request.draft.screenshotPng) return this.store(request.id, request.draft.screenshotPng);
    if (request.draft.severity !== 'critical') return null;
    // A stopped scan closes its pages. Do not wait for screenshots of pages that are gone.
    if (this.signal.aborted || this.page.isClosed()) return null;

    if (!request.draft.selector) {
      this.shared ??= this.capture(request.id, null);
      return this.shared;
    }
    if (this.highlighted >= MAX_HIGHLIGHTED_PER_PAGE) return null;
    this.highlighted += 1;
    return this.capture(request.id, request.draft.selector);
  }

  private async capture(issueId: string, selector: string | null): Promise<string | null> {
    try {
      return await this.store(issueId, await captureHighlighted(this.page, selector));
    } catch {
      return null; // a failed screenshot must never lose the issue it belongs to
    }
  }

  private async store(issueId: string, png: Buffer): Promise<string | null> {
    try {
      const key = screenshotKey(this.scanId, issueId);
      await this.storage.put(key, png, 'image/png');
      return key;
    } catch {
      return null;
    }
  }
}
