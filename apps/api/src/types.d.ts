import type { Db } from '@qa-hub/db';
import type { Redis } from 'ioredis';
import type { ApiConfig } from './config.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiConfig;
    db: Db;
    redis: Redis;
  }
}
