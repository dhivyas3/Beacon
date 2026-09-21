import type { IssueDraft, SnapForm, SnapFormField } from './types.js';

/** Forms tested per scan. Bounds the number of submissions a scan can ever make. */
export const MAX_FORMS_PER_SCAN = 20;

export type SkipReason =
  | 'captcha'
  | 'login'
  | 'file-upload'
  | 'payment'
  | 'destructive'
  | 'external-action'
  | 'search'
  | 'no-submit'
  | 'no-fields';

const SKIP_TEXT: Record<SkipReason, string> = {
  captcha: 'It has a CAPTCHA, which cannot be solved automatically. Test it by hand.',
  login: 'It has a password field. QA Hub never signs in or submits credentials.',
  'file-upload': 'It uploads a file. QA Hub does not upload files to a live site.',
  payment: 'It looks like a payment form. QA Hub never submits payment details.',
  destructive:
    'Its button looks destructive or financial (delete, buy, pay). It was not submitted.',
  'external-action': 'It sends data to another site, which QA Hub does not submit to.',
  search: 'It is a search box.',
  'no-submit': 'It has no submit button.',
  'no-fields': 'It has no fields to fill in.',
};

export function skipMessage(reason: SkipReason): string {
  return SKIP_TEXT[reason];
}

const DESTRUCTIVE_BUTTON =
  /\b(delete|remove|erase|destroy|deactivate|unsubscribe|cancel (my |your )?(account|subscription|order)|pay|purchase|buy|checkout|place order|order now|donate)\b/i;
const PAYMENT_FIELD = /\b(card|cvv|cvc|iban|routing|account.?number)\b/i;

/** Field names use snake_case and camelCase, which word boundaries do not split. */
function spaced(text: string): string {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-zA-Z0-9]+/g, ' ');
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Decides whether a form may be interacted with, and why not. Anything that could sign in, pay,
 * delete, upload, or send data to a third party is never touched. Search boxes are read-only and
 * pointless to test.
 */
export function skipReasonFor(form: SnapForm, origin: string): SkipReason | null {
  if (form.isSearch) return 'search';
  if (form.hasCaptcha) return 'captcha';
  if (form.fields.some((field) => field.type === 'password')) return 'login';
  if (form.fields.some((field) => field.type === 'file')) return 'file-upload';
  if (
    form.fields.some(
      (field) =>
        (field.autocomplete ?? '').toLowerCase().startsWith('cc-') ||
        PAYMENT_FIELD.test(spaced(`${field.name ?? ''} ${field.label}`)),
    )
  ) {
    return 'payment';
  }
  if (DESTRUCTIVE_BUTTON.test(form.submitText)) return 'destructive';
  if (form.rawAction !== null && form.action !== null) {
    try {
      if (new URL(form.action).origin !== origin) return 'external-action';
    } catch {
      return 'external-action';
    }
  }
  if (!form.hasSubmit) return 'no-submit';
  if (form.fields.length === 0) return 'no-fields';
  return null;
}

/**
 * What makes two forms "the same form" across pages, so a newsletter box repeated in every footer
 * is tested once per scan rather than once per page.
 */
export function formIdentity(form: SnapForm): string {
  const names = form.fields.map((field) => field.name ?? field.type ?? field.tag).join(',');
  const target = form.rawAction === null ? 'self' : (form.action ?? 'self');
  return `${target}|${form.method}|${names}|${form.submitText}`;
}

