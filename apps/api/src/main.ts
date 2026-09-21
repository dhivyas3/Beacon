import { createDb } from '@beacon/db';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb();
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });

  const app = await buildServer({ config, db, redis });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.$disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
