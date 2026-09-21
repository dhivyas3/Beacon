import { z } from 'zod';
import {
  CHECK_FREQUENCIES,
  CHECK_TYPES,
  EXTERNAL_TRIGGER_SOURCES,
  FORM_MODES,
  MAX_PINNED_PAGES,
  MAX_RECIPIENTS,
  MAX_STATIC_PAGES,
  PAGE_SELECTION_MODES,
  SAMPLE_SIZE,
  SCAN_STATUSES,
  TRIGGER_TYPES,
} from '../constants.js';
import { normalizeUrl } from '../url.js';
import { HttpUrlSchema, MetadataSchema, PaginationQuerySchema } from './common.js';

const HourSchema = z.number().int().min(0).max(23);
const DayOfWeekSchema = z.number().int().min(0).max(6).describe('0 is Sunday.');
const DayOfMonthSchema = z
  .number()
  .int()
  .min(1)
  .max(31)
  .describe('Clamped to the last day of months that are shorter.');

export const WebsiteRecipientSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    name: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'WebsiteRecipient' });
export type WebsiteRecipient = z.infer<typeof WebsiteRecipientSchema>;

export const RecipientInputSchema = z
  .object({
    email: z.email().max(254),
    name: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .meta({ id: 'RecipientInput' });
export type RecipientInput = z.infer<typeof RecipientInputSchema>;

/** The latest completed check of a website, for lists and cards. */
export const WebsiteLatestSchema = z
  .object({
    scanId: z.string(),
    runNumber: z.number().int(),
    status: z.enum(SCAN_STATUSES),
    healthScore: z.number().int().nullable(),
    critical: z.number().int(),
    warnings: z.number().int(),
    pages: z.number().int(),
    finishedAt: z.iso.datetime().nullable(),
    scoreChange: z
      .number()
      .int()
      .nullable()
      .describe('Score minus the score of the completed check before it.'),
    triggeredByType: z.enum(TRIGGER_TYPES),
  })
  .meta({ id: 'WebsiteLatest' });
export type WebsiteLatest = z.infer<typeof WebsiteLatestSchema>;

export const WebsiteSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    hostname: z.string(),
    owner: z.object({ id: z.string(), name: z.string() }).nullable(),
    checkFrequency: z.enum(CHECK_FREQUENCIES),
    scheduleDayOfWeek: z.number().int().nullable(),
    scheduleDayOfMonth: z.number().int().nullable(),
    scheduleHourUtc: z.number().int(),
    pageSelectionMode: z.enum(PAGE_SELECTION_MODES),
    staticPageUrls: z.array(z.string()),
    pinnedPageUrls: z.array(z.string()),
    sampleSize: z.number().int(),
    enabledChecks: z.array(z.enum(CHECK_TYPES)),
    formMode: z.enum(FORM_MODES),
    isActive: z.boolean(),
    lastCheckAt: z.iso.datetime().nullable(),
    nextCheckAt: z.iso.datetime().nullable(),
    lastRunError: z
      .string()
      .nullable()
      .describe('Why the last scheduled run could not start, or null.'),
    recipients: z.array(WebsiteRecipientSchema),
    latest: WebsiteLatestSchema.nullable(),
    pagesEverChecked: z
      .number()
      .int()
      .describe('Distinct pages checked across every completed check of this website.'),
    activeScanId: z.string().nullable().describe('A check that is queued or running right now.'),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'Website',
    example: {
      id: 'web_a1B2c3D4e5F6',
      name: 'Example Estates',
      url: 'https://www.example-estates.co.uk/',
      hostname: 'www.example-estates.co.uk',
      owner: { id: 'usr_x9Y8w7V6u5T4', name: 'Dana Admin' },
      checkFrequency: 'monthly',
      scheduleDayOfWeek: null,
      scheduleDayOfMonth: 1,
      scheduleHourUtc: 6,
      pageSelectionMode: 'random_sample',
      staticPageUrls: [],
      pinnedPageUrls: ['https://www.example-estates.co.uk/contact/'],
      sampleSize: 8,
      enabledChecks: ['images', 'links', 'forms', 'seo', 'page-health'],
      formMode: 'validate_only',
      isActive: true,
      lastCheckAt: '2026-09-01T06:04:12.000Z',
      nextCheckAt: '2026-10-01T06:00:00.000Z',
      lastRunError: null,
      recipients: [
        {
          id: 'rcp_Ab12Cd34Ef56',
          email: 'owner@example-estates.co.uk',
          name: 'Sam Owner',
          isActive: true,
          createdAt: '2026-08-01T09:00:00.000Z',
        },
      ],
      latest: {
        scanId: 'scn_a1B2c3D4e5F6',
        runNumber: 7,
        status: 'completed',
        healthScore: 94,
        critical: 0,
        warnings: 3,
        pages: 8,
        finishedAt: '2026-09-01T06:04:12.000Z',
        scoreChange: 4,
        triggeredByType: 'scheduled',
      },
      pagesEverChecked: 41,
      activeScanId: null,
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-09-01T06:04:12.000Z',
    },
  });
