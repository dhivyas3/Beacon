import { z } from 'zod';

export const ERROR_CODES = [
  'bad_request',
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'domain_not_allowed',
  'url_blocked',
  'rate_limited',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status for each error code. 400 is malformed input, 422 is a rule the input broke. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  domain_not_allowed: 422,
  url_blocked: 422,
  rate_limited: 429,
  internal_error: 500,
};

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string().describe('What happened and what to do next.'),
      details: z.unknown().optional(),
    }),
  })
  .meta({
    id: 'ErrorResponse',
    example: {
      error: {
        code: 'not_found',
        message: 'Scan scn_a1B2c3D4e5F6 was not found.',
      },
    },
  });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const PAGE_LIMIT_DEFAULT = 25;
export const PAGE_LIMIT_MAX = 100;

export const PaginationQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional().describe('Opaque cursor from `nextCursor`.'),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().describe('Pass as `cursor` to fetch the next page.'),
  });
}
export type Page<T> = { items: T[]; nextCursor: string | null };

export const IdParamSchema = z.object({ id: z.string().min(1).max(64) });

export const MetadataSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 8192, {
    message: 'metadata must be 8 KB or smaller when serialised.',
  })
  .describe('Stored and echoed back untouched, including in callbacks.');

export const HttpUrlSchema = z
  .url({ protocol: /^https?$/, message: 'Enter a full URL starting with http:// or https://.' })
  .max(2048);
