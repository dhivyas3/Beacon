import { z } from 'zod';
import { SCOPES } from '../constants.js';

export const ApiKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string().describe('First characters of the key, safe to display.'),
    scopes: z.array(z.enum(SCOPES)),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    createdByName: z.string().nullable(),
  })
  .meta({ id: 'ApiKey' });
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const CreateApiKeyBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(SCOPES)).min(1).default(['scans:read', 'scans:write']),
  })
  .meta({
    id: 'CreateApiKeyBody',
    example: { name: 'n8n production', scopes: ['scans:read', 'scans:write'] },
  });
export type CreateApiKeyBody = z.infer<typeof CreateApiKeyBodySchema>;

export const CreatedApiKeySchema = ApiKeySchema.extend({
  key: z.string().describe('The raw key. Returned exactly once, on creation.'),
}).meta({ id: 'CreatedApiKey' });
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

export const API_KEY_PREFIX = 'qah_';
