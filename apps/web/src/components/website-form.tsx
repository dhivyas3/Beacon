import {
  CHECK_FREQUENCIES,
  CHECK_LABELS,
  CHECK_TYPES,
  FORM_MODES,
  NOTIFY_PREFERENCES,
  PAGE_SELECTION_MODES,
  SAMPLE_SIZE,
  WEEKDAYS,
  computeNextCheckAt,
  type CheckFrequency,
  type CheckType,
  type FormMode,
  type NotifyPreference,
  type PageSelectionMode,
  type Website,
} from '@beacon/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiClientError } from '@/api/client';
import { useSession } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldError, FieldHint, Input, Label, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/states';
import { formatDateTime, parseScanUrl } from '@/lib/format';
import { localTimeOfUtcHour, parseUrlLines } from '@/lib/website';

export const FORM_MODE_LABELS: Record<FormMode, { label: string; hint: string }> = {
  detect: { label: 'Detect only', hint: 'Record forms and fields. Nothing is sent.' },
  validate_only: {
    label: 'Validate only',
    hint: 'Try each form empty and with a bad email address, and check it refuses. Every request that could send data is blocked, so nothing reaches the server.',
  },
  submit: {
    label: 'Submit test data',
    hint: 'Send each distinct form once with clearly marked test data. This reaches the real site and can create real enquiries. Login, payment, CAPTCHA and third-party forms are never touched.',
  },
};

const FREQUENCY_LABELS: Record<CheckFrequency, string> = {
  manual: 'Only when I start it',
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
};

const SELECTION_LABELS: Record<PageSelectionMode, { label: string; hint: string }> = {
  random_sample: {
    label: 'A random sample',
    hint: 'A fresh handful of pages each check. The homepage is always included, and pages not yet checked are preferred, so coverage grows over time.',
  },
  static_list: {
    label: 'A fixed list of pages',
    hint: 'Exactly the pages you list, every time.',
  },
  full: {
    label: 'Every page',
    hint: 'Find and check every page. Thorough, and slow on a large site.',
  },
};

const NOTIFY_LABELS: Record<NotifyPreference, string> = {
  every_check: 'Every report',
  new_issues_only: 'Only when something is new',
};

export interface RecipientDraft {
  email: string;
  name: string;
  notify: NotifyPreference;
}

export interface WebsiteFormValues {
  name: string;
  url: string;
  checkFrequency: CheckFrequency;
  scheduleDayOfWeek: number | null;
  scheduleDayOfMonth: number | null;
  scheduleHourUtc: number;
  pageSelectionMode: PageSelectionMode;
  sampleSize: number;
  pinnedPageUrls: string[];
  staticPageUrls: string[];
  enabledChecks: CheckType[];
  formMode: FormMode;
  emailEnabled: boolean;
  /** Only sent when adding a website. Existing recipients are managed on the website page. */
  recipients: { email: string; name: string | null; notify: NotifyPreference }[];
}

