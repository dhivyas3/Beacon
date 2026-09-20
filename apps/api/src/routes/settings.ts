import { SettingsSchema, UpdateSettingsBodySchema } from '@qa-hub/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
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
