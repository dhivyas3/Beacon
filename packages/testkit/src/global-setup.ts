import { prepareTemplateDatabase, startEmbeddedPostgres } from './postgres.js';
import { startRedis } from './redis.js';

export const ENV_PG_ADMIN_URL = 'QA_TEST_PG_ADMIN_URL';
export const ENV_REDIS_URL = 'QA_TEST_REDIS_URL';

/**
 * Vitest global setup. Provides a PostgreSQL server and a Redis server for the whole run.
 *
 * If DATABASE_URL / REDIS_URL are set (CI service containers), those servers are used and only a
 * template database is created on them. Otherwise an embedded Postgres and a local redis-server
 * are started on random ports and stopped afterwards.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const stops: (() => Promise<void>)[] = [];

  let pgAdminUrl = process.env.DATABASE_URL;
  if (!pgAdminUrl) {
    const server = await startEmbeddedPostgres();
    stops.push(() => server.stop());
    pgAdminUrl = server.adminUrl;
  }
  await prepareTemplateDatabase(pgAdminUrl);
  process.env[ENV_PG_ADMIN_URL] = pgAdminUrl;

  let redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    const server = await startRedis();
    stops.push(() => server.stop());
    redisUrl = server.url;
  }
  process.env[ENV_REDIS_URL] = redisUrl;

  return async () => {
    for (const stop of stops.reverse()) await stop();
  };
}
