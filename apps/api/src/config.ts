import { CommonEnvSchema, parseEnv } from '@qa-hub/shared';
import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const ApiEnvSchema = CommonEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Set to true when the app is served over HTTPS so session cookies are Secure. */
  COOKIE_SECURE: booleanFromString.default(false),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24 * 7),
  /** Requests per minute allowed for one API key or session. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
});
export type ApiConfig = z.infer<typeof ApiEnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(ApiEnvSchema, env);
}
