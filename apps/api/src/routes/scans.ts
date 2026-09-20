import {
  CreateScanBodySchema,
  CreateScanResponseSchema,
  GroupedIssueSchema,
  IdParamSchema,
  IssueSchema,
  ListIssuesQuerySchema,
  ListPagesQuerySchema,
  ListScansQuerySchema,
  ScanDetailSchema,
  ScanPageSchema,
  ScanSchema,
  UpdateIssueBodySchema,
  pageOf,
  type Page,
  type ScanPage,
} from '@qa-hub/shared';
import type { Prisma } from '@qa-hub/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, notFound } from '../lib/errors.js';
import { errorResponses } from '../lib/openapi.js';
import { paginateById } from '../lib/pagination.js';
import { listGroupedIssues, listIssues, updateIssue } from '../services/issues.js';
import { statusUrlOf, reportUrlOf } from '../services/scan-view.js';
import { ScanService } from '../services/scans.js';
import type { ScanQueue } from '../queue.js';
import type { HostResolver } from '@qa-hub/net';
import { InvalidStorageKeyError, type Storage } from '@qa-hub/storage';

export interface ScanRouteOptions {
  queue: ScanQueue;
  resolver: HostResolver | undefined;
  storage: Storage;
}

const IssueParamsSchema = z.object({
  id: z.string().min(1).max(64),
  issueId: z.string().min(1).max(64),
});

const IssuesResponseSchema = z.union([pageOf(IssueSchema), pageOf(GroupedIssueSchema)]);