export type Website = z.infer<typeof WebsiteSchema>;

/** The fields that describe how a website is checked. Shared by create, update and the scheduler. */
export interface WebsiteConfig {
  url: string;
  checkFrequency: (typeof CHECK_FREQUENCIES)[number];
  scheduleDayOfWeek: number | null;
  scheduleDayOfMonth: number | null;
  pageSelectionMode: (typeof PAGE_SELECTION_MODES)[number];
  staticPageUrls: readonly string[];
  pinnedPageUrls: readonly string[];
  sampleSize: number;
  enabledChecks: readonly string[];
}

export interface ConfigProblem {
  field: string;
  message: string;
}

function originOf(url: string): string | null {
  const normal = normalizeUrl(url);
  return normal === null ? null : new URL(normal).origin;
}

/**
 * Rules that involve more than one field. Returns every problem, so a form can show them all at
 * once. Used when creating, and after merging a partial update into what is already stored.
 */
export function websiteConfigProblems(config: WebsiteConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const siteOrigin = originOf(config.url);

  if (config.checkFrequency === 'weekly' && config.scheduleDayOfWeek === null) {
    problems.push({
      field: 'scheduleDayOfWeek',
      message: 'Choose the day of the week for a weekly schedule.',
    });
  }
  if (config.checkFrequency === 'monthly' && config.scheduleDayOfMonth === null) {
    problems.push({
      field: 'scheduleDayOfMonth',
      message: 'Choose the day of the month for a monthly schedule.',
    });
  }
  if (config.enabledChecks.length === 0) {
    problems.push({ field: 'enabledChecks', message: 'Pick at least one check.' });
  }

  if (config.pageSelectionMode === 'static_list' && config.staticPageUrls.length === 0) {
    problems.push({
      field: 'staticPageUrls',
      message: 'Add at least one page to check, or choose another page selection.',
    });
  }
  if (
    config.pageSelectionMode === 'random_sample' &&
    (config.sampleSize < SAMPLE_SIZE.min || config.sampleSize > SAMPLE_SIZE.max)
  ) {
    problems.push({
      field: 'sampleSize',
      message: `The sample size must be between ${SAMPLE_SIZE.min} and ${SAMPLE_SIZE.max}.`,
    });
  }

  for (const [field, urls] of [
    ['staticPageUrls', config.staticPageUrls],
    ['pinnedPageUrls', config.pinnedPageUrls],
  ] as const) {
    const foreign = urls.filter((url) => originOf(url) !== siteOrigin);
    if (foreign.length > 0) {
      problems.push({
        field,
        message: `Every page must be on ${siteOrigin ?? 'the website'}. Not on it: ${foreign
          .slice(0, 3)
          .join(', ')}.`,
      });
    }
  }
  return problems;
}

const WebsiteFieldsShape = {
  name: z.string().trim().min(1).max(100).describe('A friendly name shown in the dashboard.'),
  url: HttpUrlSchema.describe('The site to check. Its hostname must be on the allowed list.'),
  checkFrequency: z.enum(CHECK_FREQUENCIES),
  scheduleDayOfWeek: DayOfWeekSchema.nullable(),
  scheduleDayOfMonth: DayOfMonthSchema.nullable(),
  scheduleHourUtc: HourSchema,
  pageSelectionMode: z.enum(PAGE_SELECTION_MODES),
  staticPageUrls: z
    .array(HttpUrlSchema)
    .max(MAX_STATIC_PAGES)
    .describe('Used by `static_list`: exactly these pages are checked.'),
  pinnedPageUrls: z
    .array(HttpUrlSchema)
    .max(MAX_PINNED_PAGES)
    .describe('Used by `random_sample`: always included, on top of the homepage.'),
  sampleSize: z
    .number()
    .int()
    .min(SAMPLE_SIZE.min)
    .max(SAMPLE_SIZE.max)
    .describe('Used by `random_sample`: the number of pages checked, homepage included.'),
  enabledChecks: z.array(z.enum(CHECK_TYPES)).min(1),
  formMode: z.enum(FORM_MODES).describe('`submit` requires the `forms:submit` scope.'),
  isActive: z.boolean().describe('A paused website is not checked on its schedule.'),
};

