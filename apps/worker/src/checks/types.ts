import type { CheckType, FormMode, Severity } from '@qa-hub/shared';
import type { Page } from 'playwright';
import type { UrlCheckResult } from '../http/url-checker.js';
import type { Logger } from '../logger.js';

/** A finding produced by a check, before it is stored. */
export interface IssueDraft {
  /** Stable id of the rule that fired, such as `images.broken`. Part of the fingerprint. */
  rule: string;
  severity: Severity;
  message: string;
  selector?: string | null;
  resourceUrl?: string | null;
  /**
   * What makes two findings of the same rule "the same problem". Defaults to `resourceUrl`.
   * Leave both empty for page-level rules such as "missing meta description".
   */
  subject?: string | null;
  evidence?: Record<string, unknown>;
}

// ---- What the browser saw while loading a page ---------------------------------------------

export interface NetworkEntry {
  url: string;
  method: string;
  resourceType: string;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  /** Browser error text such as `net::ERR_NAME_NOT_RESOLVED`. */
  failure: string | null;
  /** The request was refused by the SSRF guard. */
  blocked: boolean;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  location: string | null;
}

export interface PageObservation {
  /** URL after redirects. */
  finalUrl: string;
  /** Status of the main document, or null when it never loaded. */
  status: number | null;
  loadError: string | null;
  network: NetworkEntry[];
  console: ConsoleEntry[];
  pageErrors: string[];
}

// ---- What the page looked like once loaded (see snapshot-script.ts) --------------------------

export interface SnapImage {
  selector: string | null;
  rawSrc: string | null;
  src: string | null;
  currentSrc: string | null;
  alt: string | null;
  naturalWidth: number;
  complete: boolean;
  loading: string | null;
  width: number;
  height: number;
  decorative: boolean;
  srcset: string[];
}

export interface SnapAnchor {
  rawHref: string | null;
  href: string | null;
  text: string;
  selector: string | null;
  rel: string | null;
}

export interface SnapReference {
  tag: string;
  attr: string;
  url: string;
  selector: string | null;
  rel: string | null;
}

export interface SnapFormField {
  tag: string;
  type: string | null;
  name: string | null;
  required: boolean;
  selector: string | null;
}

export interface SnapForm {
  selector: string | null;
  rawAction: string | null;
  action: string | null;
  method: string;
  hasSubmit: boolean;
  hasCaptcha: boolean;
  noValidate: boolean;
  fields: SnapFormField[];
}

export interface DomSnapshot {
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  canonical: string | null;
  canonicalCount: number;
  robotsMeta: string | null;
  lang: string | null;
  h1Count: number;
  ogTags: Record<string, string>;
  images: SnapImage[];
  backgrounds: { selector: string | null; url: string }[];
  anchors: SnapAnchor[];
  references: SnapReference[];
  forms: SnapForm[];
}

// ---- Contexts handed to checks ----------------------------------------------------------------

export interface ScanInfo {
  id: string;
  /** The URL the scan started from, after redirects. */
  rootUrl: string;
  origin: string;
  hostname: string;
  checks: CheckType[];
  formMode: FormMode;
}

export interface ScanSettings {
  stagingPatterns: string[];
  formTestEmail: string;
}

export interface LinkCandidate {
  url: string;
  selector: string | null;
  text: string;
}

/** Collects every link found on every page, de-duplicated across the whole scan. */
export interface LinkCollector {
  register(pageId: string, links: LinkCandidate[]): Promise<void>;
}

export interface CheckContext {
  scan: ScanInfo;
  settings: ScanSettings;
  page: { id: string; url: string };
  observation: PageObservation;
  dom: DomSnapshot;
  /** The live page, for checks that need to interact with it. */
  browserPage: Page;
  /** Cached HEAD/GET status lookup shared by the whole scan. */
  probe: (url: string) => Promise<UrlCheckResult>;
  links: LinkCollector;
  isInternal: (url: string) => boolean;
  signal: AbortSignal;
  log: Logger;
}

/** Where a finished check reports scan-wide findings. */
export interface IssueSink {
  /** Stores findings. Returns how many were new (repeats on the same page are dropped). */
  add(items: { pageId: string | null; draft: IssueDraft }[], checkType: CheckType): Promise<number>;
}

export interface FinalizeContext {
  scan: ScanInfo;
  settings: ScanSettings;
  sink: IssueSink;
  /** Links collected by the pages, still to be verified. */
  links: LinkVerification;
  signal: AbortSignal;
  log: Logger;
}

export interface LinkVerification {
  /** Verifies every collected link once and reports problems through `sink`. */
  verifyAll(sink: IssueSink): Promise<void>;
}

/**
 * A check is one file. `run` inspects a loaded page. `finalize` is optional and runs once after
 * every page is done, for checks that need the whole site (link verification, duplicate titles).
 */
export interface Check {
  id: CheckType;
  label: string;
  run(context: CheckContext): Promise<IssueDraft[]>;
  finalize?(context: FinalizeContext): Promise<void>;
}
