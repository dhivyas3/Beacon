import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startExternalSite, startFixtureSite, type FixtureSite } from '@qa-hub/fixtures';
import { createDb, type Db } from '@qa-hub/db';
import { createSafeClient, type HostResolver, type SafeClient } from '@qa-hub/net';
import { CHECK_TYPES, newId, USER_AGENT, type CheckType, type FormMode } from '@qa-hub/shared';
import { LocalStorage } from '@qa-hub/storage';
import { createIsolatedDatabase, uniquePrefix, type TestDatabase } from '@qa-hub/testkit';
import { pino } from 'pino';
import { WorkerEnvSchema, type WorkerConfig } from '../config.js';
import type { Check, CheckContext, IssueDraft, ScanInfo } from '../checks/types.js';
import { UrlChecker, ResourceProbe } from '../http/url-checker.js';
import { BrowserSession, type LoadedPage } from '../scan/browser.js';
import type { Logger } from '../logger.js';
import { HostThrottle, RateLimiter } from '../util/rate-limit.js';

/** Hostnames the tests may reach. Everything else fails to resolve, so no test touches the internet. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export const offlineResolver: HostResolver = (hostname) => {
  if (LOCAL_HOSTS.has(hostname)) return Promise.resolve(['127.0.0.1']);
  return Promise.reject(
    Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }),
  );
};

/** Keeps Chromium off the real network too: only localhost resolves. */
export const OFFLINE_BROWSER_ARGS = [
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1',
];

export const silentLog: Logger = pino({ level: 'silent' });

export interface Sites {
  site: FixtureSite;
  external: FixtureSite;
  close(): Promise<void>;
}

export async function startSites(): Promise<Sites> {
  const external = await startExternalSite();
  const site = await startFixtureSite({ externalUrl: external.url });
  return {
    site,
    external,
    close: async () => {
      await site.close();
      await external.close();
    },
  };
}

export interface TestWorld {
  db: Db;
  config: WorkerConfig;
  storage: LocalStorage;
  storageDir: string;
  sites: Sites;
  close(): Promise<void>;
}

/** Everything a scan needs: isolated database, fixture sites, storage folder, test config. */
export async function createWorld(env: Record<string, string> = {}): Promise<TestWorld> {
  const database: TestDatabase = await createIsolatedDatabase();
  const storageDir = await mkdtemp(join(tmpdir(), 'qa-hub-worker-'));
  const sites = await startSites();
  const db = createDb({ url: database.url, log: false });
  const config = WorkerEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: database.url,
    REDIS_URL: process.env.QA_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379',
    QUEUE_PREFIX: uniquePrefix('worker'),
    WEBHOOK_SIGNING_SECRET: 'test-signing-secret-0123456789',
    STORAGE_DIR: storageDir,
    ALLOW_LOCAL_TARGETS: 'true',
    SCAN_RATE_LIMIT_RPS: '100',
    EXTERNAL_HOST_DELAY_MS: '0',
    // `localhost` is a default pattern, but the fixture's "external" site lives there.
    STAGING_PATTERNS: 'staging.,dev.,.netlify.app,.vercel.app',
    ...env,
  });
  await db.allowedDomain.create({ data: { id: newId('dom'), hostname: '127.0.0.1' } });

  return {
    db,
    config,
    storage: new LocalStorage(storageDir),
    storageDir,
    sites,
    async close() {
      await sites.close();
      await db.$disconnect();
      await database.drop();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

let scanCounter = 0;

/** Inserts a queued scan of `url`, as the API would. */
export async function insertQueuedScan(
  db: Db,
  url: string,
  options: {
    checks?: CheckType[];
    pageConcurrency?: number;
    linkConcurrency?: number;
    formMode?: FormMode;
    /** Overrides the hostname derived from the url, to avoid the one-active-scan-per-host rule. */
    hostname?: string;
  } = {},
): Promise<string> {
  scanCounter += 1;
  const id = newId('scn');
  await db.scan.create({
    data: {
      id,
      url,
      hostname: options.hostname ?? new URL(url).hostname,
      runNumber: scanCounter,
      status: 'queued',
      checks: options.checks ?? ['images', 'links', 'staging-urls', 'page-health'],
      pageConcurrency: options.pageConcurrency ?? 3,
      linkConcurrency: options.linkConcurrency ?? 5,
      formMode: options.formMode ?? 'detect',
    },
  });
  return id;
}

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  { timeoutMs = 60_000, intervalMs = 50, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A URL checker wired like a real scan, for tests of link verification. */
export function createChecker(
  options: { backoffBaseMs?: number; maxRetries?: number; signal?: AbortSignal } = {},
): { checker: UrlChecker; probe: ResourceProbe; client: SafeClient } {
  const client = createSafeClient({
    allowLocal: true,
    resolver: offlineResolver,
    userAgent: USER_AGENT,
  });
  const checker = new UrlChecker({
    client,
    limiter: new RateLimiter(200),
    hostThrottle: new HostThrottle(0),
    signal: options.signal ?? new AbortController().signal,
    backoff: { maxRetries: options.maxRetries ?? 3, baseMs: options.backoffBaseMs ?? 5, maxMs: 50 },
    timeoutMs: 5000,
  });
  return { checker, probe: new ResourceProbe(checker), client };
}

// ---- Running one check against a fixture page in a real browser ------------------------------

export interface CheckRunner {
  sites: Sites;
  /** Loads a fixture page in Chromium and runs one check on it, the way the scan runner does. */
  run(
    check: Check,
    path: string,
    options?: {
      formMode?: FormMode;
      /** Reuse to share per-scan state (form de-duplication) between runs. */
      scan?: ScanInfo;
      status?: number;
    },
  ): Promise<{ drafts: IssueDraft[]; loaded: LoadedPage }>;
  scanInfo(formMode?: FormMode): ScanInfo;
  close(): Promise<void>;
}

export async function createCheckRunner(): Promise<CheckRunner> {
  const sites = await startSites();
  const browser = await BrowserSession.launch({
    allowLocal: true,
    resolver: offlineResolver,
    args: OFFLINE_BROWSER_ARGS,
  });
  const checker = createChecker();
  const signal = new AbortController().signal;

  const scanInfo = (formMode: FormMode = 'detect'): ScanInfo => ({
    id: 'scn_test',
    rootUrl: `${sites.site.url}/`,
    origin: sites.site.url,
    hostname: '127.0.0.1',
    checks: [...CHECK_TYPES],
    formMode,
  });

  return {
    sites,
    scanInfo,
    async run(check, path, options = {}) {
      const url = path.startsWith('http') ? path : `${sites.site.url}${path}`;
      const loaded = await browser.load(url, signal);
      const context: CheckContext = {
        scan: options.scan ?? scanInfo(options.formMode),
        settings: {
          stagingPatterns: ['staging.', 'dev.', '.netlify.app', '.vercel.app'],
          formTestEmail: 'qa-test@example.com',
        },
        page: { id: 'pg_test', url: url },
        observation: loaded.observation,
        dom: loaded.dom,
        browserPage: loaded.page,
        probe: (target) =>
          checker.probe.check(target, { external: new URL(target).origin !== sites.site.url }),
        links: { register: () => Promise.resolve() },
        isInternal: (target) => new URL(target).origin === sites.site.url,
        signal,
        log: silentLog,
      };
      const drafts = await check.run(context);
      return { drafts, loaded };
    },
    async close() {
      await browser.close();
      await checker.client.close();
      await sites.close();
    },
  };
}