/** Findings that need no interaction at all. Run in every form mode. */
export function structuralFindings(form: SnapForm, pageUrl: string): IssueDraft[] {
  const drafts: IssueDraft[] = [];
  const identity = formIdentity(form);
  const target = form.submitSelector ?? form.selector;
  let pageProtocol = '';
  let pageHost = '';
  try {
    const parsed = new URL(pageUrl);
    pageProtocol = parsed.protocol;
    pageHost = parsed.hostname;
  } catch {
    return drafts;
  }

  if (!form.hasSubmit && !form.isSearch && form.fields.length > 0) {
    drafts.push({
      rule: 'forms.no-submit',
      severity: 'warning',
      message: 'The form has no submit button. Visitors may not know how to send it.',
      selector: form.selector,
      resourceUrl: form.action,
      subject: identity,
      evidence: { fields: form.fields.length },
    });
  }

  if (form.action !== null && form.rawAction !== null) {
    let actionUrl: URL | null = null;
    try {
      actionUrl = new URL(form.action);
    } catch {
      actionUrl = null;
    }
    if (
      pageProtocol === 'https:' &&
      actionUrl !== null &&
      actionUrl.protocol === 'http:' &&
      !isLocalHost(actionUrl.hostname)
    ) {
      drafts.push({
        rule: 'forms.insecure-action',
        severity: 'critical',
        message: 'The form sends what visitors type over an insecure http:// address.',
        selector: target,
        resourceUrl: form.action,
        subject: identity,
        evidence: { action: form.action },
      });
    }
  }

  if (
    pageProtocol === 'http:' &&
    !isLocalHost(pageHost) &&
    form.fields.some((field) => field.type === 'password')
  ) {
    drafts.push({
      rule: 'forms.password-over-http',
      severity: 'critical',
      message:
        'A password field is on a page served over http://, so passwords travel unencrypted.',
      selector: form.selector,
      resourceUrl: pageUrl,
      subject: identity,
    });
  }

  return drafts;
}

// ---- Test data ---------------------------------------------------------------------------------

const DATE_VALUES: Record<string, string> = {
  date: '2030-01-15',
  time: '10:00',
  'datetime-local': '2030-01-15T10:00',
  month: '2030-01',
  week: '2030-W03',
};

function words(field: SnapFormField): string {
  return spaced(
    `${field.name ?? ''} ${field.label} ${field.placeholder ?? ''} ${field.autocomplete ?? ''}`,
  ).toLowerCase();
}

function fit(field: SnapFormField, value: string): string {
  let result = value;
  if (field.maxLength !== null && result.length > field.maxLength) {
    result = result.slice(0, field.maxLength);
  }
  if (field.minLength !== null && result.length < field.minLength) {
    result = result.padEnd(field.minLength, 'x');
  }
  return result;
}

/**
 * A plausible value for a field, or null when the field should be left alone. Test data is
 * obviously artificial so nobody mistakes it for a real enquiry.
 */
export function testValueFor(field: SnapFormField, testEmail: string): string | null {
  const type = (field.type ?? 'text').toLowerCase();
  if (field.disabled || field.readOnly) return null;
  if (type === 'checkbox' || type === 'radio') return field.required ? 'check' : null;
  if (field.tag === 'select') return field.options[0] ?? null;

  const hint = words(field);
  const wanted =
    field.required ||
    type === 'email' ||
    /\b(e ?mail|name|message|comment|enquiry|inquiry)\b/.test(hint);
  if (!wanted) return null;

  if (type === 'email' || /\be ?mail\b/.test(hint)) return fit(field, testEmail);
  if (type === 'tel' || /\b(phone|tel|mobile)\b/.test(hint)) return fit(field, '5550100199');
  if (type === 'url') return fit(field, 'https://example.com');
  if (type === 'number' || type === 'range') return field.min ?? '1';
  if (DATE_VALUES[type] !== undefined) return DATE_VALUES[type] ?? null;
  if (field.tag === 'textarea' || /\b(message|comment|enquiry|inquiry|details)\b/.test(hint)) {
    return fit(field, 'This is an automated test from QA Hub. Please ignore it.');
  }
  if (/\b(first|given)\b/.test(hint)) return fit(field, 'QA Hub');
  if (/\b(last|surname|family)\b/.test(hint)) return fit(field, 'Test');
  if (/\b(zip|postal|postcode)\b/.test(hint)) return fit(field, '12345');
  if (/\bcity|town\b/.test(hint)) return fit(field, 'Testville');
  if (/\b(company|organi[sz]ation|business)\b/.test(hint)) return fit(field, 'QA Hub Test');
  if (/\bname\b/.test(hint)) return fit(field, 'QA Hub Test');
  return fit(field, 'QA Hub test');
}

/** True when the form has at least one required field. */
export function hasRequiredFields(form: SnapForm): boolean {
  return form.fields.some((field) => field.required);
}

/** True when the form has an email field to try an invalid address in. */
export function emailField(form: SnapForm): SnapFormField | null {
  return (
    form.fields.find(
      (field) => (field.type ?? '').toLowerCase() === 'email' && !field.disabled && !field.readOnly,
    ) ?? null
  );
}
