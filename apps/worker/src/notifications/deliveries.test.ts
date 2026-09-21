import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@beacon/db';
import { createSafeClient } from '@beacon/net';
import {
  CallbackPayloadSchema,
  newId,
  verifyCallbackSignature,
  verifyRecipientToken,
} from '@beacon/shared';
import { createIsolatedDatabase, type TestDatabase } from '@beacon/testkit';
import { pino } from 'pino';
import {
  attemptCallback,
  attemptEmail,
  DELIVERY_ATTEMPTS,
  planNotifications,
  retryDelayMs,
  type NotifyDeps,
} from './deliveries.js';
import {
  PermanentEmailError,
  TransientEmailError,
  type EmailMessage,
  type EmailSender,
} from './email-sender.js';
import { buildEmailData } from './report-data.js';

const SECRET = 'test-signing-secret-0123456789abcdef';
const CONFIG = {
  PUBLIC_URL: 'https://beacon.test',
  WEBHOOK_SIGNING_SECRET: SECRET,
  EMAIL_FROM: 'reports@beacon.test',
  EMAIL_FROM_NAME: 'Beacon',
};
const log = pino({ level: 'silent' });

let database: TestDatabase;
let db: Db;
let ownerId: string;
let counter = 0;

/** Records what it was asked to send, and fails on demand. */
class FakeSender implements EmailSender {
  readonly name = 'fake';
  readonly sent: EmailMessage[] = [];
  failWith: Error[] = [];
  send(message: EmailMessage) {
    const failure = this.failWith.shift();
    if (failure) return Promise.reject(failure);
    this.sent.push(message);
    return Promise.resolve({ messageId: `msg_${this.sent.length}` });
  }
}

let sender: FakeSender;
let queuedEmails: string[];
let queuedCallbacks: string[];

function makeDeps(overrides: Partial<NotifyDeps> = {}): NotifyDeps {
  return {
    db,
    config: CONFIG,
    log,
    sender,
    client: createSafeClient({ allowLocal: true, userAgent: 'BeaconBot/1.0' }),
    enqueueEmail: (id) => {
      queuedEmails.push(id);
      return Promise.resolve();
    },
    enqueueCallback: (id) => {
      queuedCallbacks.push(id);
      return Promise.resolve();
    },
    ...overrides,
  };
}

beforeAll(async () => {
  database = await createIsolatedDatabase();
  db = createDb({ url: database.url, log: false });
  ownerId = newId('usr');
  await db.user.create({
    data: { id: ownerId, email: 'owner@example.com', passwordHash: 'x', name: 'Owner' },
  });
});

afterAll(async () => {
  await db.$disconnect();
  await database.drop();
});

// ---- Scenario building ----------------------------------------------------------------------------

interface Recipient {
  email: string;
  name?: string | null;
  isActive?: boolean;
  notify?: 'every_check' | 'new_issues_only';
}

async function insertScan(input: {
  hostname: string;
  runNumber: number;
  websiteId?: string | null;
  status?: 'completed' | 'failed' | 'cancelled' | 'running';
  score?: number | null;
  critical?: number;
  warnings?: number;
  finishedAt?: Date;
  callbackUrl?: string | null;
  metadata?: Record<string, unknown>;
  errorMessage?: string | null;
  pages?: number;
  createdAt?: Date;
}): Promise<string> {
  const id = newId('scn');
  const status = input.status ?? 'completed';
  await db.scan.create({
    data: {
      id,
      url: `https://${input.hostname}/`,
      hostname: input.hostname,
      runNumber: input.runNumber,
      status,
      checks: ['images', 'seo'],
      websiteId: input.websiteId ?? null,
      healthScore: input.score === undefined ? 80 : input.score,
      criticalCount: input.critical ?? 0,
      warningCount: input.warnings ?? 0,
      pagesTotal: input.pages ?? 3,
      callbackUrl: input.callbackUrl ?? null,
      metadata: input.metadata as never,
      errorMessage: input.errorMessage ?? null,
      pageSelectionMode: input.websiteId ? 'random_sample' : 'full',
      triggeredByType: input.websiteId ? 'scheduled' : 'manual_api',
      createdAt: input.createdAt ?? new Date(Date.UTC(2026, 5, input.runNumber)),
      startedAt: new Date(Date.UTC(2026, 5, input.runNumber, 0, 0)),
      finishedAt:
        status === 'running'
          ? null
          : (input.finishedAt ?? new Date(Date.UTC(2026, 5, input.runNumber, 0, 5))),
    },
  });
  return id;
}

