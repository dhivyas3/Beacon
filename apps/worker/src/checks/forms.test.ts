import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCheckRunner, type CheckRunner } from '../test/harness.js';
import { formsCheck, TEST_HEADER } from './forms.js';
import {
  emailField,
  formIdentity,
  skipReasonFor,
  structuralFindings,
  testValueFor,
} from './forms-plan.js';
import type { IssueDraft, SnapForm, SnapFormField } from './types.js';

function field(overrides: Partial<SnapFormField> = {}): SnapFormField {
  return {
    tag: 'input',
    type: 'text',
    name: 'name',
    required: false,
    selector: '#f > input',
    label: '',
    placeholder: null,
    autocomplete: null,
    pattern: null,
    minLength: null,
    maxLength: null,
    min: null,
    max: null,
    disabled: false,
    readOnly: false,
    options: [],
    ...overrides,
  };
}

function form(overrides: Partial<SnapForm> = {}): SnapForm {
  return {
    selector: '#f',
    rawAction: '/send',
    action: 'https://www.example.com/send',
    method: 'post',
    hasSubmit: true,
    submitSelector: '#f > button',
    submitText: 'Send',
    hasCaptcha: false,
    isSearch: false,
    noValidate: false,
    fields: [field({ name: 'email', type: 'email', required: true })],
    ...overrides,
  };
}

const ORIGIN = 'https://www.example.com';

describe('skipReasonFor', () => {
  it('lets an ordinary contact form through', () => {
    expect(skipReasonFor(form(), ORIGIN)).toBeNull();
  });

  it('never touches login, payment, upload, captcha or third-party forms', () => {
    expect(skipReasonFor(form({ fields: [field({ type: 'password' })] }), ORIGIN)).toBe('login');
    expect(skipReasonFor(form({ fields: [field({ type: 'file' })] }), ORIGIN)).toBe('file-upload');
    expect(skipReasonFor(form({ hasCaptcha: true }), ORIGIN)).toBe('captcha');
    expect(skipReasonFor(form({ action: 'https://pay.example.net/x' }), ORIGIN)).toBe(
      'external-action',
    );
  });

  it('recognises payment fields by autocomplete, name and label', () => {
    expect(skipReasonFor(form({ fields: [field({ autocomplete: 'cc-number' })] }), ORIGIN)).toBe(
      'payment',
    );
    expect(skipReasonFor(form({ fields: [field({ name: 'card_number' })] }), ORIGIN)).toBe(
      'payment',
    );
    expect(skipReasonFor(form({ fields: [field({ label: 'CVV code' })] }), ORIGIN)).toBe('payment');
  });

  it('recognises destructive and financial buttons', () => {
    for (const text of [
      'Delete my account',
      'Buy now',
      'Pay $20',
      'Place order',
      'Unsubscribe',
      'Donate',
      'Checkout',
    ]) {
      expect(skipReasonFor(form({ submitText: text }), ORIGIN)).toBe('destructive');
    }
    expect(skipReasonFor(form({ submitText: 'Send message' }), ORIGIN)).toBeNull();
    expect(skipReasonFor(form({ submitText: 'Subscribe' }), ORIGIN)).toBeNull();
  });

  it('treats a form with no explicit action as the same site', () => {
    expect(skipReasonFor(form({ rawAction: null, action: `${ORIGIN}/page` }), ORIGIN)).toBeNull();
  });

  it('skips searches, forms with no button and forms with no fields', () => {
    expect(skipReasonFor(form({ isSearch: true }), ORIGIN)).toBe('search');
    expect(skipReasonFor(form({ hasSubmit: false }), ORIGIN)).toBe('no-submit');
    expect(skipReasonFor(form({ fields: [] }), ORIGIN)).toBe('no-fields');
  });
});

describe('formIdentity', () => {
  it('is the same for a form repeated on different pages, and different for another form', () => {
    const footer = { rawAction: null, action: 'https://www.example.com/a' };
    const same = { rawAction: null, action: 'https://www.example.com/b' };
    expect(formIdentity(form(footer))).toBe(formIdentity(form(same)));
    expect(formIdentity(form({ ...footer, submitText: 'Join' }))).not.toBe(
      formIdentity(form(footer)),
    );
    expect(formIdentity(form({ action: 'https://www.example.com/other' }))).not.toBe(
      formIdentity(form()),
    );
  });
});

