import { z } from 'zod';
import { CHECK_TYPES, PAGE_STATUSES, SEVERITIES } from '../constants.js';
import { PaginationQuerySchema } from './common.js';

export const ScanPageSchema = z
  .object({
    id: z.string(),
    scanId: z.string(),
    url: z.string(),
    status: z.enum(PAGE_STATUSES),
    httpStatus: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    template: z.string().nullable().describe('Groups structurally similar pages.'),
    criticalCount: z.number().int(),
    warningCount: z.number().int(),
  })
  .meta({ id: 'ScanPage' });
export type ScanPage = z.infer<typeof ScanPageSchema>;

export const ListPagesQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(PAGE_STATUSES).optional(),
  hasIssues: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  q: z.string().trim().max(200).optional().describe('Substring match on the page URL.'),
  checkType: z
    .enum(CHECK_TYPES)
    .optional()
    .describe('Only pages with at least one open issue from this check.'),
  severity: z
    .enum(SEVERITIES)
    .optional()
    .describe('Only pages with at least one open issue of this severity.'),
});
export type ListPagesQuery = z.infer<typeof ListPagesQuerySchema>;
