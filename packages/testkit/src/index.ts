import { createTestDatabase, dropTestDatabase } from './postgres.js';
import { ENV_PG_ADMIN_URL, ENV_REDIS_URL } from './global-setup.js';

export { startEmbeddedPostgres, ensureDatabase } from './postgres.js';
export type { PgServer } from './postgres.js';
export { startRedis } from './redis.js';
export type { RedisServer } from './redis.js';
export { freePort } from './ports.js';
export { REPO_ROOT, findRedisServer } from './paths.js';
export { ENV_PG_ADMIN_URL, ENV_REDIS_URL };

export function testRedisUrl(): string {
  const url = process.env[ENV_REDIS_URL];
  if (!url) {
    throw new Error(
      'No Redis test server. Add "@qa-hub/testkit/global-setup" to vitest globalSetup.',
    );
  }
  return url;
}

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

/** Creates an isolated migrated database for one test file. */
export async function createIsolatedDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env[ENV_PG_ADMIN_URL];
  if (!adminUrl) {
    throw new Error(
      'No Postgres test server. Add "@qa-hub/testkit/global-setup" to vitest globalSetup.',
    );
  }
  const url = await createTestDatabase(adminUrl);
  return { url, drop: () => dropTestDatabase(adminUrl, url) };
}

/** A key prefix that keeps BullMQ queues from different test files apart. */
export function uniquePrefix(label = 'test'): string {
  return `qahub:${label}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
