import { z } from 'zod';
import { EXAMPLE_SCAN } from './examples.js';
import { CHECK_TYPES, FORM_MODES, SCAN_STATUSES } from '../constants.js';
import { HttpUrlSchema, MetadataSchema, PaginationQuerySchema } from './common.js';
import { ProgressSchema } from './progress.js';

export const ScanSummarySchema = z
  .object({
    healthScore: z.number().int().min(0).max(100).nullable().describe('Null until completed.'),
    pages: z.number().int().min(0),
    critical: z.number().int().min(0),
    warnings: z.number().int().min(0),
    passed: z.number().int().min(0).describe('Pages with no critical issue or warning.'),
  })
  .meta({ id: 'ScanSummary' });
export type ScanSummary = z.infer<typeof ScanSummarySchema>;

export const TriggeredBySchema = z
  .object({
    type: z.enum(['user', 'api_key']),
    id: z.string(),
    name: z.string(),
  })
  .meta({ id: 'TriggeredBy' });
export type TriggeredBy = z.infer<typeof TriggeredBySchema>;

export const ScanSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    hostname: z.string(),
    runNumber: z.number().int().min(1),
    status: z.enum(SCAN_STATUSES),
    checks: z.array(z.enum(CHECK_TYPES)),
    formMode: z.enum(FORM_MODES),
    callbackUrl: z.string().nullable(),
    metadata: MetadataSchema.nullable(),
    progress: ProgressSchema,
    summary: ScanSummarySchema,
    triggeredBy: TriggeredBySchema.nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    statusUrl: z.string(),
    reportUrl: z.string(),
  })
  .meta({ id: 'Scan', example: EXAMPLE_SCAN });
export type Scan = z.infer<typeof ScanSchema>;

export const CheckResultSchema = z
  .object({
    checkType: z.enum(CHECK_TYPES),
    pagesChecked: z.number().int().min(0),
    issuesFound: z.number().int().min(0),
  })
  .meta({ id: 'CheckResult' });
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const PreviousScanSchema = z
  .object({
    id: z.string(),
    runNumber: z.number().int(),
    healthScore: z.number().int().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PreviousScan' });
export type PreviousScan = z.infer<typeof PreviousScanSchema>;

export const ScanDetailSchema = ScanSchema.extend({
  checkResults: z.array(CheckResultSchema),
  previousScan: PreviousScanSchema.nullable(),
  scoreChange: z.number().int().nullable().describe('Health score minus the previous scan score.'),
  fixedIssueCount: z.number().int().min(0),
}).meta({ id: 'ScanDetail' });
export type ScanDetail = z.infer<typeof ScanDetailSchema>;

export const CreateScanBodySchema = z
  .object({
    url: HttpUrlSchema.describe('The live site to scan. Its hostname must be on the allowed list.'),
    checks: z.array(z.enum(CHECK_TYPES)).min(1).optional().describe('Defaults to every check.'),
    formMode: z
      .enum(FORM_MODES)
      .optional()
      .describe('`submit` requires the `forms:submit` scope. Defaults to `detect`.'),
    callbackUrl: HttpUrlSchema.optional().describe(
      'Receives a signed POST when the scan completes, fails or is cancelled.',
    ),
    metadata: MetadataSchema.optional(),
  })
  .meta({
    id: 'CreateScanBody',
    example: {
      url: 'https://www.example-estates.co.uk',
      checks: ['images', 'links', 'seo'],
      formMode: 'detect',
      callbackUrl: 'https://n8n.example.com/webhook/qa-hub-callback',
      metadata: { mondayItemId: '1234567890' },
    },
  });
export type CreateScanBody = z.infer<typeof CreateScanBodySchema>;

export const CreateScanResponseSchema = z
  .object({
    id: z.string(),
    status: z.enum(SCAN_STATUSES),
    statusUrl: z.string(),
    reportUrl: z.string(),
  })
  .meta({
    id: 'CreateScanResponse',
    example: {
      id: 'scn_a1B2c3D4e5F6',
      status: 'queued',
      statusUrl: 'https://qa.example.com/api/v1/scans/scn_a1B2c3D4e5F6',
      reportUrl: 'https://qa.example.com/scans/scn_a1B2c3D4e5F6',
    },
  });
export type CreateScanResponse = z.infer<typeof CreateScanResponseSchema>;

export const ListScansQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(SCAN_STATUSES).optional(),
  hostname: z.string().trim().toLowerCase().max(253).optional(),
  q: z.string().trim().max(200).optional().describe('Substring match on URL.'),
});
export type ListScansQuery = z.infer<typeof ListScansQuerySchema>;