export type FieldErrors = Partial<Record<string, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Server problems that belong to a field, from either the 400 or the 422 shape. */
export function fieldErrorsFromApi(error: unknown): {
  fields: FieldErrors;
  general: string | null;
} {
  if (!(error instanceof ApiClientError)) {
    return { fields: {}, general: 'Something went wrong. Try again.' };
  }
  const details = error.details as
    | {
        problems?: { field: string; message: string }[];
        issues?: { path: string; message: string }[];
        hostname?: string;
      }
    | undefined;
  const fields: FieldErrors = {};
  for (const problem of details?.problems ?? []) fields[problem.field] ??= problem.message;
  for (const issue of details?.issues ?? []) {
    const field = issue.path.split('.')[0] ?? '';
    if (field) fields[field] ??= issue.message;
  }
  if (Object.keys(fields).length > 0) return { fields, general: null };
  if (details?.hostname !== undefined || error.code === 'conflict') {
    return { fields: { url: error.message }, general: null };
  }
  return { fields: {}, general: error.message };
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="mt-1.5">{children({ id, describedBy, invalid: Boolean(error) })}</div>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      {!error && hint ? <FieldHint id={`${id}-hint`}>{hint}</FieldHint> : null}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-card sm:p-5">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function initialValues(website: Website | undefined): {
  values: Omit<WebsiteFormValues, 'pinnedPageUrls' | 'staticPageUrls' | 'recipients'>;
  pinned: string;
  fixed: string;
  recipients: RecipientDraft[];
} {
  if (!website) {
    return {
      values: {
        name: '',
        url: '',
        checkFrequency: 'weekly',
        scheduleDayOfWeek: 1,
        scheduleDayOfMonth: 1,
        scheduleHourUtc: 6,
        pageSelectionMode: 'random_sample',
        sampleSize: SAMPLE_SIZE.default,
        enabledChecks: [...CHECK_TYPES],
        formMode: 'validate_only',
        emailEnabled: true,
      },
      pinned: '',
      fixed: '',
      recipients: [{ email: '', name: '', notify: 'every_check' }],
    };
  }
  return {
    values: {
      name: website.name,
      url: website.url,
      checkFrequency: website.checkFrequency,
      scheduleDayOfWeek: website.scheduleDayOfWeek ?? 1,
      scheduleDayOfMonth: website.scheduleDayOfMonth ?? 1,
      scheduleHourUtc: website.scheduleHourUtc,
      pageSelectionMode: website.pageSelectionMode,
      sampleSize: website.sampleSize,
      enabledChecks: website.enabledChecks,
      formMode: website.formMode,
      emailEnabled: website.emailEnabled,
    },
    pinned: website.pinnedPageUrls.join('\n'),
    fixed: website.staticPageUrls.join('\n'),
    recipients: [],
  };
}

interface WebsiteFormProps {
  /** The website being edited, or nothing when adding one. */
  website?: Website;
  submitLabel: string;
  pending: boolean;
  serverError: unknown;
  onSubmit: (values: WebsiteFormValues) => void;
  onCancel: () => void;
}

