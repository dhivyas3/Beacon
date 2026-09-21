import { z } from 'zod';
import { EXAMPLE_API_KEY } from './examples.js';
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
  .meta({ id: 'ApiKey', example: EXAMPLE_API_KEY });
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
}).meta({
  id: 'CreatedApiKey',
  example: { ...EXAMPLE_API_KEY, key: 'bcn_7Hk2mP9xRt4Vb8Nc1Zq6Ld3Sf5Wj0YaGe2UoIiKpXhM' },
});
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

export const API_KEY_PREFIX = 'bcn_';
/** Keys created before the product was renamed. They are still accepted. */
export const LEGACY_API_KEY_PREFIXES = ['qah_'] as const;
