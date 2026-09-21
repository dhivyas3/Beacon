import type { Page, Request } from 'playwright';
import {
  emailField,
  formIdentity,
  hasRequiredFields,
  MAX_FORMS_PER_SCAN,
  skipMessage,
  skipReasonFor,
  structuralFindings,
  testValueFor,
  type SkipReason,
} from './forms-plan.js';
import type { Check, CheckContext, IssueDraft, SnapForm } from './types.js';

/** Header added to the requests QA Hub makes when it submits a form, so owners can filter them. */
export const TEST_HEADER = 'x-qahub-test';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SETTLE_MS = 700;
const RESPONSE_WAIT_MS = 8000;
const NO_REQUEST_MS = 3000;
const ERROR_WORDS =
  /\b(error|failed|failure|something went wrong|try again|unable to|could not|couldn't|sorry|invalid)\b/i;

interface FormState {
  /** Forms already handled in this scan, so one repeated on every page is tested once. */
  seen: Set<string>;
  tested: number;
}

const states = new WeakMap<object, FormState>();

function stateFor(scan: object): FormState {
  let state = states.get(scan);
  if (!state) {
    state = { seen: new Set(), tested: 0 };
    states.set(scan, state);
  }
  return state;
}

/** A page opened to try a form on, kept away from the page the other checks are using. */
interface Scratch {
  page: Page;
  writes: { url: string; method: string }[];
  close(): Promise<void>;
}

function originOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Opens the page again in the same browser context, which keeps the SSRF guard in force. With
 * `blockWrites`, every request that could change something on a server (anything but GET, HEAD or
 * OPTIONS) is refused after being recorded, so trying a form can never actually submit it.
 */
async function openScratch(
  ctx: CheckContext,
  form: SnapForm,
  options: { blockWrites: boolean },
): Promise<Scratch | null> {
  const page = await ctx.browserPage.context().newPage();
  page.setDefaultTimeout(5000);
  const relevantOrigins = new Set(
    [ctx.scan.origin, originOf(form.action)].filter((o): o is string => o !== null),
  );
  const writes: { url: string; method: string }[] = [];

  await page.route('**/*', async (route) => {
    const request = route.request();
    if (READ_METHODS.has(request.method())) {
      await route.fallback().catch(() => undefined);
      return;
    }
    const relevant =
      relevantOrigins.has(originOf(request.url()) ?? '') && request.resourceType() !== 'ping';
    if (relevant) writes.push({ url: request.url(), method: request.method() });
    if (options.blockWrites) {
      await route.abort('blockedbyclient').catch(() => undefined);
    } else if (relevant) {
      await route
        .fallback({ headers: { ...request.headers(), [TEST_HEADER]: 'form-submission' } })
        .catch(() => undefined);
    } else {
      await route.fallback().catch(() => undefined);
    }
  });

  const close = async (): Promise<void> => {
    await page.close().catch(() => undefined);
  };
  try {
    await page.goto(ctx.page.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
    if ((await page.locator(form.selector ?? '#__none__').count()) === 0) {
      await close();
      return null;
    }
    return { page, writes, close };
  } catch {
    await close();
    return null;
  }
}

/** Fills the form with obviously artificial data. `emailOverride` swaps in a different address. */
async function fillForm(
  page: Page,
  form: SnapForm,
  testEmail: string,
  emailOverride?: string,
): Promise<void> {
  for (const field of form.fields) {
    if (field.selector === null) continue;
    const isEmail = (field.type ?? '').toLowerCase() === 'email';
    const value =
      emailOverride !== undefined && isEmail ? emailOverride : testValueFor(field, testEmail);
    if (value === null) continue;
    const locator = page.locator(field.selector).first();
    try {
      if (!(await locator.isVisible())) continue;
      const type = (field.type ?? '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') await locator.check({ timeout: 2000 });
      else if (field.tag === 'select') await locator.selectOption(value, { timeout: 2000 });
      else await locator.fill(value, { timeout: 2000 });
    } catch {
      // A field that cannot be filled shows up as an invalid form afterwards.
    }
  }
}

async function clickSubmit(page: Page, form: SnapForm): Promise<boolean> {
  if (form.submitSelector === null) return false;
  try {
    await page.locator(form.submitSelector).first().click({ timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function invalidFieldCount(page: Page, form: SnapForm): Promise<number> {
  if (form.selector === null) return -1;
  try {
    const count = await page.evaluate(
      `(() => { const f = document.querySelector(${JSON.stringify(form.selector)}); return f ? f.querySelectorAll(':invalid').length : -1; })()`,
    );
    return typeof count === 'number' ? count : -1;
  } catch {
    return -1;
  }
}

async function bodyText(page: Page): Promise<string> {
  try {
    const text = await page.evaluate('document.body ? document.body.innerText : ""');
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

async function shot(page: Page): Promise<Buffer | undefined> {
  try {
    return await page.screenshot({ type: 'png', fullPage: false, timeout: 8000 });
  } catch {
    return undefined;
  }
}

function newLines(before: string, after: string): string[] {
  const known = new Set(before.split('\n').map((line) => line.trim()));
  return after
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !known.has(line));
}

function base(form: SnapForm, identity: string) {
  return {
    selector: form.submitSelector ?? form.selector,
    resourceUrl: form.action,
    subject: identity,
  };
}

// ---- Validation: nothing is ever sent ----------------------------------------------------------

/**
 * Submits the form empty, then (when it has an email field) with an invalid address, and checks
 * that the form refuses both. Every write is blocked, so this is safe on a live site in any mode.
 */
async function testValidation(
  ctx: CheckContext,
  form: SnapForm,
  identity: string,
): Promise<IssueDraft[]> {
  const drafts: IssueDraft[] = [];

  const empty = await openScratch(ctx, form, { blockWrites: true });
  if (empty === null) return drafts;
  let emptyAccepted = false;
  try {
    if (!(await clickSubmit(empty.page, form))) return drafts;
    await empty.page.waitForTimeout(SETTLE_MS);
    emptyAccepted = empty.writes.length > 0;
    if (emptyAccepted) {
      const required = hasRequiredFields(form);
      drafts.push({
        rule: required ? 'forms.validation-bypassed' : 'forms.no-validation',
        severity: 'warning',
        message: required
          ? 'Required fields are not enforced: the form was sent with them empty.'
          : 'The form accepts a completely empty submission.',
        ...base(form, identity),
        evidence: {
          requiredFields: form.fields.filter((f) => f.required).map((f) => f.name ?? f.type),
          attemptedRequest: empty.writes[0],
          noValidate: form.noValidate,
        },
      });
    }
  } finally {
    await empty.close();
  }

  const emailInput = emailField(form);
  if (emailInput !== null && !emptyAccepted) {
    const invalid = await openScratch(ctx, form, { blockWrites: true });
    if (invalid !== null) {
      try {
        await fillForm(invalid.page, form, ctx.settings.formTestEmail, 'not-an-email');
        if (await clickSubmit(invalid.page, form)) {
          await invalid.page.waitForTimeout(SETTLE_MS);
          if (invalid.writes.length > 0) {
            drafts.push({
              rule: 'forms.email-not-validated',
              severity: 'warning',
              message: 'The form accepted "not-an-email" as an email address.',
              ...base(form, identity),
              evidence: { field: emailInput.name, attemptedRequest: invalid.writes[0] },
            });
          }
        }
      } finally {
        await invalid.close();
      }
    }
  }
  return drafts;
}

// ---- Submission: only in submit mode -----------------------------------------------------------

interface Observed {
  status: number;
  method: string;
  url: string;
}

async function testSubmission(
  ctx: CheckContext,
  form: SnapForm,
  identity: string,
): Promise<IssueDraft[]> {
  const scratch = await openScratch(ctx, form, { blockWrites: false });
  if (scratch === null) return [];
  const { page } = scratch;
  const relevantOrigins = new Set(
    [ctx.scan.origin, originOf(form.action)].filter((o): o is string => o !== null),
  );

  const responses: Observed[] = [];
  const documents: Observed[] = [];
  const failures: string[] = [];
  const pageErrors: string[] = [];
  let submitted = false;

  const isWrite = (request: Request): boolean =>
    !READ_METHODS.has(request.method()) &&
    request.resourceType() !== 'ping' &&
    relevantOrigins.has(originOf(request.url()) ?? '');

  page.on('response', (response) => {
    const request = response.request();
    const entry = { status: response.status(), method: request.method(), url: response.url() };
    if (isWrite(request)) responses.push(entry);
    else if (submitted && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documents.push(entry);
    }
  });
  page.on('requestfailed', (request) => {
    if (isWrite(request)) failures.push(request.failure()?.errorText ?? 'request failed');
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await fillForm(page, form, ctx.settings.formTestEmail);
    const invalidBefore = await invalidFieldCount(page, form);
    const before = await bodyText(page);
    const urlBefore = page.url();

    submitted = true;
    if (!(await clickSubmit(page, form))) return [];

    const started = Date.now();
    let sign = false;
    while (Date.now() - started < RESPONSE_WAIT_MS && !ctx.signal.aborted) {
      if (responses.length > 0 || failures.length > 0 || page.url() !== urlBefore) {
        sign = true;
        break;
      }
      // A form that sends nothing does so at once, so do not wait the full time for it.
      if (Date.now() - started > NO_REQUEST_MS && documents.length === 0) break;
      await page.waitForTimeout(100);
    }
    if (ctx.signal.aborted) return [];
    if (sign) {
      await page.waitForTimeout(SETTLE_MS + 500);
      await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => undefined);
    }

    const write = responses.at(-1);
    const badDocument = documents.find((entry) => entry.status >= 500);
    const target = base(form, identity);

    if (failures.length > 0 || (write && write.status >= 500) || badDocument) {
      const status = write?.status ?? badDocument?.status ?? null;
      const screenshotPng = await shot(page);
      return [
        {
          rule: 'forms.submit-failed',
          severity: 'critical',
          message:
            status !== null
              ? `Submitting the form failed (HTTP ${status}). Visitors cannot use it.`
              : `Submitting the form failed (${failures[0] ?? 'no response'}). Visitors cannot use it.`,
          ...target,
          evidence: {
            httpStatus: status,
            request: write ?? null,
            failure: failures[0] ?? null,
            pageErrors: pageErrors.slice(0, 3),
          },
          ...(screenshotPng ? { screenshotPng } : {}),
        },
      ];
    }

    if (write && write.status >= 400) {
      const screenshotPng = await shot(page);
      return [
        {
          rule: 'forms.submit-rejected',
          severity: 'warning',
          message: `The server rejected the test submission (HTTP ${write.status}). It may be blocking automated requests or expecting other data.`,
          ...target,
          evidence: { httpStatus: write.status, request: write },
          ...(screenshotPng ? { screenshotPng } : {}),
        },
      ];
    }

    const navigated = page.url() !== urlBefore || documents.length > 0;
    if (!write && !navigated) {
      const invalid = await invalidFieldCount(page, form);
      if (invalid > 0 || invalidBefore > 0) {
        return [
          {
            rule: 'forms.unfilled',
            severity: 'info',
            message: `QA Hub could not fill in every required field with test data (${Math.max(invalid, invalidBefore)} still invalid), so the form was not submitted.`,
            ...target,
            evidence: { invalidFields: Math.max(invalid, invalidBefore) },
          },
        ];
      }
      const screenshotPng = await shot(page);
      return [
        {
          rule: 'forms.submit-no-request',
          severity: 'warning',
          message:
            'Clicking the submit button sent nothing. The form may be broken, or protected by a check that runs in the background.',
          ...target,
          evidence: { pageErrors: pageErrors.slice(0, 3) },
          ...(screenshotPng ? { screenshotPng } : {}),
        },
      ];
    }

    const after = await bodyText(page);
    const added = newLines(before, after);
    const errorLine = added.find((line) => ERROR_WORDS.test(line));
    if (errorLine !== undefined) {
      const screenshotPng = await shot(page);
      return [
        {
          rule: 'forms.error-shown',
          severity: 'warning',
          message: `The form was sent, but the page then showed a problem: "${errorLine.slice(0, 120)}".`,
          ...target,
          evidence: { httpStatus: write?.status ?? null, shown: errorLine.slice(0, 200) },
          ...(screenshotPng ? { screenshotPng } : {}),
        },
      ];
    }
    if (added.length === 0 && page.url() === urlBefore) {
      const screenshotPng = await shot(page);
      return [
        {
          rule: 'forms.no-confirmation',
          severity: 'warning',
          message:
            'The form was sent, but the page shows no confirmation. Visitors cannot tell it worked.',
          ...target,
          evidence: { httpStatus: write?.status ?? null },
          ...(screenshotPng ? { screenshotPng } : {}),
        },
      ];
    }
    return [];
  } catch (error) {
    if (ctx.signal.aborted) return [];
    ctx.log.warn({ err: error, url: ctx.page.url }, 'form submission test failed');
    return [];
  } finally {
    await scratch.close();
  }
}

// ---- The check ---------------------------------------------------------------------------------

function skipped(form: SnapForm, identity: string, reason: SkipReason): IssueDraft {
  return {
    rule: 'forms.skipped',
    severity: 'info',
    message: `A form was not tested. ${skipMessage(reason)}`,
    selector: form.selector,
    resourceUrl: form.action,
    subject: `${identity}|${reason}`,
    evidence: { reason },
  };
}

/** Reasons that are not worth an entry in the report: obvious or already reported elsewhere. */
const SILENT_SKIPS = new Set<SkipReason>(['search', 'no-submit', 'no-fields']);

/**
 * Forms are checked at the level the scan asks for.
 *
 * - `detect` looks at the markup only and never interacts with the page.
 * - `validate_only` also submits each form empty and with a bad email address inside a copy of the
 *   page where every write request is blocked, so nothing is ever sent.
 * - `submit` additionally fills the form with test data and really submits it once per scan, to
 *   prove it works. It needs the `forms:submit` scope, which the API enforces before the scan is
 *   created.
 *
 * Login, payment, file upload, CAPTCHA and third-party forms are never touched. Each distinct form
 * is tested once per scan, and no more than {@link MAX_FORMS_PER_SCAN} forms are tested.
 */
export const formsCheck: Check = {
  id: 'forms',
  label: 'Forms',

  async run(ctx: CheckContext): Promise<IssueDraft[]> {
    const drafts: IssueDraft[] = [];
    const mode = ctx.scan.formMode;
    const state = stateFor(ctx.scan);

    for (const form of ctx.dom.forms) {
      drafts.push(...structuralFindings(form, ctx.page.url));
      if (mode === 'detect' || ctx.signal.aborted) continue;

      const identity = formIdentity(form);
      if (state.seen.has(identity)) continue;
      state.seen.add(identity);

      const reason = skipReasonFor(form, ctx.scan.origin);
      if (reason !== null) {
        if (!SILENT_SKIPS.has(reason)) drafts.push(skipped(form, identity, reason));
        continue;
      }
      if (state.tested >= MAX_FORMS_PER_SCAN) continue;
      state.tested += 1;

      drafts.push(...(await testValidation(ctx, form, identity)));
      if (mode === 'submit' && !ctx.signal.aborted) {
        drafts.push(...(await testSubmission(ctx, form, identity)));
      }
    }
    return drafts;
  },
};
