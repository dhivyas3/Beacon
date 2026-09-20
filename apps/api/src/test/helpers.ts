import { createDb, type Db } from '@qa-hub/db';
import { createIsolatedDatabase, testRedisUrl, type TestDatabase } from '@qa-hub/testkit';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { ApiEnvSchema, type ApiConfig } from '../config.js';
import { buildServer } from '../server.js';

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: ApiConfig;
  close(): Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const database: TestDatabase = await createIsolatedDatabase();
  const config = ApiEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: database.url,
    REDIS_URL: testRedisUrl(),
    WEBHOOK_SIGNING_SECRET: 'test-signing-secret-0123456789',
    PUBLIC_URL: 'http://qa.test',
    ...overrides,
  });
  const db = createDb({ url: database.url, log: false });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
  const app = await buildServer({ config, db, redis });
  await app.ready();

  return {
    app,
    db,
    config,
    async close() {
      await app.close();
      redis.disconnect();
      await db.$disconnect();
      await database.drop();
    },
  };
}
