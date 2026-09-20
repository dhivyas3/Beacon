import { z } from 'zod';
import { EXAMPLE_ISSUE } from './examples.js';
import { CHECK_TYPES, COMPARISON_LABELS, ISSUE_STATES, SEVERITIES } from '../constants.js';
import { PaginationQuerySchema } from './common.js';

export const IssueSchema = z
  .object({
    id: z.string(),
    scanId: z.string(),
    pageId: z.string().nullable().describe('Null for site-wide issues such as robots.txt.'),
    pageUrl: z.string().nullable(),
    checkType: z.enum(CHECK_TYPES),
    severity: z.enum(SEVERITIES),
    fingerprint: z.string().describe('Identical issues across pages share a fingerprint.'),
    message: z.string(),
    selector: z.string().nullable(),
    resourceUrl: z.string().nullable(),
    evidence: z.record(z.string(), z.unknown()),
    screenshotUrl: z.string().nullable(),
    state: z.enum(ISSUE_STATES),
    ignoreNote: z.string().nullable(),
    comparison: z
      .enum(COMPARISON_LABELS)
      .nullable()
      .describe('Versus the previous completed scan of this hostname. Null when there is none.'),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Issue', example: EXAMPLE_ISSUE });
export type Issue = z.infer<typeof IssueSchema>;

export const GroupedIssueSchema = z
  .object({
    fingerprint: z.string(),
    checkType: z.enum(CHECK_TYPES),
    severity: z.enum(SEVERITIES),
    message: z.string(),
    affectedPages: z.number().int().min(0),
    occurrences: z.number().int().min(1),
    state: z.enum(ISSUE_STATES).describe('`ignored` only when every occurrence is ignored.'),
    comparison: z.enum(COMPARISON_LABELS).nullable(),
    sample: IssueSchema.describe('One representative occurrence.'),
  })
  .meta({ id: 'GroupedIssue' });
export type GroupedIssue = z.infer<typeof GroupedIssueSchema>;

export const FixedIssueSchema = z
  .object({
    fingerprint: z.string(),
    checkType: z.enum(CHECK_TYPES),
    severity: z.enum(SEVERITIES),
    message: z.string(),
    affectedPages: z.number().int(),
  })
  .meta({ id: 'FixedIssue' });
export type FixedIssue = z.infer<typeof FixedIssueSchema>;

export const ListIssuesQuerySchema = PaginationQuerySchema.extend({
  severity: z.enum(SEVERITIES).optional(),
  checkType: z.enum(CHECK_TYPES).optional(),
  state: z.enum(ISSUE_STATES).optional(),
  pageId: z.string().optional(),
  groupBy: z.enum(['fingerprint']).optional().describe('Group identical issues across pages.'),
});
export type ListIssuesQuery = z.infer<typeof ListIssuesQuerySchema>;

export const UpdateIssueBodySchema = z
  .object({
    state: z.enum(ISSUE_STATES),
    ignoreNote: z.string().trim().max(500).nullable().optional(),
  })
  .meta({
    id: 'UpdateIssueBody',
    example: { state: 'ignored', ignoreNote: 'Known: tracked in MON-1042' },
  });
export type UpdateIssueBody = z.infer<typeof UpdateIssueBodySchema>;
