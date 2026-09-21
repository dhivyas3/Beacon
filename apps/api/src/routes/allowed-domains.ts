import { isUniqueViolation } from '@beacon/db';
import {
  AllowedDomainSchema,
  CreateAllowedDomainBodySchema,
  IdParamSchema,
  newId,
  type AllowedDomain,
} from '@beacon/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, notFound } from '../lib/errors.js';
import { errorResponses } from '../lib/openapi.js';

interface DomainRow {
  id: string;
  hostname: string;
  note: string | null;
  createdAt: Date;
  createdBy: { name: string } | null;
}

function toDomainDto(row: DomainRow): AllowedDomain {
  return {
    id: row.id,
    hostname: row.hostname,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy?.name ?? null,
  };
}

const UpdateDomainBodySchema = z
  .object({ note: z.string().trim().max(200).nullable() })
  .meta({ id: 'UpdateAllowedDomainBody' });

const include = { createdBy: { select: { name: true } } } as const;

export const allowedDomainRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/allowed-domains',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['Allowed domains'],
        summary: 'List allowed domains',
        description:
          'Scans are only accepted for hostnames on this list. An entry starting with `*.` matches the apex and every subdomain.',
        security: [{ cookieAuth: [] }],
        response: {
          200: z.object({ items: z.array(AllowedDomainSchema) }),
          ...errorResponses(401, 403),
        },
      },
    },
    async () => {
      const rows = await app.db.allowedDomain.findMany({ orderBy: { hostname: 'asc' }, include });
      return { items: rows.map(toDomainDto) };
    },
  );

  app.post(
    '/allowed-domains',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['Allowed domains'],
        summary: 'Allow a domain',
        security: [{ cookieAuth: [] }],
        body: CreateAllowedDomainBodySchema,
        response: { 201: AllowedDomainSchema, ...errorResponses(400, 401, 403, 409) },
      },
    },
    async (request, reply) => {
      const actor = request.actor;
      try {
        const row = await app.db.allowedDomain.create({
          data: {
            id: newId('dom'),
            hostname: request.body.hostname,
            note: request.body.note ?? null,
            createdById: actor?.kind === 'user' ? actor.id : null,
          },
          include,
        });
        return await reply.code(201).send(toDomainDto(row));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(
            'conflict',
            `${request.body.hostname} is already on the allowed list.`,
          );
        }
        throw error;
      }
    },
  );

  app.patch(
    '/allowed-domains/:id',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['Allowed domains'],
        summary: 'Edit the note on an allowed domain',
        security: [{ cookieAuth: [] }],
        params: IdParamSchema,
        body: UpdateDomainBodySchema,
        response: { 200: AllowedDomainSchema, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) => {
      const existing = await app.db.allowedDomain.findUnique({ where: { id: request.params.id } });
      if (!existing) throw notFound('Allowed domain', request.params.id);
      const row = await app.db.allowedDomain.update({
        where: { id: existing.id },
        data: { note: request.body.note },
        include,
      });
      return toDomainDto(row);
    },
  );

  app.delete(
    '/allowed-domains/:id',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['Allowed domains'],
        summary: 'Remove an allowed domain',
        description: 'Existing scans are kept. New scans of the hostname will be refused.',
        security: [{ cookieAuth: [] }],
        params: IdParamSchema,
        response: { 204: z.null(), ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      const existing = await app.db.allowedDomain.findUnique({ where: { id: request.params.id } });
      if (!existing) throw notFound('Allowed domain', request.params.id);
      await app.db.allowedDomain.delete({ where: { id: existing.id } });
      return reply.code(204).send(null);
    },
  );
};
