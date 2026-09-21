import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEmailSender,
  LogSender,
  PermanentEmailError,
  resolveProvider,
  ResendSender,
  SmtpSender,
  TransientEmailError,
  UnconfiguredSender,
  type EmailMessage,
} from './email-sender.js';

const message: EmailMessage = {
  to: 'sam@example.com',
  from: 'Beacon <reports@example.com>',
  subject: '✅ example.com — health score 94 (no new issues)',
  html: '<p>Hello</p>',
  text: 'Hello',
  headers: { 'List-Unsubscribe': '<https://beacon.test/u>' },
};

describe('ResendSender', () => {
  let server: Server;
  let baseUrl: string;
  const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  let respond: { status: number; body: unknown } = { status: 200, body: { id: 'msg_1' } };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        res.writeHead(respond.status, { 'content-type': 'application/json' });
        res.end(typeof respond.body === 'string' ? respond.body : JSON.stringify(respond.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const sender = () => new ResendSender({ apiKey: 're_test_key', baseUrl, timeoutMs: 2000 });

  it('posts the message with the key, and returns the provider id', async () => {
    respond = { status: 200, body: { id: 'msg_abc123' } };
    const result = await sender().send(message);
    expect(result).toEqual({ messageId: 'msg_abc123' });
    const sent = requests.at(-1);
    expect(sent?.headers.authorization).toBe('Bearer re_test_key');
    expect(sent?.body).toEqual({
      from: 'Beacon <reports@example.com>',
      to: ['sam@example.com'],
      subject: message.subject,
      html: '<p>Hello</p>',
      text: 'Hello',
      headers: { 'List-Unsubscribe': '<https://beacon.test/u>' },
    });
  });

  it('copes with an answer that has no id', async () => {
    respond = { status: 200, body: {} };
    expect(await sender().send(message)).toEqual({ messageId: null });
  });

  it.each([429, 408, 500, 502, 503])('treats HTTP %s as worth retrying', async (status) => {
    respond = { status, body: { message: 'Slow down' } };
    await expect(sender().send(message)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it.each([400, 401, 403, 422])('treats HTTP %s as final, with the reason', async (status) => {
    respond = { status, body: { message: 'The from domain is not verified' } };
    const failure = sender().send(message);
    await expect(failure).rejects.toBeInstanceOf(PermanentEmailError);
    await expect(failure).rejects.toThrow(`(${status}): The from domain is not verified`);
  });

  it('copes with an error answer that is not JSON', async () => {
    respond = { status: 502, body: '<html>Bad gateway</html>' };
    await expect(sender().send(message)).rejects.toThrow('HTTP 502');
  });

  it('treats an unreachable provider as worth retrying', async () => {
    const dead = new ResendSender({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
    await expect(dead.send(message)).rejects.toBeInstanceOf(TransientEmailError);
    await expect(dead.send(message)).rejects.toThrow('Could not reach Resend');
  });
});

describe('SmtpSender', () => {
  const fakeTransport = (behaviour: () => Promise<unknown>) => ({
    sendMail: behaviour,
  });

  it('sends the message and returns the message id', async () => {
    let seen: unknown;
    const sender = new SmtpSender({
      sendMail: (options: unknown) => {
        seen = options;
        return Promise.resolve({ messageId: '<abc@mail.example.com>' });
      },
    } as never);
    expect(await sender.send(message)).toEqual({ messageId: '<abc@mail.example.com>' });
    expect(seen).toMatchObject({ from: message.from, to: message.to, subject: message.subject });
    expect((seen as { headers: unknown }).headers).toEqual(message.headers);
  });

  it('treats a 5xx reply as final and a 4xx reply or a network error as worth retrying', async () => {
    const reject = (error: object) =>
      new SmtpSender(
        fakeTransport(() => Promise.reject(Object.assign(new Error('smtp'), error))) as never,
      );
    await expect(reject({ responseCode: 550 }).send(message)).rejects.toBeInstanceOf(
      PermanentEmailError,
    );
    await expect(reject({ responseCode: 421 }).send(message)).rejects.toBeInstanceOf(
      TransientEmailError,
    );
    await expect(reject({ code: 'ECONNECTION' }).send(message)).rejects.toBeInstanceOf(
      TransientEmailError,
    );
    await expect(reject({ code: 'ETIMEDOUT' }).send(message)).rejects.toBeInstanceOf(
      TransientEmailError,
    );
  });

  it('builds a real transport from an SMTP url', () => {
    expect(new SmtpSender('smtp://user:pass@mail.example.com:587').name).toBe('smtp');
  });
});

describe('LogSender', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beacon-outbox-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes each email as HTML, text and JSON, and names them apart', async () => {
    const sender = new LogSender(join(directory, 'outbox'));
    const first = await sender.send(message);
    const second = await sender.send({ ...message, to: 'other+tag@example.com' });
    expect(first.messageId).not.toBe(second.messageId);

    const files = await readdir(join(directory, 'outbox'));
    expect(files).toHaveLength(6);
    const html = files.find((file) => file.endsWith('.html') && file.includes('sam@example.com'));
    expect(await readFile(join(directory, 'outbox', html as string), 'utf8')).toBe('<p>Hello</p>');
    const json = files.find((file) => file.endsWith('.json') && file.includes('sam@example.com'));
    expect(
      JSON.parse(await readFile(join(directory, 'outbox', json as string), 'utf8')),
    ).toMatchObject({
      to: 'sam@example.com',
      subject: message.subject,
      headers: message.headers,
    });
  });

  it('keeps an address from escaping the folder', async () => {
    const sender = new LogSender(join(directory, 'safe'));
    await sender.send({ ...message, to: '../../etc/passwd' });
    const files = await readdir(join(directory, 'safe'));
    expect(files.every((file) => !file.includes('/') && !file.includes('\\'))).toBe(true);
    expect(files).toHaveLength(3);
  });
});

describe('choosing a provider', () => {
  const config = (overrides: Record<string, string | undefined>) =>
    ({
      EMAIL_PROVIDER: undefined,
      RESEND_API_KEY: undefined,
      SMTP_URL: undefined,
      EMAIL_OUTBOX_DIR: './data/outbox',
      ...overrides,
    }) as Parameters<typeof resolveProvider>[0];

  it('uses Resend when there is a key, and the outbox when there is nothing', () => {
    expect(resolveProvider(config({}))).toBe('log');
    expect(resolveProvider(config({ RESEND_API_KEY: 're_x' }))).toBe('resend');
  });

  it('lets EMAIL_PROVIDER decide', () => {
    expect(resolveProvider(config({ EMAIL_PROVIDER: 'smtp', RESEND_API_KEY: 're_x' }))).toBe(
      'smtp',
    );
    expect(resolveProvider(config({ EMAIL_PROVIDER: 'log', RESEND_API_KEY: 're_x' }))).toBe('log');
  });

  it('builds the matching sender', () => {
    expect(createEmailSender(config({})).name).toBe('log');
    expect(createEmailSender(config({ RESEND_API_KEY: 're_x' })).name).toBe('resend');
    expect(
      createEmailSender(config({ EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://u:p@h:25' })).name,
    ).toBe('smtp');
  });

  it('gives a sender that fails with the reason when the chosen provider lacks its setting', async () => {
    const resend = createEmailSender(config({ EMAIL_PROVIDER: 'resend' }));
    expect(resend).toBeInstanceOf(UnconfiguredSender);
    await expect(resend.send(message)).rejects.toThrow('RESEND_API_KEY is not set');
    await expect(resend.send(message)).rejects.toBeInstanceOf(PermanentEmailError);
    const smtp = createEmailSender(config({ EMAIL_PROVIDER: 'smtp' }));
    await expect(smtp.send(message)).rejects.toThrow('SMTP_URL is not set');
  });
});
