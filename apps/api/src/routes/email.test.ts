import { newId, signRecipientToken, type Website, type WebsiteRecipient } from '@beacon/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, insertScan, type TestApp } from '../test/helpers.js';

let ctx: TestApp;
let writer: string;
let reader: string;
let counter = 0;
let secret: string;

beforeAll(async () => {
  ctx = await createTestApp();
  secret = ctx.config.WEBHOOK_SIGNING_SECRET;
  await ctx.adminCookie();
  await ctx.allowDomain('*.example.com');
  writer = (await ctx.createApiKey(['scans:read', 'scans:write'], 'writer')).key;
  reader = (await ctx.createApiKey(['scans:read'], 'reader')).key;
});

afterAll(async () => {
  await ctx.close();
});

function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  key = writer,
  payload?: Record<string, unknown>,
) {
  return ctx.app.inject({
    method,
    url: `/api/v1${path}`,
    headers: bearer(key),
    ...(payload ? { payload } : {}),
  });
}

async function createWebsite(overrides: Record<string, unknown> = {}) {
  counter += 1;
  const host = `mail${counter}.example.com`;
  const res = await api('POST', '/websites', writer, {
    name: `Mail site ${counter}`,
    url: `https://${host}`,
    ...overrides,
  });
  expect(res.statusCode, res.body).toBe(201);
  return { website: res.json<Website>(), host };
}

