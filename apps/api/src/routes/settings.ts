import { SettingsSchema, UpdateSettingsBodySchema } from '@qa-hub/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../lib/openapi.js';
import { loadSettings, updateSettings } from '../services/settings.js';

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/settings',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Settings'],
        summary: 'Get scan defaults',
        description:
          'Effective defaults used when a scan request omits `checks` or `formMode`. The signing secret is masked.',
        response: { 200: SettingsSchema, ...errorResponses(401, 403, 429) },
      },
    },
    async () => loadSettings(app.db, app.config),
  );

  app.get(
    '/settings/webhook-secret',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['Settings'],
        summary: 'Reveal the webhook signing secret',
        description:
          'Admin only. Returns the secret used to sign callbacks (`X-QAHub-Signature`) so it can be copied into the receiving workflow. The secret is set with `WEBHOOK_SIGNING_SECRET` in the environment.',
        security: [{ cookieAuth: [] }],
        response: { 200: z.object({ secret: z.string() }), ...errorResponses(401, 403) },
      },
    },
    async (_request, reply) => {
      void reply.header('cache-control', 'no-store');
      return { secret: app.config.WEBHOOK_SIGNING_SECRET };
    },
  );

  app.patch(
    '/settings',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['Settings'],
        summary: 'Update scan defaults',
        security: [{ cookieAuth: [] }],
        body: UpdateSettingsBodySchema,
        response: { 200: SettingsSchema, ...errorResponses(400, 401, 403) },
      },
    },
    async (request) => updateSettings(app.db, app.config, request.body),
  );
};
