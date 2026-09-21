import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, type Prisma } from '@beacon/db';
import { computeNextCheckAt, newId } from '@beacon/shared';
import { createIsolatedDatabase, type TestDatabase } from '@beacon/testkit';
import { pino } from 'pino';
import { RETRY_AFTER_MS, runSchedulerTick, type SchedulerDeps } from './scheduler.js';

let database: TestDatabase;
let db: Db;
let ownerId: string;
let counter = 0;
const log = pino({ level: 'silent' });
const now = new Date('2026-09-21T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  database = await createIsolatedDatabase();
  db = createDb({ url: database.url, log: false });
  ownerId = newId('usr');
  await db.user.create({
    data: { id: ownerId, email: 'owner@example.com', passwordHash: 'x', name: 'Owner' },
  });
  await db.allowedDomain.create({ data: { id: newId('dom'), hostname: '*.example.com' } });
});

afterAll(async () => {
  await db.$disconnect();
  await database.drop();
});

interface Queued {
  ids: string[];
  deps: SchedulerDeps;
}

function makeDeps(enqueue?: (id: string) => Promise<void>): Queued {
  const ids: string[] = [];
  return {
    ids,
    deps: {
      db,
      log,
      config: { PAGE_CONCURRENCY: 4, LINK_CONCURRENCY: 8 },
      enqueue:
        enqueue ??
        ((id) => {
          ids.push(id);
          return Promise.resolve();
        }),
    },
  };
}

async function makeWebsite(
  overrides: Partial<Prisma.WebsiteUncheckedCreateInput> = {},
): Promise<{ id: string; hostname: string }> {
  counter += 1;
  const hostname = `site${counter}.example.com`;
  const website = await db.website.create({
    data: {
      id: newId('web'),
      name: `Site ${counter}`,
      url: `https://${hostname}/`,
      hostname,
      ownerId,
      checkFrequency: 'daily',
      scheduleHourUtc: 6,
      pageSelectionMode: 'random_sample',
      sampleSize: 7,
      pinnedPageUrls: [`https://${hostname}/contact`],
      enabledChecks: ['images', 'seo'],
      formMode: 'validate_only',
      nextCheckAt: new Date(now.getTime() - HOUR),
      ...overrides,
    },
  });
  return { id: website.id, hostname };
}

const scansOf = (websiteId: string) => db.scan.findMany({ where: { websiteId } });

