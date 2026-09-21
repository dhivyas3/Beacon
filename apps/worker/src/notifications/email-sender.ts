import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import type { WorkerConfig } from '../config.js';
import type { Logger } from '../logger.js';

export interface EmailMessage {
  to: string;
  /** Display name and address, such as `Beacon <reports@example.com>`. */
  from: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  /** The provider's id for the message, when it gives one. */
  messageId: string | null;
}

/** What every provider has to do. Adding Postmark or SES is one more class with this method. */
export interface EmailSender {
  /** Recorded on each delivery, such as `resend`. */
  readonly name: string;
  send(message: EmailMessage): Promise<SendResult>;
}

/** Trying again later may work: a timeout, a rate limit, the provider being down. */
export class TransientEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientEmailError';
  }
}

/** Trying again will not help: a bad address, a rejected key, an unverified sender. */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEmailError';
  }
}

// ---- Resend -----------------------------------------------------------------------------------

export interface ResendOptions {
  apiKey: string;
  /** Overridable so tests can point it at a local server. */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Sends through Resend's HTTP API. The address is fixed by configuration, never taken from a
 * scanned site, so this uses plain `fetch` rather than the SSRF-safe client.
 */
export class ResendSender implements EmailSender {
  readonly name = 'resend';

  constructor(private readonly options: ResendOptions) {}

  async send(message: EmailMessage): Promise<SendResult> {
    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.options.baseUrl ?? 'https://api.resend.com'}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.headers ? { headers: message.headers } : {}),
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new TransientEmailError(
        `Could not reach Resend: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      id?: unknown;
      message?: unknown;
      name?: unknown;
    } | null;
    if (response.ok) {
      return { messageId: typeof payload?.id === 'string' ? payload.id : null };
    }
    const detail =
      typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    const text = `Resend refused the email (${response.status}): ${detail}`;
    // A busy provider or a provider fault is worth another go. Anything else the caller must fix.
    if (response.status === 429 || response.status === 408 || response.status >= 500) {
      throw new TransientEmailError(text);
    }
    throw new PermanentEmailError(text);
  }
}

// ---- SMTP -------------------------------------------------------------------------------------

/** Sends through any SMTP server, including a provider's SMTP relay. */
export class SmtpSender implements EmailSender {
  readonly name = 'smtp';
  private readonly transport: Pick<Transporter, 'sendMail'>;

  constructor(urlOrTransport: string | Pick<Transporter, 'sendMail'>) {
    this.transport =
      typeof urlOrTransport === 'string'
        ? nodemailer.createTransport(urlOrTransport)
        : urlOrTransport;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const info = (await this.transport.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.headers ? { headers: message.headers } : {}),
      })) as { messageId?: unknown };
      return { messageId: typeof info.messageId === 'string' ? info.messageId : null };
    } catch (error) {
      const failure = error as { message?: string; responseCode?: number };
      const text = `The SMTP server refused the email: ${failure.message ?? String(error)}`;
      const code = failure.responseCode;
      // 5xx replies are final ("no such mailbox"). 4xx replies and network errors are worth retrying.
      if (typeof code === 'number' && code >= 500) throw new PermanentEmailError(text);
      throw new TransientEmailError(text);
    }
  }
}

// ---- Development outbox and unconfigured ----------------------------------------------------------

/**
 * Writes each email to a folder instead of sending it, as HTML, plain text and JSON. Open the HTML
 * in a browser. This is what development uses when no provider is configured.
 */
export class LogSender implements EmailSender {
  readonly name = 'log';
  private counter = 0;

  constructor(
    private readonly directory: string,
    private readonly log?: Logger,
  ) {}

  async send(message: EmailMessage): Promise<SendResult> {
    await mkdir(this.directory, { recursive: true });
    this.counter += 1;
    const safeTo = message.to.replace(/[^a-zA-Z0-9@.-]+/g, '_');
    const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(this.counter).padStart(3, '0')}-${safeTo}`;
    await writeFile(join(this.directory, `${base}.html`), message.html, 'utf8');
    await writeFile(join(this.directory, `${base}.txt`), message.text, 'utf8');
    await writeFile(
      join(this.directory, `${base}.json`),
      JSON.stringify(
        { to: message.to, from: message.from, subject: message.subject, headers: message.headers },
        null,
        2,
      ),
      'utf8',
    );
    this.log?.info(
      { to: message.to, subject: message.subject, file: `${base}.html` },
      'email written to the outbox',
    );
    return { messageId: `log_${base}` };
  }
}

/** Used when email is misconfigured, so every attempt fails with the reason instead of vanishing. */
export class UnconfiguredSender implements EmailSender {
  readonly name = 'none';

  constructor(private readonly reason: string) {}

  send(): Promise<SendResult> {
    return Promise.reject(new PermanentEmailError(this.reason));
  }
}

export type EmailConfig = Pick<
  WorkerConfig,
  'EMAIL_PROVIDER' | 'RESEND_API_KEY' | 'SMTP_URL' | 'EMAIL_OUTBOX_DIR'
>;

/** Which provider is in use: what is set, else Resend when there is a key, else the outbox. */
export function resolveProvider(config: EmailConfig): 'resend' | 'smtp' | 'log' {
  if (config.EMAIL_PROVIDER !== undefined) return config.EMAIL_PROVIDER;
  return config.RESEND_API_KEY !== undefined ? 'resend' : 'log';
}

/** Builds the sender the configuration asks for. A misconfiguration gives a sender that says so. */
export function createEmailSender(config: EmailConfig, log?: Logger): EmailSender {
  const provider = resolveProvider(config);
  switch (provider) {
    case 'resend':
      return config.RESEND_API_KEY === undefined
        ? new UnconfiguredSender(
            'EMAIL_PROVIDER is resend but RESEND_API_KEY is not set, so no email can be sent. Set it and restart the worker.',
          )
        : new ResendSender({ apiKey: config.RESEND_API_KEY });
    case 'smtp':
      return config.SMTP_URL === undefined
        ? new UnconfiguredSender(
            'EMAIL_PROVIDER is smtp but SMTP_URL is not set, so no email can be sent. Set it and restart the worker.',
          )
        : new SmtpSender(config.SMTP_URL);
    case 'log':
      return new LogSender(config.EMAIL_OUTBOX_DIR, log);
  }
}
