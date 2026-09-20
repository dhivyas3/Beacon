import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root (two levels above packages/testkit/src). */
export const REPO_ROOT = resolve(here, '..', '..', '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'db', 'prisma', 'migrations');

/**
 * Finds a redis-server binary: REDIS_SERVER_BIN, then a copy under `.tools/redis`, then PATH.
 * Returns the bare command name when it must be resolved from PATH.
 */
export function findRedisServer(): string {
  const fromEnv = process.env.REDIS_SERVER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const exe = process.platform === 'win32' ? 'redis-server.exe' : 'redis-server';
  const toolsDir = join(REPO_ROOT, '.tools', 'redis');
  if (existsSync(toolsDir)) {
    const direct = join(toolsDir, exe);
    if (existsSync(direct)) return direct;
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      const nested = join(toolsDir, entry.name, exe);
      if (entry.isDirectory() && existsSync(nested)) return nested;
    }
  }
  return 'redis-server';
}
