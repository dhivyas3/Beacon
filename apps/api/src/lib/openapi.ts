import { ErrorResponseSchema } from '@qa-hub/shared';

/** Response schema entries for the documented error statuses of a route. */
export function errorResponses<const T extends number>(
  ...statuses: T[]
): Record<T, typeof ErrorResponseSchema> {
  return Object.fromEntries(statuses.map((status) => [status, ErrorResponseSchema])) as Record<
    T,
    typeof ErrorResponseSchema
  >;
}

export const COMMON_ERRORS = [401, 403, 429] as const;