describe('structuralFindings', () => {
  it('reports a form with no submit button, but not a search box', () => {
    const drafts = structuralFindings(
      form({ hasSubmit: false, submitSelector: null }),
      `${ORIGIN}/`,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ rule: 'forms.no-submit', severity: 'warning' });
    expect(structuralFindings(form({ hasSubmit: false, isSearch: true }), `${ORIGIN}/`)).toEqual(
      [],
    );
  });

  it('reports a secure page posting to an insecure address as critical', () => {
    const drafts = structuralFindings(
      form({ action: 'http://forms.example.net/send' }),
      `${ORIGIN}/`,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'forms.insecure-action',
      severity: 'critical',
      resourceUrl: 'http://forms.example.net/send',
    });
  });

  it('does not flag local development addresses or forms that post to https', () => {
    expect(
      structuralFindings(form({ action: 'http://localhost:3000/send' }), `${ORIGIN}/`),
    ).toEqual([]);
    expect(structuralFindings(form(), `${ORIGIN}/`)).toEqual([]);
    expect(structuralFindings(form({ action: 'http://a.test/x' }), 'http://a.test/')).toEqual([]);
  });

  it('reports a password field on an insecure page', () => {
    const login = form({ fields: [field({ type: 'password', name: 'pw' })] });
    const insecure = structuralFindings(login, 'http://www.example.com/login');
    expect(insecure.map((draft) => draft.rule)).toContain('forms.password-over-http');
    expect(structuralFindings(login, 'http://localhost:3000/login')).toEqual([]);
    expect(structuralFindings(login, 'https://www.example.com/login')).toEqual([]);
  });
});

describe('testValueFor', () => {
  it('uses the configured test address for email fields', () => {
    expect(testValueFor(field({ type: 'email' }), 'qa@acme.test')).toBe('qa@acme.test');
    expect(testValueFor(field({ type: 'text', name: 'email' }), 'qa@acme.test')).toBe(
      'qa@acme.test',
    );
  });

  it('fills required fields sensibly by type and by what they are called', () => {
    const value = (overrides: Partial<SnapFormField>) =>
      testValueFor(field({ required: true, ...overrides }), 'qa@acme.test');
    expect(value({ type: 'tel' })).toBe('5550100199');
    expect(value({ type: 'url' })).toBe('https://example.com');
    expect(value({ type: 'number' })).toBe('1');
    expect(value({ type: 'number', min: '18' })).toBe('18');
    expect(value({ type: 'date' })).toBe('2030-01-15');
    expect(value({ tag: 'textarea', type: 'textarea' })).toContain('automated test from QA Hub');
    expect(value({ name: 'first_name' })).toBe('QA Hub');
    expect(value({ name: 'surname' })).toBe('Test');
    expect(value({ name: 'postcode' })).toBe('12345');
    expect(value({ name: 'company' })).toBe('QA Hub Test');
    expect(value({ name: 'referral' })).toBe('QA Hub test');
  });

  it('respects length limits', () => {
    expect(testValueFor(field({ required: true, maxLength: 4 }), 'qa@acme.test')).toBe('QA H');
    expect(testValueFor(field({ required: true, name: 'zip', minLength: 8 }), 'x')).toBe(
      '12345xxx',
    );
  });

  it('leaves optional, disabled and read-only fields alone, and picks a select option', () => {
    expect(testValueFor(field({ name: 'nickname' }), 'x')).toBeNull();
    expect(testValueFor(field({ required: true, disabled: true }), 'x')).toBeNull();
    expect(testValueFor(field({ required: true, readOnly: true }), 'x')).toBeNull();
    expect(
      testValueFor(field({ tag: 'select', type: 'select-one', options: ['uk', 'us'] }), 'x'),
    ).toBe('uk');
    expect(testValueFor(field({ type: 'checkbox', required: true }), 'x')).toBe('check');
    expect(testValueFor(field({ type: 'checkbox' }), 'x')).toBeNull();
  });

  it('finds the email field to try a bad address in', () => {
    expect(emailField(form())?.name).toBe('email');
    expect(emailField(form({ fields: [field({ type: 'text' })] }))).toBeNull();
  });
});

// ---- In a real browser, against the fixture site ----------------------------------------------

