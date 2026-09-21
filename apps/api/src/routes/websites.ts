import {
  AddRecipientBodySchema,
  CheckNowBodySchema,
  CreateScanResponseSchema,
  CreateWebsiteBodySchema,
  IdParamSchema,
  ListWebsitesQuerySchema,
  PaginationQuerySchema,
  UpdateWebsiteBodySchema,
  WebsiteHistoryItemSchema,
  WebsiteRecipientSchema,
  WebsiteSchema,
  pageOf,
} from '@beacon/shared';
import type { HostResolver } from '@beacon/net';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { errorResponses } from '../lib/openapi.js';
import type { ScanQueue } from '../queue.js';
import type { Actor } from '../types.js';
import { reportUrlOf, statusUrlOf } from '../services/scan-view.js';
import { ScanService } from '../services/scans.js';
import { WebsiteService } from '../services/websites.js';

export interface WebsiteRouteOptions {
  queue: ScanQueue;
  resolver: HostResolver | undefined;
}

const RecipientParamsSchema = z.object({
  id: z.string().min(1).max(64),
  recipientId: z.string().min(1).max(64),
});

export const websiteRoutes: FastifyPluginAsyncZod<WebsiteRouteOptions> = async (app, options) => {
  const scans = new ScanService({
    db: app.db,
    config: app.config,
    queue: options.queue,
    resolver: options.resolver,
  });
  const websites = new WebsiteService({ db: app.db, scans });
  const view = { publicUrl: app.config.PUBLIC_URL };

  const actorOf = (request: { actor: Actor | null }): Actor => {
    if (!request.actor) throw new ApiError('unauthorized', 'Sign in to continue.');
    return request.actor;
  };

  app.post(
    '/websites',
    {
      config: { auth: 'scans:write' },
      schema: {
        tags: ['Websites'],
        summary: 'Register a website',
        description: [
          'Registers a site to be checked on a schedule. Its hostname must be on the allowed domains list, and only one website can exist per hostname.',
          '',
          '- `pageSelectionMode` decides which pages each check covers: `full` (every page), `static_list` (exactly `staticPageUrls`) or `random_sample` (a fresh sample of `sampleSize` pages, always including the homepage and `pinnedPageUrls`).',
          '- `checkFrequency` is `manual`, `daily`, `weekly` (with `scheduleDayOfWeek`) or `monthly` (with `scheduleDayOfMonth`, clamped to the last day of shorter months). Times are UTC.',
          '- `formMode: "submit"` needs the `forms:submit` scope.',
        ].join('\n'),
        body: CreateWebsiteBodySchema,
        response: { 201: WebsiteSchema, ...errorResponses(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const website = await websites.create(actorOf(request), request.body);
      return reply.code(201).send(website);
    },
  );

  app.get(
    '/websites',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Websites'],
        summary: 'List websites',
        description:
          'Alphabetical, cursor paginated. Each website carries its latest check, next scheduled check and pages checked so far.',
        querystring: ListWebsitesQuerySchema,
        response: { 200: pageOf(WebsiteSchema), ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (request) => websites.list(request.query),
  );

  app.get(
    '/websites/:id',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Websites'],
        summary: 'Get a website',
        params: IdParamSchema,
        response: { 200: WebsiteSchema, ...errorResponses(401, 403, 404, 429) },
      },
    },
    async (request) => websites.get(request.params.id),
  );

  app.patch(
    '/websites/:id',
    {
      config: { auth: 'scans:write' },
      schema: {
        tags: ['Websites'],
        summary: 'Update a website',
        description:
          'Send only the fields to change. Changing the schedule, or resuming a paused website, plans the next check again from now. The url must stay on the same hostname.',
        params: IdParamSchema,
        body: UpdateWebsiteBodySchema,
        response: { 200: WebsiteSchema, ...errorResponses(400, 401, 403, 404, 422, 429) },
      },
    },
    async (request) => websites.update(actorOf(request), request.params.id, request.body),
  );

  app.delete(
    '/websites/:id',
    {
      config: { auth: 'scans:write' },
      schema: {
        tags: ['Websites'],
        summary: 'Delete a website',
        description:
          'Removes the website and its recipients. Its past checks are kept as scans that belong to no website.',
        params: IdParamSchema,
        response: { 204: z.null(), ...errorResponses(401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      await websites.remove(request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/websites/:id/check-now',
    {
      config: { auth: 'scans:write' },
      schema: {
        tags: ['Websites'],
        summary: 'Check a website now',
        description: [
          "Starts a check immediately, outside the schedule, using the website's own configuration. Returns `202` like `POST /scans`.",
          '',
          'The scan is marked `manual_ui` for a signed-in user and `manual_api` for a key, or `n8n` / `monday` when the key sends `source`. If the website already has a queued or running check the response is `409`.',
        ].join('\n'),
        params: IdParamSchema,
        body: CheckNowBodySchema.nullish(),
        response: {
          202: CreateScanResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 422, 429),
        },
      },
    },
    async (request, reply) => {
      const { scan } = await websites.checkNow(
        actorOf(request),
        request.params.id,
        request.body ?? {},
      );
      return reply.code(202).send({
        id: scan.id,
        status: scan.status,
        statusUrl: statusUrlOf(view.publicUrl, scan.id),
        reportUrl: reportUrlOf(view.publicUrl, scan.id),
      });
    },
  );

  app.get(
    '/websites/:id/history',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Websites'],
        summary: 'Scores over time',
        description:
          'Completed checks of the website, newest first, cursor paginated. Reverse the list to chart it.',
        params: IdParamSchema,
        querystring: PaginationQuerySchema,
        response: {
          200: pageOf(WebsiteHistoryItemSchema),
          ...errorResponses(400, 401, 403, 404, 429),
        },
      },
    },
    async (request) => websites.history(request.params.id, request.query),
  );

  app.post(
    '/websites/:id/recipients',
    {
      config: { auth: 'scans:write' },
      schema: {
        tags: ['Websites'],
        summary: 'Add a recipient',
        description: 'The address receives the emailed report of every completed check.',
        params: IdParamSchema,
        body: AddRecipientBodySchema,
        response: { 201: WebsiteRecipientSchema, ...errorResponses(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const recipient = await websites.addRecipient(request.params.id, request.body);
      return reply.code(201).send(recipient);
    },
  );

  app.delete(
    '/websites/:id/recipients/:recipientId',
    {
      config: { auth: 'scans:write' },
      schema: {
        tags: ['Websites'],
        summary: 'Remove a recipient',
        params: RecipientParamsSchema,
        response: { 204: z.null(), ...errorResponses(401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      await websites.removeRecipient(request.params.id, request.params.recipientId);
      return reply.code(204).send(null);
    },
  );
};
