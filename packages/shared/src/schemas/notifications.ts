import { z } from 'zod';
import {
  CHECK_TYPES,
  DELIVERY_STATUSES,
  PAGE_SELECTION_MODES,
  TRIGGER_TYPES,
  WEBHOOK_EVENTS,
} from '../constants.js';
import { MetadataSchema, PaginationQuerySchema } from './common.js';

/**
 * The body Beacon POSTs to a scan's `callbackUrl` when it completes, fails or is cancelled.
 *
 * It is signed: `X-Beacon-Signature: sha256=<HMAC-SHA256 of the raw body>`, keyed with the webhook
 * secret from Settings. Verify the signature over the exact bytes received, before parsing them.
 */
export const CallbackPayloadSchema = z
  .object({
    event: z.enum(WEBHOOK_EVENTS),
    deliveryId: z.string().describe('Stable across retries. Use it to ignore duplicates.'),
    sentAt: z.iso.datetime(),
    scan: z.object({
      id: z.string(),
      url: z.string(),
      hostname: z.string(),
      runNumber: z.number().int(),
      status: z.enum(['completed', 'failed', 'cancelled']),
      checks: z.array(z.enum(CHECK_TYPES)),
      triggeredByType: z.enum(TRIGGER_TYPES),
      pageSelectionMode: z.enum(PAGE_SELECTION_MODES),
      website: z.object({ id: z.string(), name: z.string() }).nullable(),
      metadata: MetadataSchema.nullable().describe('Echoed back exactly as it was sent.'),
      summary: z.object({
        healthScore: z.number().int().nullable(),
        scoreChange: z.number().int().nullable(),
        pages: z.number().int(),
        critical: z.number().int(),
        warnings: z.number().int(),
        passed: z.number().int(),
      }),
      errorMessage: z.string().nullable(),
      createdAt: z.iso.datetime(),
      startedAt: z.iso.datetime().nullable(),
      finishedAt: z.iso.datetime().nullable(),
      statusUrl: z.string(),
      reportUrl: z.string(),
    }),
  })
  .meta({
    id: 'CallbackPayload',
    example: {
      event: 'scan.completed',
      deliveryId: 'whd_Ab12Cd34Ef56',
      sentAt: '2026-09-18T10:47:02.000Z',
      scan: {
        id: 'scn_a1B2c3D4e5F6',
        url: 'https://www.example-estates.co.uk/',
        hostname: 'www.example-estates.co.uk',
        runNumber: 7,
        status: 'completed',
        checks: ['images', 'links', 'seo'],
        triggeredByType: 'n8n',
        pageSelectionMode: 'random_sample',
        website: { id: 'web_a1B2c3D4e5F6', name: 'Example Estates' },
        metadata: { mondayItemId: '1234567890' },
        summary: { healthScore: 94, scoreChange: 4, pages: 8, critical: 0, warnings: 3, passed: 5 },
        errorMessage: null,
        createdAt: '2026-09-18T10:42:40.000Z',
        startedAt: '2026-09-18T10:42:49.000Z',
        finishedAt: '2026-09-18T10:47:01.000Z',
        statusUrl: 'https://beacon.example.com/api/v1/scans/scn_a1B2c3D4e5F6',
        reportUrl: 'https://beacon.example.com/scans/scn_a1B2c3D4e5F6',
      },
    },
  });
export type CallbackPayload = z.infer<typeof CallbackPayloadSchema>;

export const EmailDeliverySchema = z
  .object({
    id: z.string(),
    scanId: z.string(),
    email: z.string(),
    subject: z.string().nullable(),
    status: z.enum(DELIVERY_STATUSES),
    attempts: z.number().int(),
    provider: z.string().nullable(),
    providerMessageId: z.string().nullable(),
    error: z
      .string()
      .nullable()
      .describe('Why the last attempt failed, or why the email was not sent, or null.'),
    createdAt: z.iso.datetime(),
    sentAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'EmailDelivery' });
export type EmailDelivery = z.infer<typeof EmailDeliverySchema>;

export const ListEmailDeliveriesQuerySchema = PaginationQuerySchema.extend({
  scanId: z.string().max(64).optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
});
export type ListEmailDeliveriesQuery = z.infer<typeof ListEmailDeliveriesQuerySchema>;

/** How the last completed check's email went, for the website page. */
export const EmailStatusSchema = z
  .object({
    scanId: z.string(),
    sent: z.number().int(),
    failed: z.number().int(),
    pending: z.number().int(),
    lastError: z.string().nullable(),
  })
  .meta({ id: 'EmailStatus' });
export type EmailStatus = z.infer<typeof EmailStatusSchema>;
