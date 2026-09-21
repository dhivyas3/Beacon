import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db } from '@beacon/db';
import { LocalStorage } from '@beacon/storage';
import type { HostResolver } from '@beacon/net';
import { API_KEY_PREFIX, newId, type Scope } from '@beacon/shared';
import {
  createIsolatedDatabase,
  testRedisUrl,
  uniquePrefix,
  type TestDatabase,
} from '@beacon/testkit';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { ApiEnvSchema, type ApiConfig } from '../config.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { hashPassword } from '../lib/passwords.js';
import { BullScanQueue } from '../queue.js';
import { buildServer } from '../server.js';

/** Public address every unknown hostname resolves to, so tests never touch real DNS. */
export const PUBLIC_IP = '93.184.216.34';

/** Hostnames containing "private" resolve to an RFC 1918 address. */
export const fakeResolver: HostResolver = async (hostname) =>
  hostname.includes('private') ? ['10.0.0.7'] : [PUBLIC_IP];

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: ApiConfig;
  redisUrl: string;
  queuePrefix: string;
  storage: LocalStorage;
  close(): Promise<void>;
  createUser(input?: {
    email?: string;
    password?: string;
    role?: 'admin' | 'member';
    name?: string;
  }): Promise<{ id: string; email: string; password: string }>;
  /** Signs in through the real endpoint and returns the Cookie header value. */
  login(email: string, password: string): Promise<string>;
  /** Creates an admin and returns its session cookie. */
  adminCookie(): Promise<string>;
  createApiKey(scopes?: Scope[], name?: string): Promise<{ id: string; key: string }>;
  allowDomain(hostname: string): Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const database: TestDatabase = await createIsolatedDatabase();
  const queuePrefix = uniquePrefix('api');
  const redisUrl = testRedisUrl();
  const storageDir = await mkdtemp(join(tmpdir(), 'beacon-api-'));
  const storage = new LocalStorage(storageDir);
  const config = ApiEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: database.url,
    REDIS_URL: redisUrl,
    QUEUE_PREFIX: queuePrefix,
    STORAGE_DIR: storageDir,
    WEBHOOK_SIGNING_SECRET: 'test-signing-secret-0123456789',
    PUBLIC_URL: 'http://qa.test',
    ...overrides,
  });
  const db = createDb({ url: database.url, log: false });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const queue = new BullScanQueue(redisUrl, queuePrefix);
  const app = await buildServer({ config, db, redis, queue, resolver: fakeResolver, storage });
  await app.ready();

  let userCounter = 0;

  const ctx: TestApp = {
    app,
    db,
    config,
    redisUrl,
    queuePrefix,
    storage,
    async close() {
      await app.close();
      await queue.close();
      redis.disconnect();
      await db.$disconnect();
      await database.drop();
      await rm(storageDir, { recursive: true, force: true });
    },
    async createUser(input = {}) {
      userCounter += 1;
      const email = input.email ?? `user${userCounter}@example.com`;
      const password = input.password ?? 'correct-horse-battery';
      const user = await db.user.create({
        data: {
          id: newId('usr'),
          email,
          name: input.name ?? `User ${userCounter}`,
          role: input.role ?? 'member',
          passwordHash: await hashPassword(password),
        },
      });
      return { id: user.id, email, password };
    },
    async login(email, password) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password },
      });
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
      return cookieHeader(res);
    },
    async adminCookie() {
      const admin = await ctx.createUser({ role: 'admin', name: 'Admin' });
      return ctx.login(admin.email, admin.password);
    },
    async createApiKey(scopes = ['scans:read', 'scans:write'], name = 'test key') {
      const raw = `${API_KEY_PREFIX}${randomToken(32)}`;
      const row = await db.apiKey.create({
        data: {
          id: newId('key'),
          name,
          prefix: raw.slice(0, 12),
          keyHash: sha256(raw),
          scopes,
        },
      });
      return { id: row.id, key: raw };
    },
    async allowDomain(hostname) {
      await db.allowedDomain.upsert({
        where: { hostname },
        create: { id: newId('dom'), hostname },
        update: {},
      });
    },
  };
  return ctx;
}

export function cookieHeader(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((entry) => entry.name === 'beacon_session');
  if (!cookie) throw new Error('no session cookie in response');
  return `beacon_session=${cookie.value}`;
}

export function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

export function errorOf(res: LightMyRequestResponse): {
  code: string;
  message: string;
  details?: unknown;
} {
  return res.json<{ error: { code: string; message: string; details?: unknown } }>().error;
}

/** Inserts a scan row directly, for tests that need scans in a specific state. */
export async function insertScan(
  db: Db,
  input: {
    hostname: string;
    status?: 'queued' | 'discovering' | 'running' | 'completed' | 'failed' | 'cancelled';
    runNumber?: number;
    createdAt?: Date;
    healthScore?: number | null;
    pagesTotal?: number;
    websiteId?: string | null;
    previousScanId?: string | null;
    finishedAt?: Date;
    triggeredByType?: 'manual_ui' | 'manual_api' | 'scheduled' | 'n8n' | 'monday';
    pageSelectionMode?: 'full' | 'static_list' | 'random_sample';
    criticalCount?: number;
    warningCount?: number;
  },
): Promise<string> {
  const id = newId('scn');
  const status = input.status ?? 'completed';
  await db.scan.create({
    data: {
      id,
      url: `https://${input.hostname}/`,
      hostname: input.hostname,
      runNumber: input.runNumber ?? 1,
      status,
      checks: ['images', 'links'],
      pagesTotal: input.pagesTotal ?? 0,
      healthScore: input.healthScore ?? null,
      criticalCount: input.criticalCount ?? 0,
      warningCount: input.warningCount ?? 0,
      websiteId: input.websiteId ?? null,
      previousScanId: input.previousScanId ?? null,
      triggeredByType: input.triggeredByType ?? 'manual_api',
      pageSelectionMode: input.pageSelectionMode ?? 'full',
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      startedAt: status === 'queued' ? null : new Date(),
      finishedAt:
        status === 'completed' || status === 'failed' ? (input.finishedAt ?? new Date()) : null,
    },
  });
  return id;
}

export async function insertPage(
  db: Db,
  scanId: string,
  url: string,
  extra: { criticalCount?: number; warningCount?: number } = {},
): Promise<string> {
  const id = newId('pg');
  await db.scanPage.create({
    data: { id, scanId, url, status: 'done', httpStatus: 200, durationMs: 800, ...extra },
  });
  return id;
}

export async function insertIssue(
  db: Db,
  input: {
    scanId: string;
    pageId?: string | null;
    fingerprint: string;
    severity?: 'critical' | 'warning' | 'info';
    checkType?: string;
    message?: string;
    createdAt?: Date;
  },
): Promise<string> {
  const id = newId('iss');
  await db.scanIssue.create({
    data: {
      id,
      scanId: input.scanId,
      pageId: input.pageId ?? null,
      checkType: input.checkType ?? 'images',
      severity: input.severity ?? 'critical',
      fingerprint: input.fingerprint,
      message: input.message ?? `Issue ${input.fingerprint}`,
      evidence: { status: 404 },
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
  return id;
}