describe('the forms check in a browser', () => {
  let runner: CheckRunner;
  beforeAll(async () => {
    runner = await createCheckRunner();
  }, 120_000);
  afterAll(async () => {
    await runner.close();
  });

  const rules = (drafts: IssueDraft[]): string[] => drafts.map((draft) => draft.rule).sort();

  async function run(path: string, mode: 'detect' | 'validate_only' | 'submit') {
    runner.sites.site.reset();
    const { drafts, loaded } = await runner.run(formsCheck, path, { formMode: mode });
    await loaded.close();
    return { drafts, submissions: runner.sites.site.submissions };
  }

  describe('detect mode', () => {
    it('never interacts with a form', async () => {
      for (const path of ['/form-good', '/form-broken', '/form-500', '/form-native']) {
        const { drafts, submissions } = await run(path, 'detect');
        expect(drafts).toEqual([]);
        expect(submissions).toEqual([]);
      }
    });

    it('still reports what the markup shows', async () => {
      const { drafts } = await run('/form-nosubmit', 'detect');
      expect(rules(drafts)).toEqual(['forms.no-submit']);
    });
  });

  describe('validate_only mode', () => {
    it('finds a working form healthy and sends nothing', async () => {
      const { drafts, submissions } = await run('/form-good', 'validate_only');
      expect(drafts).toEqual([]);
      expect(submissions).toEqual([]);
    });

    it('finds a form that accepts an empty submission, and still sends nothing', async () => {
      const { drafts, submissions } = await run('/form-broken', 'validate_only');
      expect(rules(drafts)).toEqual(['forms.no-validation']);
      expect(drafts[0]).toMatchObject({
        severity: 'warning',
        resourceUrl: `${runner.sites.site.url}/api/forms/broken`,
        selector: expect.stringContaining('button') as unknown,
      });
      expect(submissions).toEqual([]);
    });

    it('finds required fields that are marked but not enforced', async () => {
      const { drafts, submissions } = await run('/form-bypass', 'validate_only');
      expect(rules(drafts)).toEqual(['forms.validation-bypassed']);
      expect(submissions).toEqual([]);
    });

    it('finds an email field that accepts anything', async () => {
      const { drafts, submissions } = await run('/form-lax-email', 'validate_only');
      expect(rules(drafts)).toEqual(['forms.email-not-validated']);
      expect(drafts[0]?.message).toContain('not-an-email');
      expect(submissions).toEqual([]);
    });

    it('does not submit a form that fails on the server, only validates it', async () => {
      const { drafts, submissions } = await run('/form-500', 'validate_only');
      expect(drafts).toEqual([]);
      expect(submissions).toEqual([]);
    });

    it.each([
      ['/form-captcha', 'captcha'],
      ['/form-login', 'login'],
      ['/form-external', 'external-action'],
      ['/form-delete', 'destructive'],
    ])('leaves %s alone and says why', async (path, reason) => {
      const { drafts, submissions } = await run(path, 'validate_only');
      expect(rules(drafts)).toEqual(['forms.skipped']);
      expect(drafts[0]).toMatchObject({ severity: 'info', evidence: { reason } });
      expect(submissions).toEqual([]);
    });

    it('does not mention forms that are merely search boxes or missing a button', async () => {
      const { drafts } = await run('/form-nosubmit', 'validate_only');
      expect(rules(drafts)).toEqual(['forms.no-submit']);
    });
  });

  describe('submit mode', () => {
    it('submits a healthy form once, with clearly artificial data and an identifying header', async () => {
      const { drafts, submissions } = await run('/form-good', 'submit');
      expect(drafts).toEqual([]);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.testHeader).toBe('form-submission');
      expect(TEST_HEADER).toBe('x-qahub-test');
      expect(submissions[0]?.body).toContain('qa-test@example.com');
      expect(submissions[0]?.body).toContain('QA Hub Test');
    });

    it('reports a form whose server fails as critical, with a screenshot of what visitors see', async () => {
      const { drafts, submissions } = await run('/form-500', 'submit');
      expect(submissions).toHaveLength(1);
      expect(rules(drafts)).toEqual(['forms.submit-failed']);
      const draft = drafts[0];
      expect(draft).toMatchObject({
        severity: 'critical',
        evidence: { httpStatus: 500 },
        resourceUrl: `${runner.sites.site.url}/api/forms/500`,
      });
      expect(draft?.message).toContain('HTTP 500');
      // PNG signature.
      expect(draft?.screenshotPng?.subarray(0, 4).toString('hex')).toBe('89504e47');
    });

    it('reports a rejected submission as a warning, not a failure', async () => {
      const { drafts } = await run('/form-422', 'submit');
      expect(rules(drafts)).toEqual(['forms.submit-rejected']);
      expect(drafts[0]).toMatchObject({ severity: 'warning', evidence: { httpStatus: 422 } });
    });

    it('reports a form that is sent but never confirms', async () => {
      const { drafts, submissions } = await run('/form-silent', 'submit');
      expect(submissions).toHaveLength(1);
      expect(rules(drafts)).toEqual(['forms.no-confirmation']);
    });

    it('reports an error message shown after a successful response', async () => {
      const { drafts } = await run('/form-soft-error', 'submit');
      expect(rules(drafts)).toEqual(['forms.error-shown']);
      expect(drafts[0]?.message).toContain('Sorry, something went wrong');
    });

    it('reports a submit button that sends nothing', async () => {
      const { drafts, submissions } = await run('/form-dead', 'submit');
      expect(submissions).toEqual([]);
      expect(rules(drafts)).toEqual(['forms.submit-no-request']);
    });

    it('follows a normal form post to its thank-you page', async () => {
      const { drafts, submissions } = await run('/form-native', 'submit');
      expect(submissions).toHaveLength(1);
      expect(drafts).toEqual([]);
    });

    it('also reports validation problems on the same form', async () => {
      const { drafts, submissions } = await run('/form-broken', 'submit');
      expect(rules(drafts)).toContain('forms.no-validation');
      expect(submissions.length).toBeGreaterThanOrEqual(1);
    });

    it.each(['/form-captcha', '/form-login', '/form-external', '/form-delete'])(
      'never submits %s',
      async (path) => {
        const { drafts, submissions } = await run(path, 'submit');
        expect(rules(drafts)).toEqual(['forms.skipped']);
        expect(submissions).toEqual([]);
      },
    );

    it('tests the same form only once per scan, however many pages show it', async () => {
      runner.sites.site.reset();
      const scan = runner.scanInfo('submit');
      for (const path of ['/form-good', '/form-good', '/form-good']) {
        const { loaded } = await runner.run(formsCheck, path, { scan });
        await loaded.close();
      }
      expect(runner.sites.site.submissions).toHaveLength(1);
    });
  });
});