/** Adds or edits a website: schedule, which pages, which checks, forms, and who gets the email. */
export function WebsiteForm({
  website,
  submitLabel,
  pending,
  serverError,
  onSubmit,
  onCancel,
}: WebsiteFormProps) {
  const session = useSession();
  const canSubmitForms = session.data?.scopes.includes('forms:submit') ?? false;
  const formRef = useRef<HTMLFormElement>(null);
  const start = initialValues(website);

  const [values, setValues] = useState(start.values);
  const [pinnedText, setPinnedText] = useState(start.pinned);
  const [fixedText, setFixedText] = useState(start.fixed);
  const [recipients, setRecipients] = useState<RecipientDraft[]>(start.recipients);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const editing = website !== undefined;
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  // What the server said about a rejected form, next to the fields it concerns.
  useEffect(() => {
    if (!serverError) return;
    const mapped = fieldErrorsFromApi(serverError);
    setErrors(mapped.fields);
    setGeneral(mapped.general);
    setAttempt((count) => count + 1);
  }, [serverError]);

  // Move focus to the first field with a problem, so a keyboard or screen reader user lands on it.
  useEffect(() => {
    if (attempt === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt]);

  const nextCheck = computeNextCheckAt(
    {
      checkFrequency: values.checkFrequency,
      scheduleDayOfWeek: values.scheduleDayOfWeek,
      scheduleDayOfMonth: values.scheduleDayOfMonth,
      scheduleHourUtc: values.scheduleHourUtc,
    },
    new Date(),
  );
  const localHour = localTimeOfUtcHour(values.scheduleHourUtc);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const found: FieldErrors = {};

    const name = values.name.trim();
    if (name === '') found.name = 'Give the website a name, for example the client or brand.';
    const url = parseScanUrl(values.url);
    if (url === null) found.url = 'Enter a full site address, for example https://www.example.com.';

    const base = url ?? 'https://placeholder.invalid';
    const pinned = parseUrlLines(pinnedText, base);
    const fixed = parseUrlLines(fixedText, base);
    if (values.pageSelectionMode === 'random_sample' && pinned.invalid.length > 0) {
      found.pinnedPageUrls = `These are not web addresses: ${pinned.invalid.slice(0, 3).join(', ')}.`;
    }
    if (values.pageSelectionMode === 'static_list') {
      if (fixed.invalid.length > 0) {
        found.staticPageUrls = `These are not web addresses: ${fixed.invalid.slice(0, 3).join(', ')}.`;
      } else if (fixed.urls.length === 0) {
        found.staticPageUrls = 'Add at least one page, or choose another way to pick pages.';
      }
    }
    if (
      values.pageSelectionMode === 'random_sample' &&
      (!Number.isInteger(values.sampleSize) ||
        values.sampleSize < SAMPLE_SIZE.min ||
        values.sampleSize > SAMPLE_SIZE.max)
    ) {
      found.sampleSize = `Enter a whole number from ${SAMPLE_SIZE.min} to ${SAMPLE_SIZE.max}.`;
    }
    if (values.enabledChecks.length === 0) found.enabledChecks = 'Pick at least one check.';

    const filled = recipients.filter((row) => row.email.trim() !== '');
    const badRecipient = filled.findIndex((row) => !EMAIL.test(row.email.trim()));
    if (badRecipient !== -1) {
      found[`recipient-${badRecipient}`] = 'Enter a valid email address.';
    }

    setGeneral(null);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setAttempt((count) => count + 1);
      return;
    }

    onSubmit({
      ...values,
      name,
      url: url ?? values.url,
      scheduleDayOfWeek: values.checkFrequency === 'weekly' ? values.scheduleDayOfWeek : null,
      scheduleDayOfMonth: values.checkFrequency === 'monthly' ? values.scheduleDayOfMonth : null,
      pinnedPageUrls: values.pageSelectionMode === 'random_sample' ? pinned.urls : [],
      staticPageUrls: values.pageSelectionMode === 'static_list' ? fixed.urls : [],
      recipients: filled.map((row) => ({
        email: row.email.trim(),
        name: row.name.trim() === '' ? null : row.name.trim(),
        notify: row.notify,
      })),
    });
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-5" aria-label="Website">
      {general ? (
        <Alert tone="critical" title="The website could not be saved">
          {general}
        </Alert>
      ) : null}

      <Section title="The website">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name} hint="Shown in the dashboard and in emails.">
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                value={values.name}
                onChange={(event) => set('name', event.target.value)}
                placeholder="Example Estates"
                maxLength={100}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <Field
            label="Address"
            error={errors.url}
            hint={
              editing
                ? 'The address can change, but must stay on the same hostname.'
                : 'The hostname must be on the allowed domains list in Settings.'
            }
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="url"
                inputMode="url"
                value={values.url}
                onChange={(event) => set('url', event.target.value)}
                placeholder="https://www.example.com"
                className="font-mono text-[13px]"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section
        title="Schedule"
        description="When Beacon checks the website by itself. You can always start a check by hand."
      >
        <div className="flex flex-wrap items-end gap-4">
          <Field label="How often">
            {({ id }) => (
              <Select
                id={id}
                value={values.checkFrequency}
                onChange={(event) => set('checkFrequency', event.target.value as CheckFrequency)}
              >
                {CHECK_FREQUENCIES.map((frequency) => (
                  <option key={frequency} value={frequency}>
                    {FREQUENCY_LABELS[frequency]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {values.checkFrequency === 'weekly' ? (
            <Field label="On">
              {({ id }) => (
                <Select
                  id={id}
                  value={values.scheduleDayOfWeek ?? 1}
                  onChange={(event) => set('scheduleDayOfWeek', Number(event.target.value))}
                >
                  {WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          {values.checkFrequency === 'monthly' ? (
            <Field label="On day">
              {({ id }) => (
                <Select
                  id={id}
                  value={values.scheduleDayOfMonth ?? 1}
                  onChange={(event) => set('scheduleDayOfMonth', Number(event.target.value))}
                >
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          {values.checkFrequency !== 'manual' ? (
            <Field label="At (UTC)">
              {({ id }) => (
                <Select
                  id={id}
                  value={values.scheduleHourUtc}
                  onChange={(event) => set('scheduleHourUtc', Number(event.target.value))}
                >
                  {Array.from({ length: 24 }, (_, hour) => hour).map((hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, '0')}:00
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
        {values.checkFrequency === 'monthly' && (values.scheduleDayOfMonth ?? 1) > 28 ? (
          <FieldHint>Months with fewer days are checked on their last day.</FieldHint>
        ) : null}
        {values.checkFrequency !== 'manual' ? (
          <p className="text-[13px] text-muted">
            Times are in UTC{localHour ? `, which is ${localHour} for you` : ''}.
            {nextCheck ? (
              <>
                {' '}
                First check:{' '}
                <strong className="font-medium text-fg">
                  {formatDateTime(nextCheck.toISOString())}
                </strong>{' '}
                in your time zone.
              </>
            ) : null}
          </p>
        ) : null}
      </Section>

      <Section
        title="Pages to check"
        description="Checking a few representative pages is quick, and a different few each time covers the whole site over time."
      >
        <fieldset>
          <legend className="sr-only">How pages are chosen</legend>
          <div className="space-y-2.5">
            {PAGE_SELECTION_MODES.map((mode) => (
              <label key={mode} className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="radio"
                  name="page-selection"
                  value={mode}
                  checked={values.pageSelectionMode === mode}
                  onChange={() => set('pageSelectionMode', mode)}
                  className="mt-1 accent-[var(--accent)]"
                />
                <span>
                  <span className="block text-[13px] font-medium text-fg">
                    {SELECTION_LABELS[mode].label}
                  </span>
                  <span className="block text-xs text-muted">{SELECTION_LABELS[mode].hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {values.pageSelectionMode === 'random_sample' ? (
          <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
            <Field label="Number of pages" error={errors.sampleSize} hint="Includes the homepage.">
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  min={SAMPLE_SIZE.min}
                  max={SAMPLE_SIZE.max}
                  value={Number.isNaN(values.sampleSize) ? '' : values.sampleSize}
                  onChange={(event) =>
                    set(
                      'sampleSize',
                      event.target.value === '' ? Number.NaN : Number(event.target.value),
                    )
                  }
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field
              label="Pages to always include (optional)"
              error={errors.pinnedPageUrls}
              hint="One per line. A path such as /contact is fine. The homepage is always included."
            >
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  rows={3}
                  value={pinnedText}
                  onChange={(event) => setPinnedText(event.target.value)}
                  placeholder={'/contact\n/pricing'}
                  className="font-mono text-[13px]"
                  spellCheck={false}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                />
              )}
            </Field>
          </div>
        ) : null}

        {values.pageSelectionMode === 'static_list' ? (
          <Field
            label="Pages"
            error={errors.staticPageUrls}
            hint="One per line. A path such as /contact is fine. They must be on the website's address."
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={5}
                value={fixedText}
                onChange={(event) => setFixedText(event.target.value)}
                placeholder={'/\n/about\n/contact'}
                className="font-mono text-[13px]"
                spellCheck={false}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
              />
            )}
          </Field>
        ) : null}
      </Section>

      <Section title="Checks">
        <fieldset>
          <legend className="sr-only">Checks to run</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {CHECK_TYPES.map((check) => {
              const id = `website-check-${check}`;
              return (
                <div key={check} className="flex items-center gap-2.5">
                  <Checkbox
                    id={id}
                    checked={values.enabledChecks.includes(check)}
                    onCheckedChange={(value) =>
                      set(
                        'enabledChecks',
                        value === true
                          ? [...values.enabledChecks, check]
                          : values.enabledChecks.filter((item) => item !== check),
                      )
                    }
                    aria-invalid={errors.enabledChecks ? true : undefined}
                  />
                  <Label htmlFor={id}>{CHECK_LABELS[check]}</Label>
                </div>
              );
            })}
          </div>
          {errors.enabledChecks ? <FieldError>{errors.enabledChecks}</FieldError> : null}
        </fieldset>

        <fieldset className="border-t border-border pt-4">
          <legend className="text-[13px] font-semibold text-fg">Forms</legend>
          <div className="mt-2 space-y-2.5">
            {FORM_MODES.map((mode) => {
              const locked = mode === 'submit' && !canSubmitForms;
              return (
                <label
                  key={mode}
                  className={`flex items-start gap-2.5 ${locked ? 'opacity-60' : 'cursor-pointer'}`}
                >
                  <input
                    type="radio"
                    name="form-mode"
                    value={mode}
                    checked={values.formMode === mode}
                    disabled={locked}
                    onChange={() => set('formMode', mode)}
                    className="mt-1 accent-[var(--accent)]"
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-fg">
                      {FORM_MODE_LABELS[mode].label}
                    </span>
                    <span className="block text-xs text-muted">
                      {locked
                        ? 'Needs the forms:submit permission. Ask an admin for a key or account that has it.'
                        : FORM_MODE_LABELS[mode].hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </Section>

      <Section
        title="Email reports"
        description="Every completed check is emailed to the recipients below."
      >
        <div className="flex items-center gap-2.5">
          <Checkbox
            id="email-enabled"
            checked={values.emailEnabled}
            onCheckedChange={(value) => set('emailEnabled', value === true)}
          />
          <Label htmlFor="email-enabled">Email a report after each check</Label>
        </div>

        {editing ? (
          <p className="text-[13px] text-muted">
            Add, pause and remove recipients on the website page. Changes there apply straight away.
          </p>
        ) : (
          <div className="space-y-3">
            {recipients.map((row, index) => {
              const error = errors[`recipient-${index}`];
              return (
                <div
                  key={index}
                  className="grid gap-2 sm:grid-cols-[1fr_180px_auto_auto] sm:items-start"
                >
                  <div>
                    <Label htmlFor={`recipient-email-${index}`} className="sr-only">
                      Recipient email {index + 1}
                    </Label>
                    <Input
                      id={`recipient-email-${index}`}
                      type="email"
                      value={row.email}
                      placeholder="owner@example.com"
                      autoComplete="off"
                      onChange={(event) =>
                        setRecipients(
                          recipients.map((entry, at) =>
                            at === index ? { ...entry, email: event.target.value } : entry,
                          ),
                        )
                      }
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `recipient-error-${index}` : undefined}
                    />
                    {error ? (
                      <FieldError id={`recipient-error-${index}`}>{error}</FieldError>
                    ) : null}
                  </div>
                  <div>
                    <Label htmlFor={`recipient-name-${index}`} className="sr-only">
                      Recipient name {index + 1}
                    </Label>
                    <Input
                      id={`recipient-name-${index}`}
                      value={row.name}
                      placeholder="Name (optional)"
                      maxLength={100}
                      onChange={(event) =>
                        setRecipients(
                          recipients.map((entry, at) =>
                            at === index ? { ...entry, name: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor={`recipient-notify-${index}`} className="sr-only">
                      What recipient {index + 1} receives
                    </Label>
                    <Select
                      id={`recipient-notify-${index}`}
                      value={row.notify}
                      onChange={(event) =>
                        setRecipients(
                          recipients.map((entry, at) =>
                            at === index
                              ? { ...entry, notify: event.target.value as NotifyPreference }
                              : entry,
                          ),
                        )
                      }
                    >
                      {NOTIFY_PREFERENCES.map((preference) => (
                        <option key={preference} value={preference}>
                          {NOTIFY_LABELS[preference]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove recipient ${index + 1}`}
                    onClick={() => setRecipients(recipients.filter((_, at) => at !== index))}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
              );
            })}
            <Button
              size="sm"
              onClick={() =>
                setRecipients([...recipients, { email: '', name: '', notify: 'every_check' }])
              }
            >
              <Plus className="size-3.5" aria-hidden />
              Add recipient
            </Button>
            {recipients.every((row) => row.email.trim() === '') ? (
              <FieldHint>
                Without a recipient nothing is emailed. You can add people later.
              </FieldHint>
            ) : null}
          </div>
        )}
      </Section>

      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