async function addIssue(
  scanId: string,
  pageUrl: string | null,
  fingerprint: string,
  severity: 'critical' | 'warning' | 'info',
  message: string,
  extra: { state?: 'open' | 'ignored'; checkType?: string } = {},
): Promise<void> {
  let pageId: string | null = null;
  if (pageUrl !== null) {
    const existing = await db.scanPage.findFirst({ where: { scanId, url: pageUrl } });
    pageId =
      existing?.id ??
      (
        await db.scanPage.create({
          data: { id: newId('pg'), scanId, url: pageUrl, status: 'done' },
        })
      ).id;
  }
  await db.scanIssue.create({
    data: {
      id: newId('iss'),
      scanId,
      pageId,
      checkType: extra.checkType ?? 'seo',
      severity,
      fingerprint,
      message,
      state: extra.state ?? 'open',
      evidence: {},
    },
  });
}

interface Scenario {
  websiteId: string;
  hostname: string;
  scanId: string;
  previousId: string;
  recipients: { id: string; email: string }[];
}

/**
 * A website with two earlier checks and a current one. The current check has one new critical
 * issue, one new warning, a warning that is on two pages and was there before, and a broken link
 * on three pages that was there before. It also has an ignored issue and an info finding, which
 * must not count.
 */
async function makeCheck(
  options: {
    recipients?: Recipient[];
    emailEnabled?: boolean;
    callbackUrl?: string | null;
    status?: 'completed' | 'failed' | 'cancelled';
    withPrevious?: boolean;
    errorMessage?: string | null;
  } = {},
): Promise<Scenario> {
  counter += 1;
  const hostname = `site${counter}.example.com`;
  const website = await db.website.create({
    data: {
      id: newId('web'),
      name: `Site ${counter}`,
      url: `https://${hostname}/`,
      hostname,
      ownerId,
      enabledChecks: ['images', 'seo'],
      emailEnabled: options.emailEnabled ?? true,
      recipients: {
        create: (options.recipients ?? [{ email: 'a@example.com', name: 'Alex Owner' }]).map(
          (recipient) => ({
            id: newId('rcp'),
            email: recipient.email,
            name: recipient.name ?? null,
            isActive: recipient.isActive ?? true,
            notify: recipient.notify ?? 'every_check',
          }),
        ),
      },
    },
    include: { recipients: true },
  });

  let previousId = '';
  if (options.withPrevious !== false) {
    await insertScan({ hostname, runNumber: 1, websiteId: website.id, score: 70 });
    previousId = await insertScan({
      hostname,
      runNumber: 2,
      websiteId: website.id,
      score: 78,
      critical: 2,
      warnings: 2,
    });
    const pA = `https://${hostname}/a`;
    const pB = `https://${hostname}/b`;
    await addIssue(previousId, pA, 'fp-old-fixed', 'critical', 'A problem that was fixed.');
    await addIssue(previousId, pA, 'fp-both', 'warning', 'A warning on two pages.');
    await addIssue(previousId, pB, 'fp-both', 'warning', 'A warning on two pages.');
    for (const page of ['a', 'b', 'c']) {
      await addIssue(
        previousId,
        `https://${hostname}/${page}`,
        'fp-link',
        'critical',
        'Broken link: /old.pdf',
        { checkType: 'links' },
      );
    }
  }

  const scanId = await insertScan({
    hostname,
    runNumber: 3,
    websiteId: website.id,
    status: options.status ?? 'completed',
    score: options.status === 'failed' ? null : 61,
    critical: 3,
    warnings: 4,
    pages: 5,
    callbackUrl: options.callbackUrl ?? null,
    errorMessage: options.errorMessage ?? null,
    metadata: { mondayItemId: '42' },
  });
  const pA = `https://${hostname}/a`;
  const pB = `https://${hostname}/b`;
  await addIssue(scanId, pA, 'fp-new-crit', 'critical', 'Submitting the form failed (HTTP 500).', {
    checkType: 'forms',
  });
  await addIssue(scanId, pB, 'fp-new-warn', 'warning', 'The page has no meta description.');
  await addIssue(scanId, pA, 'fp-both', 'warning', 'A warning on two pages.');
  await addIssue(scanId, pB, 'fp-both', 'warning', 'A warning on two pages.');
  for (const page of ['a', 'b', 'c']) {
    await addIssue(
      scanId,
      `https://${hostname}/${page}`,
      'fp-link',
      'critical',
      'Broken link: /old.pdf',
      { checkType: 'links' },
    );
  }
  await addIssue(scanId, pA, 'fp-ignored', 'critical', 'An ignored critical issue.', {
    state: 'ignored',
  });
  await addIssue(scanId, pA, 'fp-info', 'info', 'Only a note.');
  await addIssue(scanId, null, 'fp-sitewide', 'warning', 'No sitemap.xml was found.');

  return {
    websiteId: website.id,
    hostname,
    scanId,
    previousId,
    recipients: website.recipients.map((r) => ({ id: r.id, email: r.email })),
  };
}

