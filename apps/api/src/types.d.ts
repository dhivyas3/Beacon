import type { Db } from '@beacon/db';
import type { Role, Scope } from '@beacon/shared';
import type { Redis } from 'ioredis';
import type { ApiConfig } from './config.js';
import type { ScanQueue } from './queue.js';

/** Who is making a request. Resolved from a Bearer API key or the session cookie. */
export type Actor =
  | { kind: 'user'; id: string; name: string; role: Role; scopes: Scope[]; sessionId: string }
  | { kind: 'api_key'; id: string; name: string; scopes: Scope[] };

/**
 * What a route requires. A scope name means "session or API key holding that scope".
 * `admin` means a signed-in admin, `session` means any signed-in user, `false` means public.
 */
export type AuthRequirement = Scope | 'admin' | 'session' | false;

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiConfig;
    db: Db;
    redis: Redis;
    scanQueue: ScanQueue;
  }
  interface FastifyRequest {
    actor: Actor | null;
  }
  interface FastifyContextConfig {
    auth?: AuthRequirement;
  }
}