export const scanRoutes: FastifyPluginAsyncZod<ScanRouteOptions> = async (app, options) => {
  const scans = new ScanService({
    db: app.db,
    config: app.config,
    queue: options.queue,
    resolver: options.resolver,
  });
  const view = { publicUrl: app.config.PUBLIC_URL };

  app.post(
    '/scans',
    {
      config: { auth: 'scans:write' },
      schema: {
        tags: ['Scans'],
        summary: 'Start a scan',
        description: [
          'Queues a scan of a live site and returns immediately with `202`.',
          '',
          '- The hostname must be on the allowed domains list.',
          '- Send an `Idempotency-Key` header to make retries safe. A repeated key returns the original scan.',
          '- If the hostname already has a queued or running scan, the response is `409` and `error.details.scan` holds that scan.',
          '- `formMode: "submit"` needs the `forms:submit` scope.',
        ].join('\n'),
        headers: z.looseObject({
          'idempotency-key': z
            .string()
            .optional()
            .describe('Any unique string up to 200 characters. Scoped to the caller.'),
        }),
        body: CreateScanBodySchema,
        response: {
          202: CreateScanResponseSchema,
          ...errorResponses(400, 401, 403, 409, 422, 429),
        },
      },
    },
    async (request, reply) => {
      const actor = request.actor;
      if (!actor) throw new ApiError('unauthorized', 'Sign in to continue.');
      const result = await scans.create(actor, request.body, request.headers['idempotency-key']);
      if (result.replayed) void reply.header('idempotent-replayed', 'true');
      const { scan } = result;
      return reply.code(202).send({
        id: scan.id,
        status: scan.status,
        statusUrl: statusUrlOf(view.publicUrl, scan.id),
        reportUrl: reportUrlOf(view.publicUrl, scan.id),
      });
    },
  );

  app.get(
    '/scans',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Scans'],
        summary: 'List scans',
        description: 'Newest first, cursor paginated. Each scan carries its live `progress`.',
        querystring: ListScansQuerySchema,
        response: { 200: pageOf(ScanSchema), ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (request) => scans.list(request.query),
  );

  app.get(
    '/scans/:id',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Scans'],
        summary: 'Get a scan',
        description:
          'Status, progress, summary, metadata and per-check results. Checks that ran and found nothing appear with `issuesFound: 0`.',
        params: IdParamSchema,
        response: { 200: ScanDetailSchema, ...errorResponses(401, 403, 404, 429) },
      },
    },
    async (request) => scans.getDetail(request.params.id),
  );

  app.post(
    '/scans/:id/cancel',
    {
      config: { auth: 'scans:write' },
      schema: {
        tags: ['Scans'],
        summary: 'Cancel a scan',
        description:
          'Stops a queued, discovering or running scan. Returns `409` when the scan has already finished.',
        params: IdParamSchema,
        response: { 200: ScanSchema, ...errorResponses(401, 403, 404, 409, 429) },
      },
    },
    async (request) => scans.cancel(request.params.id),
  );

  app.get(
    '/scans/:id/pages',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Scans'],
        summary: 'List the pages of a scan',
        params: IdParamSchema,
        querystring: ListPagesQuerySchema,
        response: { 200: pageOf(ScanPageSchema), ...errorResponses(400, 401, 403, 404, 429) },
      },
    },
    async (request): Promise<Page<ScanPage>> => {
      const scan = await scans.getRow(request.params.id);
      const { status, hasIssues, q, checkType, severity, cursor, limit } = request.query;
      const where: Prisma.ScanPageWhereInput = {
        scanId: scan.id,
        ...(status ? { status } : {}),
        ...(q ? { url: { contains: q, mode: 'insensitive' } } : {}),
        ...(checkType || severity
          ? {
              issues: {
                some: {
                  state: 'open' as const,
                  ...(checkType ? { checkType } : {}),
                  ...(severity ? { severity } : {}),
                },
              },
            }
          : {}),
        ...(hasIssues === undefined
          ? {}
          : hasIssues
            ? { OR: [{ criticalCount: { gt: 0 } }, { warningCount: { gt: 0 } }] }
            : { criticalCount: 0, warningCount: 0 }),
      };
      const { rows, nextCursor } = await paginateById(limit, cursor, (args) =>
        app.db.scanPage.findMany({ where, orderBy: [{ url: 'asc' }, { id: 'asc' }], ...args }),
      );
      return {
        items: rows.map((row) => ({
          id: row.id,
          scanId: row.scanId,
          url: row.url,
          status: row.status,
          httpStatus: row.httpStatus,
          durationMs: row.durationMs,
          template: row.template,
          criticalCount: row.criticalCount,
          warningCount: row.warningCount,
        })),
        nextCursor,
      };
    },
  );

  app.get(
    '/scans/:id/issues',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Issues'],
        summary: 'List the issues of a scan',
        description: [
          'Most severe first. Filter with `severity`, `checkType`, `state` and `pageId`.',
          '',
          'With `groupBy=fingerprint` identical issues across pages collapse into one row with `affectedPages`, ideal for "By issue" views. Each issue carries `comparison` (`new` or `still_open`) against the previous completed scan of the hostname.',
        ].join('\n'),
        params: IdParamSchema,
        querystring: ListIssuesQuerySchema,
        response: { 200: IssuesResponseSchema, ...errorResponses(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const scan = await scans.getRow(request.params.id);
      return request.query.groupBy === 'fingerprint'
        ? listGroupedIssues(app.db, view, scan, request.query)
        : listIssues(app.db, view, scan, request.query);
    },
  );

  app.patch(
    '/scans/:id/issues/:issueId',
    {
      config: { auth: 'scans:write' },
      schema: {
        tags: ['Issues'],
        summary: 'Ignore or reopen an issue',
        description:
          'Marks one occurrence `ignored` (with an optional note) or `open`. For a completed scan the open counts and health score are recalculated.',
        params: IssueParamsSchema,
        body: UpdateIssueBodySchema,
        response: { 200: IssueSchema, ...errorResponses(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      await scans.getRow(request.params.id);
      return updateIssue(app.db, view, request.params.id, request.params.issueId, request.body);
    },
  );

  app.get(
    '/scans/:id/issues/:issueId/screenshot',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Issues'],
        summary: 'Screenshot of an issue',
        description:
          'A PNG of the page with the offending element outlined in red. Only critical issues found while checking a page have one, see `screenshotUrl` on the issue. Works with a session cookie, so it can be used directly as an image source in the dashboard.',
        produces: ['image/png'],
        params: IssueParamsSchema,
        response: {
          200: z.string().meta({ format: 'binary' }),
          ...errorResponses(401, 403, 404, 429),
        },
      },
    },
    async (request, reply) => {
      const issue = await app.db.scanIssue.findFirst({
        where: { id: request.params.issueId, scanId: request.params.id },
        select: { screenshotPath: true },
      });
      if (!issue) throw notFound('Issue', request.params.issueId);
      const stored = issue.screenshotPath
        ? await options.storage.get(issue.screenshotPath).catch((error: unknown) => {
            if (error instanceof InvalidStorageKeyError) return null;
            throw error;
          })
        : null;
      if (!stored) {
        throw new ApiError('not_found', 'This issue has no screenshot.');
      }
      return (
        reply
          .header('content-type', stored.contentType)
          .header('cache-control', 'private, max-age=86400, immutable')
          // The response schema describes a binary body for OpenAPI. Fastify sends a Buffer as is.
          .send(stored.data as never)
      );
    },
  );
};