describe('runSchedulerTick', () => {
  it('starts a due website with its own configuration and plans the next check', async () => {
    const { ids, deps } = makeDeps();
    const site = await makeWebsite({
      pageSelectionMode: 'static_list',
      staticPageUrls: ['https://x/', 'https://x/a'],
    });

    const result = await runSchedulerTick(deps, now);
    const started = result.started.find((entry) => entry.websiteId === site.id);
    expect(started).toBeDefined();
    expect(ids).toContain(started?.scanId);

    const [scan] = await scansOf(site.id);
    expect(scan).toMatchObject({
      status: 'queued',
      url: `https://${site.hostname}/`,
      hostname: site.hostname,
      checks: ['images', 'seo'],
      formMode: 'validate_only',
      triggeredByType: 'scheduled',
      triggeredByUserId: null,
      triggeredByApiKeyId: null,
      pageSelectionMode: 'static_list',
      staticPageUrls: ['https://x/', 'https://x/a'],
      pinnedPageUrls: [`https://${site.hostname}/contact`],
      sampleSize: 7,
      pageConcurrency: 4,
      linkConcurrency: 8,
      runNumber: 1,
    });

    const website = await db.website.findUniqueOrThrow({ where: { id: site.id } });
    expect(website.nextCheckAt?.toISOString()).toBe('2026-09-22T06:00:00.000Z');
  });

  it('leaves alone websites that are not due, paused, manual, or never planned', async () => {
    const { deps } = makeDeps();
    const notDue = await makeWebsite({ nextCheckAt: new Date(now.getTime() + HOUR) });
    const paused = await makeWebsite({ isActive: false });
    const manual = await makeWebsite({ checkFrequency: 'manual', nextCheckAt: null });
    const unplanned = await makeWebsite({ nextCheckAt: null });

    await runSchedulerTick(deps, now);
    for (const site of [notDue, paused, manual, unplanned]) {
      expect(await scansOf(site.id)).toHaveLength(0);
    }
    const stillDue = await db.website.findUniqueOrThrow({ where: { id: notDue.id } });
    expect(stillDue.nextCheckAt?.getTime()).toBe(now.getTime() + HOUR);
  });

  it('checks a website that was due for weeks once, with no backlog, then keeps its cadence', async () => {
    const { deps } = makeDeps();
    const site = await makeWebsite({
      checkFrequency: 'weekly',
      scheduleDayOfWeek: 1,
      nextCheckAt: new Date(now.getTime() - 5 * 7 * DAY),
    });

    await runSchedulerTick(deps, now);
    expect(await scansOf(site.id)).toHaveLength(1);
    const website = await db.website.findUniqueOrThrow({ where: { id: site.id } });
    expect(website.nextCheckAt?.getTime()).toBeGreaterThan(now.getTime());
    expect(website.nextCheckAt).toEqual(computeNextCheckAt(website, now));

    // Ticking again straight away, and a minute later, starts nothing more.
    await runSchedulerTick(deps, now);
    await runSchedulerTick(deps, new Date(now.getTime() + 60_000));
    expect(await scansOf(site.id)).toHaveLength(1);
  });

  it('starts it exactly once when several workers tick at the same moment', async () => {
    const one = makeDeps();
    const two = makeDeps();
    const three = makeDeps();
    const site = await makeWebsite();
    await Promise.all([
      runSchedulerTick(one.deps, now),
      runSchedulerTick(two.deps, now),
      runSchedulerTick(three.deps, now),
    ]);
    expect(await scansOf(site.id)).toHaveLength(1);
    expect(one.ids.length + two.ids.length + three.ids.length).toBeGreaterThanOrEqual(1);
    const queued = [...one.ids, ...two.ids, ...three.ids];
    const scan = (await scansOf(site.id))[0];
    expect(queued.filter((id) => id === scan?.id)).toHaveLength(1);
  });

  it('tries again in half an hour when the previous check is still running, and says why', async () => {
    const { deps } = makeDeps();
    const site = await makeWebsite();
    // A scan made through the API bumps this counter, which is what numbers the next one.
    await db.hostnameCounter.create({ data: { hostname: site.hostname, last: 1 } });
    await db.scan.create({
      data: {
        id: newId('scn'),
        url: `https://${site.hostname}/`,
        hostname: site.hostname,
        runNumber: 1,
        status: 'running',
        checks: ['images'],
        websiteId: site.id,
      },
    });

    const result = await runSchedulerTick(deps, now);
    expect(result.skipped.find((entry) => entry.websiteId === site.id)?.reason).toContain(
      'still running',
    );
    expect(await scansOf(site.id)).toHaveLength(1);

    const website = await db.website.findUniqueOrThrow({ where: { id: site.id } });
    expect(website.nextCheckAt?.getTime()).toBe(now.getTime() + RETRY_AFTER_MS);
    expect(website.lastRunError).toContain('still running');

    // Once the earlier check is done, the retry goes ahead.
    await db.scan.updateMany({
      where: { websiteId: site.id },
      data: { status: 'completed', finishedAt: now },
    });
    const later = new Date(now.getTime() + RETRY_AFTER_MS + 1000);
    await runSchedulerTick(deps, later);
    expect(await scansOf(site.id)).toHaveLength(2);
    const scans = (await scansOf(site.id)).sort((a, b) => a.runNumber - b.runNumber);
    expect(scans[1]?.runNumber).toBe(2);
  });

  it('does not start a website whose domain was removed from the allowed list', async () => {
    const { deps } = makeDeps();
    counter += 1;
    const hostname = `blocked${counter}.other.test`;
    const website = await db.website.create({
      data: {
        id: newId('web'),
        name: 'Blocked',
        url: `https://${hostname}/`,
        hostname,
        ownerId,
        checkFrequency: 'daily',
        enabledChecks: ['images'],
        nextCheckAt: new Date(now.getTime() - HOUR),
      },
    });
    const result = await runSchedulerTick(deps, now);
    expect(result.skipped.find((entry) => entry.websiteId === website.id)?.reason).toContain(
      'no longer on the allowed domains list',
    );
    expect(await scansOf(website.id)).toHaveLength(0);
    const after = await db.website.findUniqueOrThrow({ where: { id: website.id } });
    expect(after.lastRunError).toContain('allowed domains');
    expect(after.nextCheckAt?.toISOString()).toBe('2026-09-22T06:00:00.000Z');
  });

  it('fails the scan and retries soon when it cannot be put on the queue', async () => {
    const { deps } = makeDeps(() => Promise.reject(new Error('redis is down')));
    const site = await makeWebsite();
    const result = await runSchedulerTick(deps, now);
    expect(result.started.find((entry) => entry.websiteId === site.id)).toBeUndefined();
    expect(result.skipped.find((entry) => entry.websiteId === site.id)).toBeDefined();

    const [scan] = await scansOf(site.id);
    expect(scan).toMatchObject({ status: 'failed' });
    expect(scan?.errorMessage).toContain('could not be queued');
    const website = await db.website.findUniqueOrThrow({ where: { id: site.id } });
    expect(website.nextCheckAt?.getTime()).toBe(now.getTime() + RETRY_AFTER_MS);
    expect(website.lastRunError).toContain('unexpected error');
  });

  it('starts many due websites in one tick, oldest due first', async () => {
    const { deps } = makeDeps();
    const sites: { id: string; hostname: string }[] = [];
    for (let i = 0; i < 5; i += 1) {
      sites.push(await makeWebsite({ nextCheckAt: new Date(now.getTime() - (i + 1) * HOUR) }));
    }
    const result = await runSchedulerTick(deps, now);
    const order = result.started
      .filter((entry) => sites.some((site) => site.id === entry.websiteId))
      .map((entry) => entry.websiteId);
    expect(order).toEqual([...sites].reverse().map((site) => site.id));
  });

  it('returns nothing to do when nothing is due', async () => {
    await db.website.updateMany({ data: { isActive: false } });
    const { deps } = makeDeps();
    expect(await runSchedulerTick(deps, now)).toEqual({ started: [], skipped: [] });
  });
});
