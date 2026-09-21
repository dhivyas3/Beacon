import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDatabase, startEmbeddedPostgres, startRedis } from '@beacon/testkit';
import { startExternalSite, startFixtureSite } from '@beacon/fixtures';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const TMP = join(ROOT, 'e2e', '.tmp');

/** Ports are fixed, and different from the development stack, so both can run at once. */
export const PORTS = {
  postgres: 55_432,
  redis: 56_379,
  api: 4300,
  web: 4301,
  fixture: 4310,
  external: 4311,
  receiver: 4320,
} as const;

export const WEB_URL = `http://127.0.0.1:${PORTS.web}`;
export const FIXTURE_URL = `http://127.0.0.1:${PORTS.fixture}/`;
export const RECEIVER_URL = `http://127.0.0.1:${PORTS.receiver}`;
export const OUTBOX_DIR = join(TMP, 'outbox');

export const ADMIN = { email: 'admin@example.com', password: 'e2e-password-123456' };
export const WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789';

async function waitFor(url: string, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs / 1000}s (${last}).`);
}

function stop(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

export interface Stack {
  stop(): Promise<void>;
}

/**
 * Starts the whole system on its own ports: Postgres, Redis, the fixture site, the API, the
 * worker and the web app. Only the fixture site is ever scanned. Output goes to `e2e/.tmp/logs`.
 */
export async function startStack(): Promise<Stack> {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, 'logs'), { recursive: true });
  mkdirSync(OUTBOX_DIR, { recursive: true });

  const postgres = await startEmbeddedPostgres({ port: PORTS.postgres });
  const databaseUrl = await ensureDatabase(postgres.adminUrl, 'beacon_e2e');
  const redis = await startRedis({ port: PORTS.redis });
  const external = await startExternalSite({ port: PORTS.external });
  const fixture = await startFixtureSite({ port: PORTS.fixture, externalUrl: external.url });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'production',
    LOG_LEVEL: 'warn',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redis.url,
    QUEUE_PREFIX: 'beacon-e2e',
    STORAGE_DIR: join(TMP, 'storage'),
    PUBLIC_URL: WEB_URL,
    PORT: String(PORTS.api),
    HOST: '127.0.0.1',
    WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
    // The only reason this is on: the fixture site and the callback receiver are on loopback.
    ALLOW_LOCAL_TARGETS: 'true',
    EMAIL_PROVIDER: 'log',
    EMAIL_OUTBOX_DIR: OUTBOX_DIR,
    EXTERNAL_HOST_DELAY_MS: '0',
    RATE_LIMIT_PER_MINUTE: '5000',
    SEED_ADMIN_EMAIL: ADMIN.email,
    SEED_ADMIN_PASSWORD: ADMIN.password,
    SEED_ADMIN_NAME: 'Admin',
    VITE_API_TARGET: `http://127.0.0.1:${PORTS.api}`,
  };

  for (const script of ['migrate', 'seed']) {
    const result = spawnSync('pnpm', ['--filter', '@beacon/db', script], {
      cwd: ROOT,
      env,
      shell: true,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `pnpm --filter @beacon/db ${script} failed:\n${result.stdout}\n${result.stderr}`,
      );
    }
  }

  const children: ChildProcess[] = [];
  const run = (name: string, cwd: string, args: string[]): void => {
    const log = openSync(join(TMP, 'logs', `${name}.log`), 'a');
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    children.push(child);
  };

  run('api', join(ROOT, 'apps', 'api'), ['--import', 'tsx', 'src/main.ts']);
  run('worker', join(ROOT, 'apps', 'worker'), ['--import', 'tsx', 'src/main.ts']);
  run('web', join(ROOT, 'apps', 'web'), [
    join(ROOT, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js'),
    '--port',
    String(PORTS.web),
    '--strictPort',
    '--host',
    '127.0.0.1',
  ]);

  try {
    await waitFor(`http://127.0.0.1:${PORTS.api}/api/v1/health`, 'the API');
    await waitFor(`${WEB_URL}/`, 'the web app');
    await waitFor(`${WEB_URL}/api/v1/health`, 'the web proxy to the API');
  } catch (error) {
    children.forEach(stop);
    throw error;
  }

  return {
    async stop() {
      children.forEach(stop);
      await fixture.close();
      await external.close();
      await redis.stop();
      await postgres.stop();
    },
  };
}
