import { join } from 'node:path';
import { REPO_ROOT } from './paths.js';
import { ensureDatabase, startEmbeddedPostgres } from './postgres.js';
import { startRedis } from './redis.js';

/**
 * `pnpm dev:services`: a persistent PostgreSQL 16 on :5432 and Redis on :6379 without Docker.
 * Data lives in ./data/postgres. Run `pnpm db:migrate` once against it.
 */
async function main(): Promise<void> {
  const pgPort = Number(process.env.PG_PORT ?? 5432);
  const redisPort = Number(process.env.REDIS_PORT ?? 6379);

  const postgres = await startEmbeddedPostgres({
    port: pgPort,
    dataDir: join(REPO_ROOT, 'data', 'postgres'),
  });
  const url = await ensureDatabase(postgres.adminUrl, 'beacon');
  const redis = await startRedis({ port: redisPort });

  console.log('\nServices are running. Press Ctrl+C to stop.\n');
  console.log(`  DATABASE_URL=${url}`);
  console.log(`  REDIS_URL=${redis.url}\n`);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping services...');
    await redis.stop();
    await postgres.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise<never>(() => undefined);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
