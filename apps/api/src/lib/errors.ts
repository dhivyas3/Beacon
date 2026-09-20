import { ERROR_STATUS, type ErrorCode } from '@qa-hub/shared';

/** An error that maps to a JSON error envelope: `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = ERROR_STATUS[code];
  }
}

export function notFound(what: string, id: string): ApiError {
  return new ApiError('not_found', `${what} ${id} was not found.`);
}