export const CreateWebsiteBodySchema = z
  .object({
    ...WebsiteFieldsShape,
    checkFrequency: WebsiteFieldsShape.checkFrequency.default('weekly'),
    scheduleDayOfWeek: WebsiteFieldsShape.scheduleDayOfWeek.default(1),
    scheduleDayOfMonth: WebsiteFieldsShape.scheduleDayOfMonth.default(1),
    scheduleHourUtc: WebsiteFieldsShape.scheduleHourUtc.default(6),
    pageSelectionMode: WebsiteFieldsShape.pageSelectionMode.default('random_sample'),
    staticPageUrls: WebsiteFieldsShape.staticPageUrls.default([]),
    pinnedPageUrls: WebsiteFieldsShape.pinnedPageUrls.default([]),
    sampleSize: WebsiteFieldsShape.sampleSize.default(SAMPLE_SIZE.default),
    enabledChecks: WebsiteFieldsShape.enabledChecks.default([...CHECK_TYPES]),
    formMode: WebsiteFieldsShape.formMode.default('validate_only'),
    isActive: WebsiteFieldsShape.isActive.default(true),
    recipients: z.array(RecipientInputSchema).max(MAX_RECIPIENTS).default([]),
  })
  .superRefine((body, ctx) => {
    for (const problem of websiteConfigProblems(body)) {
      ctx.addIssue({ code: 'custom', path: [problem.field], message: problem.message });
    }
  })
  .meta({
    id: 'CreateWebsiteBody',
    example: {
      name: 'Example Estates',
      url: 'https://www.example-estates.co.uk',
      checkFrequency: 'monthly',
      scheduleDayOfMonth: 1,
      scheduleHourUtc: 6,
      pageSelectionMode: 'random_sample',
      sampleSize: 8,
      pinnedPageUrls: ['https://www.example-estates.co.uk/contact/'],
      recipients: [{ email: 'owner@example-estates.co.uk', name: 'Sam Owner' }],
    },
  });
export type CreateWebsiteBody = z.infer<typeof CreateWebsiteBodySchema>;

/** Every field is optional. The service checks the combination once merged with what is stored. */
export const UpdateWebsiteBodySchema = z
  .object(WebsiteFieldsShape)
  .partial()
  .meta({ id: 'UpdateWebsiteBody', example: { checkFrequency: 'weekly', scheduleDayOfWeek: 1 } });
export type UpdateWebsiteBody = z.infer<typeof UpdateWebsiteBodySchema>;

export const ListWebsitesQuerySchema = PaginationQuerySchema.extend({
  q: z.string().trim().max(200).optional().describe('Substring match on name or URL.'),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type ListWebsitesQuery = z.infer<typeof ListWebsitesQuerySchema>;

export const AddRecipientBodySchema = RecipientInputSchema;

export const WebsiteHistoryItemSchema = z
  .object({
    scanId: z.string(),
    runNumber: z.number().int(),
    triggeredByType: z.enum(TRIGGER_TYPES),
    healthScore: z.number().int().nullable(),
    critical: z.number().int(),
    warnings: z.number().int(),
    pages: z.number().int(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'WebsiteHistoryItem' });
export type WebsiteHistoryItem = z.infer<typeof WebsiteHistoryItemSchema>;

export const CheckNowBodySchema = z
  .object({
    source: z
      .enum(EXTERNAL_TRIGGER_SOURCES)
      .optional()
      .describe('API keys only: mark the check as started by n8n or monday.com.'),
    callbackUrl: HttpUrlSchema.optional().describe(
      'Receives a signed POST when the check completes, fails or is cancelled.',
    ),
    metadata: MetadataSchema.optional(),
  })
  .meta({
    id: 'CheckNowBody',
    example: { source: 'n8n', callbackUrl: 'https://n8n.example.com/webhook/beacon-callback' },
  });
export type CheckNowBody = z.infer<typeof CheckNowBodySchema>;
