import type { ErrorCode } from '@beacon/shared';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ApiError } from '../lib/errors.js';

const INTERNAL_MESSAGE =
  'Something went wrong on our side. Try again, and contact an admin if it keeps happening.';

function send(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
) {
  return reply.code(status).send({
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return 'bad_request';
  }
}

/** Turns every failure into `{ error: { code, message, details? } }` with the right status. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    send(
      reply,
      404,
      'not_found',
      `Route ${request.method} ${request.url.split('?')[0] ?? ''} does not exist.`,
    ),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return send(reply, error.statusCode, error.code, error.message, error.details);
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const where = error.validationContext ?? 'request';
      const issues = error.validation.map((issue) => ({
        in: where,
        path: issue.instancePath.replace(/^\//, '').replaceAll('/', '.'),
        message: issue.message,
      }));
      const summary = issues
        .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
        .join('; ');
      return send(reply, 400, 'validation_error', `The ${where} is not valid. ${summary}`, {
        issues,
      });
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response did not match its schema');
      return send(reply, 500, 'internal_error', INTERNAL_MESSAGE);
    }

    const failure = error as FastifyError;
    const status = typeof failure.statusCode === 'number' ? failure.statusCode : 500;
    if (status >= 400 && status < 500) {
      return send(reply, status, codeForStatus(status), failure.message);
    }

    request.log.error({ err: error }, 'unhandled error');
    return send(reply, 500, 'internal_error', INTERNAL_MESSAGE);
  });
}
