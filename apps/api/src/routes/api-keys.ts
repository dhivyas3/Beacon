import {
  API_KEY_PREFIX,
  ApiKeySchema,
  CreateApiKeyBodySchema,
  CreatedApiKeySchema,
  IdParamSchema,
  newId,
  SCOPES,
  type ApiKey,
  type Scope,
} from '@qa-hub/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomToken, sha256 } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { errorResponses } from '../lib/openapi.js';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdBy: { name: string } | null;
}

function toApiKeyDto(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes.filter((scope): scope is Scope =>
      (SCOPES as readonly string[]).includes(scope),
    ),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdByName: row.createdBy?.name ?? null,
  };
}

const UpdateApiKeyBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    scopes: z.array(z.enum(SCOPES)).min(1).optional(),
  })
  .meta({ id: 'UpdateApiKeyBody' });

const include = { createdBy: { select: { name: true } } } as const;

export const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/api-keys',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['API keys'],
        summary: 'List API keys',
        description: 'Admin only. Raw keys are never returned after creation.',
        security: [{ cookieAuth: [] }],
        response: { 200: z.object({ items: z.array(ApiKeySchema) }), ...errorResponses(401, 403) },
      },
    },
    async () => {
      const rows = await app.db.apiKey.findMany({ orderBy: { createdAt: 'desc' }, include });
      return { items: rows.map(toApiKeyDto) };
    },
  );

  app.post(
    '/api-keys',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['API keys'],
        summary: 'Create an API key',
        description:
          'Admin only. The raw key is in the response **once**. Only its hash is stored, so a lost key cannot be recovered. Create a new one instead.',
        security: [{ cookieAuth: [] }],
        body: CreateApiKeyBodySchema,
        response: { 201: CreatedApiKeySchema, ...errorResponses(400, 401, 403) },
      },
    },
    async (request, reply) => {
      const actor = request.actor;
      const raw = `${API_KEY_PREFIX}${randomToken(32)}`;
      const row = await app.db.apiKey.create({
        data: {
          id: newId('key'),
          name: request.body.name,
          prefix: raw.slice(0, 12),
          keyHash: sha256(raw),
          scopes: request.body.scopes,
          createdById: actor?.kind === 'user' ? actor.id : null,
        },
        include,
      });
      return reply.code(201).send({ ...toApiKeyDto(row), key: raw });
    },
  );

  app.patch(
    '/api-keys/:id',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['API keys'],
        summary: 'Rename an API key or change its scopes',
        security: [{ cookieAuth: [] }],
        params: IdParamSchema,
        body: UpdateApiKeyBodySchema,
        response: { 200: ApiKeySchema, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) => {
      const existing = await app.db.apiKey.findUnique({ where: { id: request.params.id } });
      if (!existing) throw notFound('API key', request.params.id);
      const row = await app.db.apiKey.update({
        where: { id: existing.id },
        data: {
          ...(request.body.name === undefined ? {} : { name: request.body.name }),
          ...(request.body.scopes === undefined ? {} : { scopes: request.body.scopes }),
        },
        include,
      });
      return toApiKeyDto(row);
    },
  );

  app.delete(
    '/api-keys/:id',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['API keys'],
        summary: 'Revoke an API key',
        description:
          'Admin only. Revoked keys stop working immediately and stay listed so past scans still show who started them.',
        security: [{ cookieAuth: [] }],
        params: IdParamSchema,
        response: { 204: z.null(), ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      const existing = await app.db.apiKey.findUnique({ where: { id: request.params.id } });
      if (!existing) throw notFound('API key', request.params.id);
      if (existing.revokedAt === null) {
        await app.db.apiKey.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
      }
      return reply.code(204).send(null);
    },
  );
};