// ---- Planning ---------------------------------------------------------------------------------

describe('planNotifications', () => {
  beforeAll(() => {
    sender = new FakeSender();
    queuedEmails = [];
    queuedCallbacks = [];
  });

  it('owes a callback and an email per active recipient, and queues each once', async () => {
    queuedEmails = [];
    queuedCallbacks = [];
    const check = await makeCheck({
      callbackUrl: 'https://n8n.example.com/webhook/beacon',
      recipients: [
        { email: 'a@example.com' },
        { email: 'b@example.com' },
        { email: 'off@example.com', isActive: false },
      ],
    });
    const plan = await planNotifications(makeDeps(), check.scanId);

    expect(plan.callbackId).not.toBeNull();
    expect(plan.emailIds).toHaveLength(2);
    expect(queuedCallbacks).toEqual([plan.callbackId]);
    expect(queuedEmails.sort()).toEqual([...plan.emailIds].sort());

    const emails = await db.emailDelivery.findMany({ where: { scanId: check.scanId } });
    expect(emails.map((e) => e.email).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(
      emails.every(
        (e) => e.status === 'pending' && e.attempts === 0 && e.websiteId === check.websiteId,
      ),
    ).toBe(true);
    const callback = await db.webhookDelivery.findUniqueOrThrow({
      where: { id: plan.callbackId as string },
    });
    expect(callback).toMatchObject({
      event: 'scan.completed',
      url: 'https://n8n.example.com/webhook/beacon',
      status: 'pending',
      attempt: 0,
    });
  });

  it('is safe to run twice: nothing is created or queued the second time', async () => {
    queuedEmails = [];
    queuedCallbacks = [];
    const check = await makeCheck({ callbackUrl: 'https://n8n.example.com/hook' });
    await planNotifications(makeDeps(), check.scanId);
    queuedEmails = [];
    queuedCallbacks = [];
    const again = await planNotifications(makeDeps(), check.scanId);
    expect(again).toEqual({ callbackId: null, emailIds: [] });
    expect(queuedEmails).toEqual([]);
    expect(queuedCallbacks).toEqual([]);
    expect(await db.emailDelivery.count({ where: { scanId: check.scanId } })).toBe(1);
    expect(await db.webhookDelivery.count({ where: { scanId: check.scanId } })).toBe(1);
  });

  it('sends no email when the website has email turned off, but still calls back', async () => {
    const check = await makeCheck({
      emailEnabled: false,
      callbackUrl: 'https://n8n.example.com/hook',
    });
    const plan = await planNotifications(makeDeps(), check.scanId);
    expect(plan.emailIds).toEqual([]);
    expect(plan.callbackId).not.toBeNull();
  });

  it('sends no email for a scan of no website, and no callback without a URL', async () => {
    const hostname = `oneoff${++counter}.example.com`;
    const scanId = await insertScan({ hostname, runNumber: 1, callbackUrl: null });
    expect(await planNotifications(makeDeps(), scanId)).toEqual({ callbackId: null, emailIds: [] });

    const withHook = await insertScan({
      hostname: `oneoff${++counter}.example.com`,
      runNumber: 1,
      callbackUrl: 'https://n8n.example.com/x',
    });
    const plan = await planNotifications(makeDeps(), withHook);
    expect(plan.callbackId).not.toBeNull();
    expect(plan.emailIds).toEqual([]);
  });

  it('calls back for a cancelled scan, with its own event, but never emails', async () => {
    const check = await makeCheck({
      status: 'cancelled',
      callbackUrl: 'https://n8n.example.com/hook',
    });
    const plan = await planNotifications(makeDeps(), check.scanId);
    expect(plan.emailIds).toEqual([]);
    const row = await db.webhookDelivery.findUniqueOrThrow({
      where: { id: plan.callbackId as string },
    });
    expect(row.event).toBe('scan.cancelled');
  });

  it('emails a failed check, so a site that is down is not silent', async () => {
    const check = await makeCheck({
      status: 'failed',
      errorMessage: 'Could not reach https://x.example.com/.',
    });
    const plan = await planNotifications(makeDeps(), check.scanId);
    expect(plan.emailIds).toHaveLength(1);
  });

  it('stays quiet for a failure that was only the worker restarting', async () => {
    const message = 'The worker restarted while this scan was running. Start it again.';
    const check = await makeCheck({
      status: 'failed',
      errorMessage: message,
      callbackUrl: 'https://n8n.example.com/hook',
    });
    const plan = await planNotifications(makeDeps({ quietFailureMessage: message }), check.scanId);
    expect(plan.emailIds).toEqual([]);
    expect(plan.callbackId).not.toBeNull();
  });

  it('does nothing for a scan that has not finished, or does not exist', async () => {
    const hostname = `running${++counter}.example.com`;
    const running = await insertScan({
      hostname,
      runNumber: 1,
      status: 'running',
      callbackUrl: 'https://n8n.example.com/x',
    });
    expect(await planNotifications(makeDeps(), running)).toEqual({
      callbackId: null,
      emailIds: [],
    });
    expect(await planNotifications(makeDeps(), 'scn_doesnotexist')).toEqual({
      callbackId: null,
      emailIds: [],
    });
  });
});

// ---- The data behind an email --------------------------------------------------------------------

describe('buildEmailData', () => {
  const ctx = { publicUrl: 'https://beacon.test/', secret: SECRET };

  it('describes a completed check: score, trend, and issues grouped by problem', async () => {
    const check = await makeCheck();
    const built = await buildEmailData(db, ctx, check.scanId, {
      ...check.recipients[0]!,
      name: 'Alex Owner',
    });
    expect(built).not.toBeNull();
    const data = built?.data;
    expect(data?.kind).toBe('report');
    if (data?.kind !== 'report') return;

    expect(data).toMatchObject({
      score: 61,
      previousScore: 78,
      critical: 3,
      warnings: 4,
      isFirstCheck: false,
      website: { hostname: check.hostname },
      recipient: { name: 'Alex Owner', email: 'a@example.com' },
      check: {
        runNumber: 3,
        pagesChecked: 5,
        trigger: 'Scheduled check',
        selection: '5 pages sampled, homepage included',
      },
    });

    // Distinct problems: a new critical, a new warning, a site-wide warning that was not there
    // before, and two that were (the two-page warning, and the link on three pages).
    expect(data.counts).toEqual({ newCritical: 1, newWarnings: 2, stillOpen: 2, totalOpen: 5 });

    const messages = data.issues.map(
      (issue) => `${issue.isNew ? 'NEW ' : ''}${issue.severity}: ${issue.message}`,
    );
    expect(messages).toEqual([
      'NEW critical: Submitting the form failed (HTTP 500).',
      'NEW warning: The page has no meta description.',
      'NEW warning: No sitemap.xml was found.',
      'critical: Broken link: /old.pdf',
      'warning: A warning on two pages.',
    ]);
    // Ignored and info findings are not in it.
    expect(messages.join('|')).not.toMatch(/ignored|Only a note/);

    const link = data.issues.find((issue) => issue.message.startsWith('Broken link'));
    expect(link).toMatchObject({ pages: 3, check: 'Links', page: '/a' });
    expect(data.issues.find((i) => i.message.startsWith('No sitemap'))).toMatchObject({
      page: '',
      pages: 1,
    });
    expect(data.issues.find((i) => i.message.startsWith('Submitting'))?.check).toBe('Forms');
  });

  it('gives the score history, oldest first, ending with this check', async () => {
    const check = await makeCheck();
    const built = await buildEmailData(db, ctx, check.scanId, check.recipients[0]!);
    if (built?.data.kind !== 'report') throw new Error('expected a report');
    expect(built.data.history.map((point) => point.score)).toEqual([70, 78, 61]);
    const dates = built.data.history.map((point) => point.at);
    expect([...dates].sort()).toEqual(dates);
  });

  it('keeps at most the last twelve checks', async () => {
    const check = await makeCheck({ withPrevious: false });
    for (let run = 10; run < 30; run += 1) {
      await insertScan({
        hostname: check.hostname,
        runNumber: run,
        websiteId: check.websiteId,
        score: 50 + (run % 40),
        createdAt: new Date(Date.UTC(2026, 6, run - 8)),
        finishedAt: new Date(Date.UTC(2026, 6, run - 8, 1)),
      });
    }
    const built = await buildEmailData(db, ctx, check.scanId, check.recipients[0]!);
    if (built?.data.kind !== 'report') throw new Error('expected a report');
    expect(built.data.history).toHaveLength(12);
  });

  it('treats a first check as having nothing new, because there is nothing to compare with', async () => {
    const check = await makeCheck({ withPrevious: false });
    const built = await buildEmailData(db, ctx, check.scanId, check.recipients[0]!);
    if (built?.data.kind !== 'report') throw new Error('expected a report');
    expect(built.data.isFirstCheck).toBe(true);
    expect(built.data.previousScore).toBeNull();
    expect(built.data.counts.newCritical + built.data.counts.newWarnings).toBe(0);
    expect(built.data.counts.totalOpen).toBe(5);
    expect(built.data.issues.every((issue) => !issue.isNew)).toBe(true);
  });

  it('describes a failed check with its reason and the last score that completed', async () => {
    const check = await makeCheck({
      status: 'failed',
      errorMessage: 'Could not reach https://x.example.com/. Timed out.',
    });
    const built = await buildEmailData(db, ctx, check.scanId, check.recipients[0]!);
    expect(built?.data).toMatchObject({
      kind: 'failed',
      reason: 'Could not reach https://x.example.com/. Timed out.',
      lastScore: 78,
      check: { runNumber: 3 },
    });
  });

  it('returns nothing for a scan that is unfinished, cancelled, or not a check of a website', async () => {
    const cancelled = await makeCheck({ status: 'cancelled' });
    expect(await buildEmailData(db, ctx, cancelled.scanId, cancelled.recipients[0]!)).toBeNull();
    const oneOff = await insertScan({ hostname: `oneoff${++counter}.example.com`, runNumber: 1 });
    expect(
      await buildEmailData(db, ctx, oneOff, { id: 'rcp_x', email: 'x@example.com', name: null }),
    ).toBeNull();
    expect(
      await buildEmailData(db, ctx, 'scn_none', {
        id: 'rcp_x',
        email: 'x@example.com',
        name: null,
      }),
    ).toBeNull();
  });

  it('builds links that point into the app, with a token only this recipient can use', async () => {
    const check = await makeCheck();
    const recipient = check.recipients[0]!;
    const built = await buildEmailData(db, ctx, check.scanId, recipient);
    const links = built?.data.links;
    expect(links?.report).toBe(`https://beacon.test/scans/${check.scanId}`);
    expect(links?.website).toBe(`https://beacon.test/websites/${check.websiteId}`);

    const token = links?.preferences.split('/email/preferences/')[1] as string;
    expect(await verifyRecipientToken(SECRET, token)).toBe(recipient.id);
    expect(links?.unsubscribe).toBe(`${links?.preferences}?choice=unsubscribe`);
    // The one-click address a mail client posts to has no page and no query.
    expect(built?.listUnsubscribeUrl).toBe(`${links?.preferences}/unsubscribe`);
    expect(await verifyRecipientToken('another-secret-0123456789abcdef', token)).toBeNull();
  });
});

// ---- Sending an email ----------------------------------------------------------------------------

describe('attemptEmail', () => {
  async function planned(options: Parameters<typeof makeCheck>[0] = {}) {
    const check = await makeCheck(options);
    const plan = await planNotifications(makeDeps(), check.scanId);
    return { check, deliveryId: plan.emailIds[0] as string };
  }
  const row = (id: string) => db.emailDelivery.findUniqueOrThrow({ where: { id } });

  it('renders and sends the report, with unsubscribe headers, and records the result', async () => {
    sender = new FakeSender();
    const { deliveryId } = await planned();
    expect(await attemptEmail(makeDeps(), deliveryId, { last: false })).toBe('sent');

    expect(sender.sent).toHaveLength(1);
    const message = sender.sent[0] as EmailMessage;
    expect(message.to).toBe('a@example.com');
    expect(message.from).toBe('Beacon <reports@beacon.test>');
    expect(message.subject).toMatch(
      /^⚠️ site\d+\.example\.com — health score 61 \(1 new critical issue, 2 new warnings\)$/,
    );
    expect(message.html).toContain('View full report');
    expect(message.html).toContain('Hi Alex,');
    expect(message.text).toContain('Health score: 61 / 100');
    expect(message.headers?.['List-Unsubscribe']).toMatch(
      /^<https:\/\/beacon\.test\/api\/v1\/email\/preferences\/rcp_[^/]+\.[0-9a-f]{32}\/unsubscribe>$/,
    );
    expect(message.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    expect(await row(deliveryId)).toMatchObject({
      status: 'sent',
      attempts: 1,
      provider: 'fake',
      providerMessageId: 'msg_1',
      error: null,
      subject: message.subject,
    });
    expect((await row(deliveryId)).sentAt).not.toBeNull();
  });

  it('does not send twice if the job runs again', async () => {
    sender = new FakeSender();
    const { deliveryId } = await planned();
    await attemptEmail(makeDeps(), deliveryId, { last: false });
    expect(await attemptEmail(makeDeps(), deliveryId, { last: false })).toBe('sent');
    expect(sender.sent).toHaveLength(1);
    expect((await row(deliveryId)).attempts).toBe(1);
  });

  it('retries a temporary failure, keeps it pending with the reason, and gives up on the last attempt', async () => {
    sender = new FakeSender();
    const { deliveryId } = await planned();
    sender.failWith = [new TransientEmailError('Resend refused the email (503): Try later')];

    expect(await attemptEmail(makeDeps(), deliveryId, { last: false })).toBe('retry');
    expect(await row(deliveryId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      error: 'Resend refused the email (503): Try later',
    });

    sender.failWith = [new TransientEmailError('Still down')];
    expect(await attemptEmail(makeDeps(), deliveryId, { last: true })).toBe('failed');
    expect(await row(deliveryId)).toMatchObject({
      status: 'failed',
      attempts: 2,
      error: 'Still down',
    });
  });

  it('succeeds on a later attempt and clears the error', async () => {
    sender = new FakeSender();
    const { deliveryId } = await planned();
    sender.failWith = [new TransientEmailError('Timeout')];
    await attemptEmail(makeDeps(), deliveryId, { last: false });
    expect(await attemptEmail(makeDeps(), deliveryId, { last: false })).toBe('sent');
    expect(await row(deliveryId)).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('fails at once, without retrying, when the provider says it will never work', async () => {
    sender = new FakeSender();
    const { deliveryId } = await planned();
    sender.failWith = [new PermanentEmailError('The from domain is not verified')];
    expect(await attemptEmail(makeDeps(), deliveryId, { last: false })).toBe('failed');
    expect(await row(deliveryId)).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'The from domain is not verified',
    });
  });

  it('treats an unexpected error like a temporary one', async () => {
    sender = new FakeSender();
    const { deliveryId } = await planned();
    sender.failWith = [new Error('socket hang up')];
    expect(await attemptEmail(makeDeps(), deliveryId, { last: false })).toBe('retry');
  });

  it('sends a failure notice for a failed check', async () => {
    sender = new FakeSender();
    const { deliveryId } = await planned({
      status: 'failed',
      errorMessage: 'Could not reach https://x.example.com/. Timed out.',
    });
    expect(await attemptEmail(makeDeps(), deliveryId, { last: false })).toBe('sent');
    const message = sender.sent[0] as EmailMessage;
    expect(message.subject).toMatch(/^🚨 site\d+\.example\.com — the check could not run$/);
    expect(message.html).toContain('Could not reach https://x.example.com/. Timed out.');
  });

  it('skips a recipient who only wants reports with new issues when there are none', async () => {
    sender = new FakeSender();
    const quiet = await makeCheck({
      recipients: [{ email: 'q@example.com', notify: 'new_issues_only' }],
    });
    // Make it an all clear: nothing new, and the score went up.
    await db.scanIssue.deleteMany({
      where: {
        scanId: quiet.scanId,
        fingerprint: { in: ['fp-new-crit', 'fp-new-warn', 'fp-sitewide'] },
      },
    });
    await db.scan.update({ where: { id: quiet.scanId }, data: { healthScore: 95 } });
    const plan = await planNotifications(makeDeps(), quiet.scanId);
    expect(await attemptEmail(makeDeps(), plan.emailIds[0] as string, { last: false })).toBe(
      'skipped',
    );
    expect(sender.sent).toHaveLength(0);
    const skipped = await row(plan.emailIds[0] as string);
    expect(skipped.status).toBe('skipped');
    expect(skipped.error).toContain('only wants reports with new issues');
  });

  it('still sends to that recipient when there are new issues, and always sends a failure', async () => {
    sender = new FakeSender();
    const noisy = await makeCheck({
      recipients: [{ email: 'q@example.com', notify: 'new_issues_only' }],
    });
    const plan = await planNotifications(makeDeps(), noisy.scanId);
    expect(await attemptEmail(makeDeps(), plan.emailIds[0] as string, { last: false })).toBe(
      'sent',
    );

    const down = await makeCheck({
      status: 'failed',
      errorMessage: 'Down.',
      recipients: [{ email: 'q@example.com', notify: 'new_issues_only' }],
    });
    const failurePlan = await planNotifications(makeDeps(), down.scanId);
    expect(await attemptEmail(makeDeps(), failurePlan.emailIds[0] as string, { last: false })).toBe(
      'sent',
    );
  });

  it('skips when the recipient unsubscribed, or email was turned off, after it was queued', async () => {
    sender = new FakeSender();
    const a = await planned();
    await db.websiteRecipient.updateMany({
      where: { id: a.check.recipients[0]!.id },
      data: { isActive: false },
    });
    expect(await attemptEmail(makeDeps(), a.deliveryId, { last: false })).toBe('skipped');
    expect((await row(a.deliveryId)).error).toBe('The recipient unsubscribed.');

    const b = await planned();
    await db.website.update({ where: { id: b.check.websiteId }, data: { emailEnabled: false } });
    expect(await attemptEmail(makeDeps(), b.deliveryId, { last: false })).toBe('skipped');
    expect(sender.sent).toHaveLength(0);
  });

  it('reports a delivery that no longer exists as failed', async () => {
    expect(await attemptEmail(makeDeps(), 'eml_doesnotexist', { last: false })).toBe('failed');
  });
});

// ---- Callbacks -----------------------------------------------------------------------------------

describe('attemptCallback', () => {
  let server: Server;
  let base: string;
  const received: { headers: IncomingHttpHeaders; body: string; url: string }[] = [];
  let answers: { status: number; headers?: Record<string, string> }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          url: req.url ?? '',
        });
        const answer = answers.shift() ?? { status: 200 };
        res.writeHead(answer.status, answer.headers ?? {});
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  async function planned(path = '/hook', options: Parameters<typeof makeCheck>[0] = {}) {
    const check = await makeCheck({ callbackUrl: `${base}${path}`, ...options });
    const plan = await planNotifications(makeDeps(), check.scanId);
    return { check, deliveryId: plan.callbackId as string };
  }
  const row = (id: string) => db.webhookDelivery.findUniqueOrThrow({ where: { id } });

  it('posts a signed payload that the receiver can verify over the exact bytes', async () => {
    received.length = 0;
    answers = [{ status: 200 }];
    const { check, deliveryId } = await planned();
    expect(await attemptCallback(makeDeps(), deliveryId, { last: false })).toBe('sent');

    const request = received[0]!;
    expect(request.url).toBe('/hook');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-beacon-event']).toBe('scan.completed');
    expect(request.headers['x-beacon-delivery']).toBe(deliveryId);
    expect(request.headers['x-beacon-attempt']).toBe('1');
    expect(String(request.headers['user-agent'])).toContain('BeaconBot');
    expect(
      await verifyCallbackSignature(
        SECRET,
        request.body,
        request.headers['x-beacon-signature'] as string,
      ),
    ).toBe(true);
    // A single changed byte, or the wrong secret, fails.
    expect(
      await verifyCallbackSignature(
        SECRET,
        `${request.body} `,
        request.headers['x-beacon-signature'] as string,
      ),
    ).toBe(false);
    expect(
      await verifyCallbackSignature(
        'wrong-secret-0123456789abcdef',
        request.body,
        request.headers['x-beacon-signature'] as string,
      ),
    ).toBe(false);

    const payload = CallbackPayloadSchema.parse(JSON.parse(request.body));
    expect(payload).toMatchObject({
      event: 'scan.completed',
      deliveryId,
      scan: {
        id: check.scanId,
        status: 'completed',
        runNumber: 3,
        triggeredByType: 'scheduled',
        pageSelectionMode: 'random_sample',
        website: { id: check.websiteId },
        metadata: { mondayItemId: '42' },
        summary: { healthScore: 61, scoreChange: -17, pages: 5, critical: 3, warnings: 4 },
        errorMessage: null,
        reportUrl: `https://beacon.test/scans/${check.scanId}`,
        statusUrl: `https://beacon.test/api/v1/scans/${check.scanId}`,
      },
    });

    expect(await row(deliveryId)).toMatchObject({
      status: 'sent',
      attempt: 1,
      responseStatus: 200,
      error: null,
    });
    expect((await row(deliveryId)).deliveredAt).not.toBeNull();
  });

  it('is not sent twice if the job runs again', async () => {
    received.length = 0;
    answers = [{ status: 204 }];
    const { deliveryId } = await planned();
    await attemptCallback(makeDeps(), deliveryId, { last: false });
    expect(await attemptCallback(makeDeps(), deliveryId, { last: false })).toBe('sent');
    expect(received).toHaveLength(1);
  });

  it.each([500, 502, 503, 429, 408])(
    'retries when the receiver answers HTTP %s',
    async (status) => {
      answers = [{ status }];
      const { deliveryId } = await planned();
      expect(await attemptCallback(makeDeps(), deliveryId, { last: false })).toBe('retry');
      expect(await row(deliveryId)).toMatchObject({
        status: 'pending',
        attempt: 1,
        responseStatus: status,
      });
      expect((await row(deliveryId)).error).toContain(`HTTP ${status}`);
    },
  );

  it('gives up on the last attempt', async () => {
    answers = [{ status: 503 }];
    const { deliveryId } = await planned();
    expect(await attemptCallback(makeDeps(), deliveryId, { last: true })).toBe('failed');
    expect(await row(deliveryId)).toMatchObject({ status: 'failed', responseStatus: 503 });
  });

  it.each([400, 401, 404, 410])(
    'does not retry when the receiver answers HTTP %s',
    async (status) => {
      answers = [{ status }];
      const { deliveryId } = await planned();
      expect(await attemptCallback(makeDeps(), deliveryId, { last: false })).toBe('failed');
      expect(await row(deliveryId)).toMatchObject({ status: 'failed', responseStatus: status });
    },
  );

  it('does not follow a redirect, so the body only goes where the owner pointed it', async () => {
    received.length = 0;
    answers = [{ status: 307, headers: { location: `${base}/elsewhere` } }];
    const { deliveryId } = await planned();
    expect(await attemptCallback(makeDeps(), deliveryId, { last: false })).toBe('failed');
    expect(received).toHaveLength(1);
    expect(received.some((r) => r.url === '/elsewhere')).toBe(false);
    expect((await row(deliveryId)).error).toContain('redirect');
  });

  it('retries when the receiver cannot be reached', async () => {
    const check = await makeCheck({ callbackUrl: 'http://127.0.0.1:1/hook' });
    const plan = await planNotifications(makeDeps(), check.scanId);
    expect(await attemptCallback(makeDeps(), plan.callbackId as string, { last: false })).toBe(
      'retry',
    );
    expect((await row(plan.callbackId as string)).error).toContain('could not be delivered');
  });

  it('refuses a private address unless local targets are allowed, without retrying', async () => {
    const strict = makeDeps({
      client: createSafeClient({ allowLocal: false, userAgent: 'BeaconBot/1.0' }),
    });
    const { deliveryId } = await planned();
    expect(await attemptCallback(strict, deliveryId, { last: false })).toBe('failed');
    expect((await row(deliveryId)).error).toContain('cannot be used');
  });

  it('reports the event of a failed or cancelled scan', async () => {
    received.length = 0;
    answers = [{ status: 200 }, { status: 200 }];
    const failed = await planned('/failed', {
      status: 'failed',
      errorMessage: 'Could not reach the site.',
    });
    await attemptCallback(makeDeps(), failed.deliveryId, { last: false });
    const failedPayload = CallbackPayloadSchema.parse(JSON.parse(received.at(-1)!.body));
    expect(failedPayload).toMatchObject({
      event: 'scan.failed',
      scan: {
        status: 'failed',
        errorMessage: 'Could not reach the site.',
        summary: { healthScore: null, scoreChange: null },
      },
    });

    const cancelled = await planned('/cancelled', { status: 'cancelled' });
    await attemptCallback(makeDeps(), cancelled.deliveryId, { last: false });
    expect(JSON.parse(received.at(-1)!.body)).toMatchObject({
      event: 'scan.cancelled',
      scan: { status: 'cancelled' },
    });
  });

  it('reports a delivery whose scan is gone as failed', async () => {
    const check = await makeCheck({ callbackUrl: `${base}/gone` });
    const plan = await planNotifications(makeDeps(), check.scanId);
    await db.webhookDelivery.update({
      where: { id: plan.callbackId as string },
      data: { scanId: check.scanId },
    });
    expect(await attemptCallback(makeDeps(), 'whd_doesnotexist', { last: false })).toBe('failed');
  });
});

describe('retry timing', () => {
  it('waits longer after each attempt, and stays at the longest wait', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(retryDelayMs)).toEqual([
      30_000, 120_000, 600_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000,
    ]);
    expect(DELIVERY_ATTEMPTS).toBe(6);
  });
});
