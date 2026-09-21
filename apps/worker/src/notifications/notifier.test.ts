import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@beacon/db';
import { createSafeClient } from '@beacon/net';
import { newId } from '@beacon/shared';
import { createIsolatedDatabase, uniquePrefix, type TestDatabase } from '@beacon/testkit';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { waitFor } from '../test/harness.js';
import { DELIVERY_ATTEMPTS } from './deliveries.js';
import { TransientEmailError, type EmailMessage, type EmailSender } from './email-sender.js';
import { startNotifier, type Notifier } from './notifier.js';

let database: TestDatabase;
let db: Db;
let connection: Redis;
let notifier: Notifier;
let server: Server;
let base: string;
let ownerId: string;
let counter = 0;

const hits: { path: string }[] = [];
/** How the receiver answers each call to a path. The last answer repeats. */
const scripts = new Map<string, number[]>();

class FlakySender implements EmailSender {
  readonly name = 'flaky';
  readonly sent: EmailMessage[] = [];
  /** Sends fail with a temporary error this many times, then work. */
  failures = 0;
  send(message: EmailMessage) {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new TransientEmailError('The provider is busy'));
    }
    this.sent.push(message);
    return Promise.resolve({ messageId: `msg_${this.sent.length}` });
  }
}
const sender = new FlakySender();

beforeAll(async () => {
  database = await createIsolatedDatabase();
  db = createDb({ url: database.url, log: false });
  connection = new Redis(process.env.BEACON_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = req.url ?? '/';
      hits.push({ path });
      const script = scripts.get(path) ?? [200];
      const status = script.length > 1 ? (script.shift() as number) : (script[0] as number);
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  ownerId = newId('usr');
  await db.user.create({
    data: { id: ownerId, email: 'owner@example.com', passwordHash: 'x', name: 'Owner' },
  });

  notifier = startNotifier(
    {
      db,
      config: {
        PUBLIC_URL: 'https://beacon.test',
        WEBHOOK_SIGNING_SECRET: 'test-signing-secret-0123456789abcdef',
        EMAIL_FROM: 'reports@beacon.test',
        EMAIL_FROM_NAME: 'Beacon',
      },
      log: pino({ level: 'silent' }),
      sender,
      client: createSafeClient({ allowLocal: true, userAgent: 'BeaconBot/1.0' }),
    },
    {
      connection,
      prefix: uniquePrefix('notify'),
      log: pino({ level: 'silent' }),
      delayMs: () => 30,
    },
  );
}, 120_000);

afterAll(async () => {
  await notifier.close();
  connection.disconnect();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await db.$disconnect();
  await database.drop();
});

async function finishedCheck(path: string): Promise<{ scanId: string; websiteId: string }> {
  counter += 1;
  const hostname = `notify${counter}.example.com`;
  const website = await db.website.create({
    data: {
      id: newId('web'),
      name: `Notify ${counter}`,
      url: `https://${hostname}/`,
      hostname,
      ownerId,
      enabledChecks: ['images'],
      recipients: {
        create: [
          { id: newId('rcp'), email: 'a@example.com', name: 'A' },
          { id: newId('rcp'), email: 'b@example.com' },
        ],
      },
    },
  });
  const scanId = newId('scn');
  await db.scan.create({
    data: {
      id: scanId,
      url: website.url,
      hostname,
      runNumber: 1,
      status: 'completed',
      checks: ['images'],
      websiteId: website.id,
      healthScore: 88,
      pagesTotal: 4,
      callbackUrl: `${base}${path}`,
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
    },
  });
  return { scanId, websiteId: website.id };
}

const callbackOf = (scanId: string) => db.webhookDelivery.findFirstOrThrow({ where: { scanId } });

describe('the notification queues', () => {
  it('retries a callback that fails until it works, and an email that fails once', async () => {
    scripts.set('/flaky', [500, 503, 200]);
    sender.failures = 1;
    const { scanId } = await finishedCheck('/flaky');

    await notifier.notify(scanId);
    // A second announcement of the same scan, from another route, changes nothing.
    await notifier.notify(scanId);

    await waitFor(() => db.webhookDelivery.findFirst({ where: { scanId, status: 'sent' } }), {
      label: 'the callback to be delivered',
      timeoutMs: 20_000,
    });
    const callback = await callbackOf(scanId);
    expect(callback).toMatchObject({
      status: 'sent',
      attempt: 3,
      responseStatus: 200,
      error: null,
    });
    expect(hits.filter((hit) => hit.path === '/flaky')).toHaveLength(3);

    await waitFor(
      async () => (await db.emailDelivery.count({ where: { scanId, status: 'sent' } })) === 2,
      { label: 'both emails to be sent', timeoutMs: 20_000 },
    );
    const emails = await db.emailDelivery.findMany({
      where: { scanId },
      orderBy: { email: 'asc' },
    });
    expect(emails.map((email) => email.email)).toEqual(['a@example.com', 'b@example.com']);
    // One send failed once, so exactly one email took a second attempt.
    expect(emails.map((email) => email.attempts).sort()).toEqual([1, 2]);
    expect(emails.every((email) => email.provider === 'flaky' && email.providerMessageId)).toBe(
      true,
    );
    expect(sender.sent).toHaveLength(2);
    expect(await db.webhookDelivery.count({ where: { scanId } })).toBe(1);
  }, 60_000);

  it('does not retry a callback the receiver will never accept', async () => {
    scripts.set('/missing', [404]);
    const { scanId } = await finishedCheck('/missing');
    await notifier.notify(scanId);
    await waitFor(() => db.webhookDelivery.findFirst({ where: { scanId, status: 'failed' } }), {
      label: 'the callback to fail',
      timeoutMs: 20_000,
    });
    // Give a wrongly scheduled retry time to show up.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await callbackOf(scanId)).toMatchObject({
      status: 'failed',
      attempt: 1,
      responseStatus: 404,
    });
    expect(hits.filter((hit) => hit.path === '/missing')).toHaveLength(1);
  }, 60_000);

  it('gives up after the last attempt, with the reason kept on the delivery', async () => {
    scripts.set('/down', [503]);
    const { scanId } = await finishedCheck('/down');
    await notifier.notify(scanId);
    await waitFor(() => db.webhookDelivery.findFirst({ where: { scanId, status: 'failed' } }), {
      label: 'the callback to give up',
      timeoutMs: 30_000,
    });
    const callback = await callbackOf(scanId);
    expect(callback.attempt).toBe(DELIVERY_ATTEMPTS);
    expect(callback.error).toContain('HTTP 503');
    expect(hits.filter((hit) => hit.path === '/down')).toHaveLength(DELIVERY_ATTEMPTS);
  }, 60_000);
});
