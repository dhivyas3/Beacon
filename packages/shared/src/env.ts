import { z } from 'zod';
import { CHECK_TYPES, DEFAULT_STAGING_PATTERNS } from './constants.js';

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

function csvOf(defaultValue: string) {
  return z
    .string()
    .default(defaultValue)
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
}

/** Environment shared by the API and the worker. Documented in `.env.example`. */
export const CommonEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** Public base URL of the web app. Used to build reportUrl and statusUrl. */
  PUBLIC_URL: z.url().default('http://localhost:8080'),
  STORAGE_DIR: z.string().min(1).default('./data/storage'),
  /** Redis key prefix for BullMQ queues. Lets several environments share one Redis. */
  QUEUE_PREFIX: z.string().min(1).default('beacon'),
  /** HMAC secret for X-Beacon-Signature on callbacks. */
  WEBHOOK_SIGNING_SECRET: z
    .string()
    .min(16, 'WEBHOOK_SIGNING_SECRET must be at least 16 characters'),
  /** Test-only. Allows scanning loopback and private addresses (the local fixture site). */
  ALLOW_LOCAL_TARGETS: booleanFromString.default(false),

  MAX_PAGES: z.coerce.number().int().min(1).max(50_000).default(2000),
  PAGE_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
  LINK_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),
  EXTERNAL_LINK_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  EXTERNAL_HOST_DELAY_MS: z.coerce.number().int().min(0).default(500),
  MAX_CONCURRENT_SCANS: z.coerce.number().int().min(1).max(20).default(3),
  /** Requests per second a single scan may send to the target site. */
  SCAN_RATE_LIMIT_RPS: z.coerce.number().min(0.5).max(100).default(10),
  STAGING_PATTERNS: csvOf([...DEFAULT_STAGING_PATTERNS].join(',')),
  FORM_TEST_EMAIL: z.email().default('qa-test@example.com'),

  /**
   * How reports are emailed. `resend` and `smtp` send for real, `log` writes each email to
   * EMAIL_OUTBOX_DIR as an HTML file, which is what development uses. When unset it is `resend` if
   * RESEND_API_KEY is set, and `log` otherwise.
   */
  EMAIL_PROVIDER: z.enum(['resend', 'smtp', 'log']).optional(),
  /** The sender address. Must be on a domain the provider has verified. */
  EMAIL_FROM: z.email().default('reports@beacon.localhost'),
  EMAIL_FROM_NAME: z.string().min(1).max(80).default('Beacon'),
  RESEND_API_KEY: z.string().min(1).optional(),
  /** For `smtp`: smtp://user:password@host:587, or smtps:// for implicit TLS. */
  SMTP_URL: z.string().min(1).optional(),
  EMAIL_OUTBOX_DIR: z.string().min(1).default('./data/outbox'),
  DEFAULT_CHECKS: csvOf([...CHECK_TYPES].join(',')).pipe(z.array(z.enum(CHECK_TYPES)).min(1)),
});
export type CommonEnv = z.infer<typeof CommonEnvSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'EnvError';
  }
}

/** Parses an environment object and throws one readable error listing every problem. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined>,
): z.infer<T> {
  // A variable that is present but blank, as `EMAIL_PROVIDER=` in a .env file or an empty compose
  // substitution, means the same as one that is not set.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = schema.safeParse(present);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  return result.data;
}
