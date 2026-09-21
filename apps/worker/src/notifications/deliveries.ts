import { findPreviousScan, type Db } from '@beacon/db';
import { emailVariant, renderEmail } from '@beacon/email-templates';
import { FetchError, type SafeClient } from '@beacon/net';
import {
  callbackSignature,
  newId,
  type CallbackPayload,
  type CheckType,
  type WebhookEvent,
} from '@beacon/shared';
import type { WorkerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { PermanentEmailError, type EmailSender } from './email-sender.js';
import { buildEmailData } from './report-data.js';

/** Attempts per delivery, the first included. */
export const DELIVERY_ATTEMPTS = 6;
/** Waits before the second, third, ... attempt. Long enough to ride out a provider or n8n outage. */
export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

/** Given the number of attempts made so far, how long to wait before the next. */
export function retryDelayMs(attemptsMade: number): number {
  return (
    RETRY_DELAYS_MS[Math.min(attemptsMade, RETRY_DELAYS_MS.length) - 1] ??
    RETRY_DELAYS_MS[0] ??
    30_000
  );
}

export type Outcome = 'sent' | 'skipped' | 'retry' | 'failed';

export type NotifyConfig = Pick<
  WorkerConfig,
  'PUBLIC_URL' | 'WEBHOOK_SIGNING_SECRET' | 'EMAIL_FROM' | 'EMAIL_FROM_NAME'
>;

export interface NotifyDeps {
  db: Db;
  config: NotifyConfig;
  log: Logger;
  sender: EmailSender;
  /** Sends the callbacks. Every request passes the SSRF guard. */
  client: SafeClient;
  enqueueEmail: (deliveryId: string) => Promise<void>;
  enqueueCallback: (deliveryId: string) => Promise<void>;
  /** A scan that failed only because the worker restarted is not worth an email. */
  quietFailureMessage?: string;
}

const FINAL = ['completed', 'failed', 'cancelled'] as const;

// ---- Planning -----------------------------------------------------------------------------------

export interface Plan {
  callbackId: string | null;
  emailIds: string[];
}

/**
 * Decides what a finished scan owes and creates a row for each thing, so nothing is lost if the
 * worker stops before sending. Safe to run twice for the same scan: rows are unique per scan (and
 * per recipient), and only rows created now are queued.
 *
 * - A callback URL gets one callback for the scan's final state.
 * - A check of a website gets an email per active recipient when it completed, or failed, and the
 *   website's email switch is on. A cancelled scan sends none.
 */
export async function planNotifications(deps: NotifyDeps, scanId: string): Promise<Plan> {
  const { db } = deps;
  const plan: Plan = { callbackId: null, emailIds: [] };

  const scan = await db.scan.findUnique({
    where: { id: scanId },
    include: { website: { include: { recipients: { where: { isActive: true } } } } },
  });
  if (!scan || !(FINAL as readonly string[]).includes(scan.status)) return plan;

  if (scan.callbackUrl) {
    const id = newId('whd');
    const created = await db.webhookDelivery.createMany({
      data: [{ id, scanId, event: `scan.${scan.status}`, url: scan.callbackUrl, attempt: 0 }],
      skipDuplicates: true,
    });
    if (created.count === 1) plan.callbackId = id;
  }

  const emailable = scan.status === 'completed' || scan.status === 'failed';
  const quiet =
    deps.quietFailureMessage !== undefined && scan.errorMessage === deps.quietFailureMessage;
  if (scan.website?.emailEnabled && emailable && !quiet) {
    for (const recipient of scan.website.recipients) {
      const id = newId('eml');
      const created = await db.emailDelivery.createMany({
        data: [
          {
            id,
            scanId,
            websiteId: scan.website.id,
            recipientId: recipient.id,
            email: recipient.email,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count === 1) plan.emailIds.push(id);
    }
  }

  if (plan.callbackId) await deps.enqueueCallback(plan.callbackId);
  for (const id of plan.emailIds) await deps.enqueueEmail(id);
  return plan;
}

// ---- Email --------------------------------------------------------------------------------------

/**
 * One attempt to send one email. `last` says no attempts remain, so a failure now is final.
 * Returns what happened. `retry` means the caller should try again later.
 */
export async function attemptEmail(
  deps: NotifyDeps,
  deliveryId: string,
  options: { last: boolean },
): Promise<Outcome> {
  const { db, config, log } = deps;
  const delivery = await db.emailDelivery.findUnique({
    where: { id: deliveryId },
    include: { recipient: true, website: true },
  });
  if (!delivery) return 'failed';
  if (delivery.status === 'sent') return 'sent';
  if (delivery.status === 'skipped') return 'skipped';
  if (delivery.status === 'failed' && delivery.attempts >= DELIVERY_ATTEMPTS) return 'failed';

  const skip = async (reason: string): Promise<Outcome> => {
    await db.emailDelivery.update({
      where: { id: deliveryId },
      data: { status: 'skipped', error: reason },
    });
    return 'skipped';
  };

  // The situation may have changed since this was queued.
  if (!delivery.recipient || !delivery.recipient.isActive)
    return skip('The recipient unsubscribed.');
  if (!delivery.website?.emailEnabled) return skip('Email is turned off for this website.');

  const built = await buildEmailData(
    db,
    { publicUrl: config.PUBLIC_URL, secret: config.WEBHOOK_SIGNING_SECRET },
    delivery.scanId,
    { id: delivery.recipient.id, email: delivery.recipient.email, name: delivery.recipient.name },
  );
  if (built === null) return skip('This check has no report to send.');

  if (
    delivery.recipient.notify === 'new_issues_only' &&
    built.data.kind === 'report' &&
    emailVariant(built.data) === 'all_clear'
  ) {
    return skip('The recipient only wants reports with new issues, and there were none.');
  }

  const email = await renderEmail(built.data);
  const fail = async (message: string, final: boolean): Promise<Outcome> => {
    await db.emailDelivery.update({
      where: { id: deliveryId },
      data: {
        status: final ? 'failed' : 'pending',
        attempts: { increment: 1 },
        error: message.slice(0, 500),
        subject: email.subject,
        provider: deps.sender.name,
      },
    });
    log.warn({ deliveryId, to: delivery.email, final, err: message }, 'email attempt failed');
    return final ? 'failed' : 'retry';
  };

  try {
    const result = await deps.sender.send({
      to: delivery.email,
      from: `${config.EMAIL_FROM_NAME} <${config.EMAIL_FROM}>`,
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: {
        'List-Unsubscribe': `<${built.listUnsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    await db.emailDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'sent',
        attempts: { increment: 1 },
        sentAt: new Date(),
        error: null,
        subject: email.subject,
        provider: deps.sender.name,
        providerMessageId: result.messageId,
      },
    });
    return 'sent';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PermanentEmailError) return fail(message, true);
    // Transient, and anything unexpected: worth another go until the attempts run out.
    return fail(message, options.last);
  }
}

// ---- Callbacks ----------------------------------------------------------------------------------

/** The body sent to a callback URL. */
export async function buildCallbackPayload(
  db: Db,
  config: Pick<NotifyConfig, 'PUBLIC_URL'>,
  deliveryId: string,
  scanId: string,
  event: WebhookEvent,
): Promise<CallbackPayload | null> {
  const scan = await db.scan.findUnique({ where: { id: scanId }, include: { website: true } });
  if (!scan) return null;
  const previous = await findPreviousScan(db, scan);
  const publicUrl = config.PUBLIC_URL.replace(/\/$/, '');
  const status =
    scan.status === 'completed' || scan.status === 'failed' ? scan.status : 'cancelled';

  return {
    event,
    deliveryId,
    sentAt: new Date().toISOString(),
    scan: {
      id: scan.id,
      url: scan.url,
      hostname: scan.hostname,
      runNumber: scan.runNumber,
      status,
      checks: scan.checks as CheckType[],
      triggeredByType: scan.triggeredByType,
      pageSelectionMode: scan.pageSelectionMode,
      website: scan.website ? { id: scan.website.id, name: scan.website.name } : null,
      metadata:
        scan.metadata !== null && typeof scan.metadata === 'object' && !Array.isArray(scan.metadata)
          ? scan.metadata
          : null,
      summary: {
        healthScore: scan.healthScore,
        scoreChange:
          scan.healthScore !== null && previous?.healthScore != null
            ? scan.healthScore - previous.healthScore
            : null,
        pages: scan.pagesTotal,
        critical: scan.criticalCount,
        warnings: scan.warningCount,
        passed: scan.passedCount,
      },
      errorMessage: scan.errorMessage,
      createdAt: scan.createdAt.toISOString(),
      startedAt: scan.startedAt?.toISOString() ?? null,
      finishedAt: scan.finishedAt?.toISOString() ?? null,
      statusUrl: `${publicUrl}/api/v1/scans/${scan.id}`,
      reportUrl: `${publicUrl}/scans/${scan.id}`,
    },
  };
}

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

/**
 * One attempt to deliver one callback: a POST of the JSON payload, signed with the webhook secret
 * over the exact bytes sent. Any 2xx is delivery. A server error, a timeout or a rate limit is
 * retried. Anything else (a 404, a refused address, a redirect) is final, since trying again would
 * get the same answer. The body is never sent to a redirect target.
 */
export async function attemptCallback(
  deps: NotifyDeps,
  deliveryId: string,
  options: { last: boolean },
): Promise<Outcome> {
  const { db, config, log } = deps;
  const delivery = await db.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) return 'failed';
  if (delivery.status === 'sent') return 'sent';
  if (delivery.status === 'failed' && delivery.attempt >= DELIVERY_ATTEMPTS) return 'failed';

  const payload = await buildCallbackPayload(
    db,
    config,
    deliveryId,
    delivery.scanId,
    delivery.event as WebhookEvent,
  );
  if (payload === null) {
    await db.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'failed', error: 'The scan no longer exists.' },
    });
    return 'failed';
  }

  const body = JSON.stringify(payload);
  const record = async (fields: {
    responseStatus: number | null;
    error: string | null;
    status: 'pending' | 'sent' | 'failed';
  }): Promise<void> => {
    await db.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempt: { increment: 1 },
        responseStatus: fields.responseStatus,
        error: fields.error,
        status: fields.status,
        ...(fields.status === 'sent' ? { deliveredAt: new Date() } : {}),
      },
    });
  };

  let outcome: Outcome;
  try {
    const response = await deps.client.fetch(delivery.url, {
      method: 'POST',
      body,
      timeoutMs: 15_000,
      maxBytes: 16 * 1024,
      headers: {
        'content-type': 'application/json',
        'x-beacon-event': delivery.event,
        'x-beacon-delivery': deliveryId,
        'x-beacon-attempt': String(delivery.attempt + 1),
        'x-beacon-signature': await callbackSignature(config.WEBHOOK_SIGNING_SECRET, body),
      },
    });
    if (response.status >= 200 && response.status < 300) {
      await record({ responseStatus: response.status, error: null, status: 'sent' });
      return 'sent';
    }
    const retryable = response.status >= 500 || RETRYABLE_STATUSES.has(response.status);
    const error =
      response.status >= 300 && response.status < 400
        ? `The callback URL answered with a redirect (HTTP ${response.status}). Redirects are not followed. Use the final URL.`
        : `The callback URL answered HTTP ${response.status}.`;
    outcome = retryable && !options.last ? 'retry' : 'failed';
    await record({
      responseStatus: response.status,
      error,
      status: outcome === 'retry' ? 'pending' : 'failed',
    });
  } catch (error) {
    const blocked = error instanceof FetchError && error.code === 'blocked';
    const message = blocked
      ? `The callback URL cannot be used: ${(error as Error).message}`
      : `The callback could not be delivered: ${error instanceof Error ? error.message : String(error)}`;
    outcome = blocked || options.last ? 'failed' : 'retry';
    await record({
      responseStatus: null,
      error: message.slice(0, 500),
      status: outcome === 'retry' ? 'pending' : 'failed',
    });
  }
  log.warn({ deliveryId, url: delivery.url, outcome }, 'callback attempt did not succeed');
  return outcome;
}
