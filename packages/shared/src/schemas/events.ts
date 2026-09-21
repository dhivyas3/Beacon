import { z } from 'zod';
import { SCAN_STATUSES, WEBHOOK_EVENTS } from '../constants.js';
import { IssueSchema } from './issue.js';
import { ProgressSchema } from './progress.js';
import { ScanSummarySchema } from './scan.js';

/** Events on `GET /scans/:id/events`, sent as `event: <type>` with a JSON `data:` line. */
export const ProgressEventSchema = z
  .object({
    scanId: z.string(),
    status: z.enum(SCAN_STATUSES),
    progress: ProgressSchema,
    summary: ScanSummarySchema,
  })
  .meta({ id: 'ProgressEvent' });
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

export const IssueEventSchema = IssueSchema.meta({ id: 'IssueEvent' });
export type IssueEvent = z.infer<typeof IssueEventSchema>;

export const SSE_EVENT_TYPES = ['progress', 'issue', 'done'] as const;
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** Body POSTed to `callbackUrl`. Signed with `X-Beacon-Signature: sha256=<hmac>`. */
export const WebhookPayloadSchema = z
  .object({
    event: z.enum(WEBHOOK_EVENTS),
    id: z.string(),
    status: z.enum(SCAN_STATUSES),
    url: z.string(),
    summary: z.object({
      healthScore: z.number().int().nullable(),
      pages: z.number().int(),
      critical: z.number().int(),
      warnings: z.number().int(),
    }),
    reportUrl: z.string(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
  })
  .meta({
    id: 'WebhookPayload',
    example: {
      event: 'scan.completed',
      id: 'scn_a1B2c3D4e5F6',
      status: 'completed',
      url: 'https://www.example-estates.co.uk',
      summary: { healthScore: 82, pages: 214, critical: 6, warnings: 41 },
      reportUrl: 'https://qa.example.com/scans/scn_a1B2c3D4e5F6',
      metadata: { mondayItemId: '1234567890' },
    },
  });
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

export const SIGNATURE_HEADER = 'X-Beacon-Signature';
