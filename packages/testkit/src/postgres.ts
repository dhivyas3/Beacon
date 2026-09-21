import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { MIGRATIONS_DIR } from './paths.js';
import { freePort } from './ports.js';

export interface PgServer {
  /** Connection string for the maintenance database (used to create and drop databases). */
  adminUrl: string;
  stop(): Promise<void>;
}

export interface StartPostgresOptions {
  port?: number;
  /** Keep data between runs. When set, `dataDir` is required. */
  dataDir?: string;
  quiet?: boolean;
}

const USER = 'postgres';
const PASSWORD = 'postgres';

/** Starts a real PostgreSQL 16 server without Docker. */
export async function startEmbeddedPostgres(options: StartPostgresOptions = {}): Promise<PgServer> {
  const port = options.port ?? (await freePort());
  const persistent = options.dataDir !== undefined;
  const databaseDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'beacon-pg-'));

  const server = new EmbeddedPostgres({
    databaseDir,
    user: USER,
    password: PASSWORD,
    port,
    persistent,
    onLog: options.quiet === false ? (message) => console.log(String(message)) : () => undefined,
    onError: (message) => console.error(String(message)),
  });

  if (!existsSync(join(databaseDir, 'PG_VERSION'))) {
    await server.initialise();
  }
  await server.start();

  return {
    adminUrl: `postgresql://${USER}:${PASSWORD}@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      if (!persistent) rmSync(databaseDir, { recursive: true, force: true });
    },
  };
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const TEMPLATE_DB = 'qa_hub_template';

/** Applies every Prisma migration file, in order, to a fresh database. */
async function applyMigrations(url: string): Promise<void> {
  const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  await withClient(url, async (client) => {
    for (const folder of folders) {
      const sql = readFileSync(join(MIGRATIONS_DIR, folder, 'migration.sql'), 'utf8');
      await client.query(sql);
    }
  });
}

/** Builds a template database containing the current schema. Call once per test run. */
export async function prepareTemplateDatabase(adminUrl: string): Promise<void> {
  await withClient(adminUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB}`);
    await client.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  });
  await applyMigrations(withDatabase(adminUrl, TEMPLATE_DB));
}

/** Creates an isolated, fully migrated database and returns its connection string. */
export async function createTestDatabase(adminUrl: string): Promise<string> {
  const name = `qa_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await withClient(adminUrl, (client) =>
    client.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`),
  );
  return withDatabase(adminUrl, name);
}

export async function dropTestDatabase(adminUrl: string, url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!name.startsWith('qa_test_')) throw new Error(`Refusing to drop database ${name}.`);
  await withClient(adminUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
}

/** Creates a plain empty database (used by `pnpm dev:services`). */
export async function ensureDatabase(adminUrl: string, name: string): Promise<string> {
  await withClient(adminUrl, async (client) => {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${name}`);
  });
  return withDatabase(adminUrl, name);
}