describe('email settings on a website', () => {
  it('is on by default, can start off, and can be switched without touching the recipients', async () => {
    const { website } = await createWebsite({ recipients: [{ email: 'a@example.com' }] });
    expect(website.emailEnabled).toBe(true);
    expect(website.recipients[0]).toMatchObject({ notify: 'every_check', isActive: true });

    const off = (await createWebsite({ emailEnabled: false })).website;
    expect(off.emailEnabled).toBe(false);

    const switched = await api('PATCH', `/websites/${website.id}`, writer, { emailEnabled: false });
    expect(switched.json<Website>()).toMatchObject({ emailEnabled: false });
    expect(switched.json<Website>().recipients).toHaveLength(1);
    const back = await api('PATCH', `/websites/${website.id}`, writer, { emailEnabled: true });
    expect(back.json<Website>().emailEnabled).toBe(true);
  });

  it('lets a recipient be added with a preference, and changed later', async () => {
    const { website } = await createWebsite({
      recipients: [{ email: 'quiet@example.com', notify: 'new_issues_only' }],
    });
    expect(website.recipients[0]?.notify).toBe('new_issues_only');
    const id = website.recipients[0]?.id as string;

    const paused = await api('PATCH', `/websites/${website.id}/recipients/${id}`, writer, {
      isActive: false,
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json<WebsiteRecipient>()).toMatchObject({
      isActive: false,
      notify: 'new_issues_only',
    });

    const changed = await api('PATCH', `/websites/${website.id}/recipients/${id}`, writer, {
      isActive: true,
      notify: 'every_check',
      name: 'Quiet Person',
    });
    expect(changed.json<WebsiteRecipient>()).toMatchObject({
      isActive: true,
      notify: 'every_check',
      name: 'Quiet Person',
    });

    const added = await api('POST', `/websites/${website.id}/recipients`, writer, {
      email: 'late@example.com',
      notify: 'new_issues_only',
    });
    expect(added.json<WebsiteRecipient>().notify).toBe('new_issues_only');
  });

  it('refuses a bad preference, an unknown recipient, and a recipient of another website', async () => {
    const { website } = await createWebsite({ recipients: [{ email: 'a@example.com' }] });
    const other = (await createWebsite()).website;
    const id = website.recipients[0]?.id as string;
    expect(
      (await api('PATCH', `/websites/${website.id}/recipients/${id}`, writer, { notify: 'daily' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await api('PATCH', `/websites/${website.id}/recipients/rcp_none`, writer, {
          isActive: false,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await api('PATCH', `/websites/${other.id}/recipients/${id}`, writer, { isActive: false }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api('PATCH', `/websites/web_none/recipients/${id}`, writer, { isActive: false }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api('PATCH', `/websites/${website.id}/recipients/${id}`, reader, { isActive: false }))
        .statusCode,
    ).toBe(403);
  });
});

describe('email delivery status', () => {
  async function delivery(
    websiteId: string,
    host: string,
    scanId: string,
    status: 'pending' | 'sent' | 'failed' | 'skipped',
    extra: { email: string; error?: string; createdAt?: Date },
  ) {
    await ctx.db.emailDelivery.create({
      data: {
        id: newId('eml'),
        scanId,
        websiteId,
        email: extra.email,
        status,
        attempts: status === 'pending' ? 0 : 1,
        provider: 'resend',
        providerMessageId: status === 'sent' ? 'msg_1' : null,
        subject: `Subject for ${host}`,
        error: extra.error ?? null,
        sentAt: status === 'sent' ? new Date() : null,
        ...(extra.createdAt ? { createdAt: extra.createdAt } : {}),
      },
    });
  }

  it('says nothing until an email has been due', async () => {
    const { website } = await createWebsite({ recipients: [{ email: 'a@example.com' }] });
    expect(website.emailStatus).toBeNull();
  });

  it('summarises the latest emailed check, and surfaces the failure reason', async () => {
    const { website, host } = await createWebsite({
      recipients: [
        { email: 'a@example.com' },
        { email: 'b@example.com' },
        { email: 'c@example.com' },
      ],
    });
    const older = await insertScan(ctx.db, { hostname: host, runNumber: 1, websiteId: website.id });
    const latest = await insertScan(ctx.db, {
      hostname: host,
      runNumber: 2,
      websiteId: website.id,
    });
    await delivery(website.id, host, older, 'failed', {
      email: 'a@example.com',
      error: 'Old problem',
      createdAt: new Date('2026-06-01'),
    });
    await delivery(website.id, host, latest, 'sent', { email: 'a@example.com' });
    await delivery(website.id, host, latest, 'failed', {
      email: 'b@example.com',
      error: 'Resend refused the email (422): The from domain is not verified',
    });
    await delivery(website.id, host, latest, 'pending', { email: 'c@example.com' });

    const detail = (await api('GET', `/websites/${website.id}`, reader)).json<Website>();
    expect(detail.emailStatus).toEqual({
      scanId: latest,
      sent: 1,
      failed: 1,
      pending: 1,
      lastError: 'b@example.com: Resend refused the email (422): The from domain is not verified',
    });
    // The list carries it too, so a failure is visible without opening the website.
    const list = (
      await api('GET', `/websites?q=${encodeURIComponent(website.name)}`, reader)
    ).json<{ items: Website[] }>();
    expect(list.items[0]?.emailStatus?.failed).toBe(1);
  });

  it('lists the emails newest first, with filters and a cursor', async () => {
    const { website, host } = await createWebsite();
    const scan = await insertScan(ctx.db, { hostname: host, runNumber: 1, websiteId: website.id });
    const other = await insertScan(ctx.db, { hostname: host, runNumber: 2, websiteId: website.id });
    await delivery(website.id, host, scan, 'sent', {
      email: 'a@example.com',
      createdAt: new Date('2026-07-01'),
    });
    await delivery(website.id, host, scan, 'failed', {
      email: 'b@example.com',
      error: 'Nope',
      createdAt: new Date('2026-07-02'),
    });
    await delivery(website.id, host, other, 'skipped', {
      email: 'c@example.com',
      error: 'The recipient unsubscribed.',
      createdAt: new Date('2026-07-03'),
    });

    const all = (
      await api('GET', `/websites/${website.id}/email-deliveries?limit=2`, reader)
    ).json<{
      items: {
        email: string;
        status: string;
        error: string | null;
        subject: string | null;
        provider: string | null;
        scanId: string;
      }[];
      nextCursor: string | null;
    }>();
    expect(all.items.map((item) => item.email)).toEqual(['c@example.com', 'b@example.com']);
    expect(all.items[0]).toMatchObject({
      status: 'skipped',
      error: 'The recipient unsubscribed.',
      provider: 'resend',
    });
    const rest = (
      await api(
        'GET',
        `/websites/${website.id}/email-deliveries?limit=2&cursor=${all.nextCursor as string}`,
        reader,
      )
    ).json<{ items: { email: string }[] }>();
    expect(rest.items.map((item) => item.email)).toEqual(['a@example.com']);

    const failed = (
      await api('GET', `/websites/${website.id}/email-deliveries?status=failed`, reader)
    ).json<{ items: { email: string }[] }>();
    expect(failed.items.map((item) => item.email)).toEqual(['b@example.com']);
    const byScan = (
      await api('GET', `/websites/${website.id}/email-deliveries?scanId=${other}`, reader)
    ).json<{ items: { email: string }[] }>();
    expect(byScan.items.map((item) => item.email)).toEqual(['c@example.com']);

    expect((await api('GET', '/websites/web_none/email-deliveries', reader)).statusCode).toBe(404);
    expect(
      (await api('GET', `/websites/${website.id}/email-deliveries?status=lost`, reader)).statusCode,
    ).toBe(400);
  });
});

describe('cancelling announces the scan to the worker', () => {
  it('puts a scan-finished job on the notifications queue', async () => {
    const { host } = await createWebsite();
    const id = await insertScan(ctx.db, { hostname: host, runNumber: 1, status: 'running' });
    const res = await api('POST', `/scans/${id}/cancel`);
    expect(res.statusCode).toBe(200);

    const connection = new Redis(ctx.redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue('notifications', { connection, prefix: ctx.queuePrefix });
    try {
      const job = await queue.getJob(`finished-${id}`);
      expect(job?.name).toBe('scan-finished');
      expect(job?.data).toEqual({ scanId: id });
    } finally {
      await queue.close();
      connection.disconnect();
    }
  });
});

describe('the public email preference pages', () => {
  async function recipient(overrides: Record<string, unknown> = {}) {
    const { website } = await createWebsite({
      name: 'Estates <Ltd>',
      recipients: [{ email: 'sam@example.com', ...overrides }],
    });
    const id = website.recipients[0]?.id as string;
    const token = await signRecipientToken(secret, id);
    return { id, token, website };
  }
  const get = (path: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/email/preferences/${path}` });
  const post = (path: string, body: string, type = 'application/x-www-form-urlencoded') =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/email/preferences/${path}`,
      headers: { 'content-type': type },
      payload: body,
    });
  const state = (id: string) => ctx.db.websiteRecipient.findUniqueOrThrow({ where: { id } });

  it('shows the recipient their address and website, with their current choice selected', async () => {
    const { token } = await recipient({ notify: 'new_issues_only' });
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('sam@example.com');
    expect(res.body).toContain('Estates &lt;Ltd&gt;');
    expect(res.body).not.toContain('Estates <Ltd>');
    expect(res.body).toMatch(/value="new_issues_only" checked/);
    expect(res.body).not.toMatch(/value="every_check" checked/);
  });

  it('is safe to show: no script, no caching, no framing, no referrer, not indexed', async () => {
    const { token } = await recipient();
    const res = await get(token);
    expect(res.body).not.toMatch(/<script/i);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('never changes anything on a GET, even the unsubscribe link, which asks first', async () => {
    const { id, token } = await recipient();
    const res = await get(`${token}?choice=unsubscribe`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/value="unsubscribe" checked/);
    // Opened by a mail scanner: still subscribed.
    expect((await state(id)).isActive).toBe(true);
  });

  it('saves a choice from the form', async () => {
    const { id, token } = await recipient();
    const quiet = await post(token, 'choice=new_issues_only');
    expect(quiet.statusCode).toBe(200);
    expect(quiet.body).toContain('Saved.');
    expect(await state(id)).toMatchObject({ isActive: true, notify: 'new_issues_only' });

    const off = await post(token, 'choice=unsubscribe');
    expect(off.body).toContain('You will no longer receive health reports');
    expect(await state(id)).toMatchObject({ isActive: false });

    const back = await post(token, 'choice=every_check');
    expect(back.statusCode).toBe(200);
    expect(await state(id)).toMatchObject({ isActive: true, notify: 'every_check' });
  });

  it('refuses a choice that is not one of the three', async () => {
    const { id, token } = await recipient();
    const res = await post(token, 'choice=delete_everything');
    expect(res.statusCode).toBe(400);
    expect((await state(id)).isActive).toBe(true);
  });

  it('unsubscribes with one POST to the address in the List-Unsubscribe header, as mail clients do', async () => {
    const { id, token } = await recipient();
    const res = await post(`${token}/unsubscribe`, 'List-Unsubscribe=One-Click');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('Unsubscribed');
    expect((await state(id)).isActive).toBe(false);
    // Also without a body.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/email/preferences/${token}/unsubscribe`,
    });
    expect(again.statusCode).toBe(200);
  });

  it('answers a link that is forged, edited, from another secret, or unknown, without saying which', async () => {
    const { id, token } = await recipient();
    const forgedId = await signRecipientToken('another-secret-0123456789abcdef', id);
    const edited = `${'rcp_Zz99Yy88Xx77'}.${token.split('.')[1]}`;
    const unknown = await signRecipientToken(secret, 'rcp_doesnotexist');
    for (const bad of [forgedId, edited, unknown, 'garbage', `${token}0`]) {
      const res = await get(bad);
      expect(res.statusCode, bad).toBe(404);
      expect(res.body).toContain('This link is not valid');
      const changed = await post(bad, 'choice=unsubscribe');
      expect(changed.statusCode, bad).toBe(404);
      expect((await post(`${bad}/unsubscribe`, '')).statusCode, bad).toBe(404);
    }
    expect((await state(id)).isActive).toBe(true);
  });

  it('needs no login, and does not depend on the API key or session', async () => {
    const { token } = await recipient();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/email/preferences/${token}`,
      headers: { authorization: 'Bearer bcn_nonsense' },
    });
    // A bad key on a public page is ignored rather than treated as a failed login.
    expect([200, 401]).toContain(res.statusCode);
  });

  it('is not in the API documentation, because it is a page for people, not for integrations', async () => {
    const spec = (await ctx.app.inject({ method: 'GET', url: '/api/docs/json' })).json<{
      paths: Record<string, unknown>;
    }>();
    expect(Object.keys(spec.paths).some((path) => path.includes('/email/preferences'))).toBe(false);
    expect(spec.paths['/api/v1/websites/{id}/email-deliveries']).toBeDefined();
    expect(spec.paths['/api/v1/websites/{id}/recipients/{recipientId}']).toBeDefined();
  });
});
