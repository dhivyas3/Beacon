import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@qa-hub/shared';
import { createIsolatedDatabase, type TestDatabase } from '@qa-hub/testkit';
import { createDb, isUniqueViolation, type Db } from './index.js';

let database: TestDatabase;
let db: Db;

beforeAll(async () => {
  database = await createIsolatedDatabase();
  db = createDb({ url: database.url, log: false });
});

afterAll(async () => {
  await db.$disconnect();
  await database.drop();
});

function scanData(hostname: string, runNumber: number, status: 'queued' | 'completed' = 'queued') {
  return {
    id: newId('scn'),
    url: `https://${hostname}/`,
    hostname,
    runNumber,
    status,
    checks: ['images', 'links'],
  };
}

describe('schema', () => {
  it('stores a scan with pages, issues and check results, and cascades deletes', async () => {
    const scan = await db.scan.create({ data: scanData('cascade.test', 1, 'completed') });
    const page = await db.scanPage.create({
      data: { id: newId('pg'), scanId: scan.id, url: 'https://cascade.test/' },
    });
    await db.scanIssue.create({
      data: {
        id: newId('iss'),
        scanId: scan.id,
        pageId: page.id,
        checkType: 'images',
        severity: 'critical',
        fingerprint: 'abc',
        message: 'Broken image',
        evidence: { status: 404 },
      },
    });
    await db.checkResult.create({
      data: { id: newId('chk'), scanId: scan.id, checkType: 'images', issuesFound: 1 },
    });

    await db.scan.delete({ where: { id: scan.id } });

    expect(await db.scanPage.count({ where: { scanId: scan.id } })).toBe(0);
    expect(await db.scanIssue.count({ where: { scanId: scan.id } })).toBe(0);
    expect(await db.checkResult.count({ where: { scanId: scan.id } })).toBe(0);
  });

  it('allows only one active scan per hostname', async () => {
    const first = await db.scan.create({ data: scanData('active.test', 1) });

    const duplicate = db.scan.create({ data: scanData('active.test', 2) });
    await expect(duplicate).rejects.toSatisfy(isUniqueViolation);

    await db.scan.update({ where: { id: first.id }, data: { status: 'completed' } });
    await expect(db.scan.create({ data: scanData('active.test', 2) })).resolves.toBeTruthy();
  });

  it('allows concurrent active scans on different hostnames', async () => {
    await db.scan.create({ data: scanData('one.test', 1) });
    await expect(db.scan.create({ data: scanData('two.test', 1) })).resolves.toBeTruthy();
  });

  it('enforces unique run numbers per hostname', async () => {
    await db.scan.create({ data: scanData('runs.test', 1, 'completed') });
    await expect(db.scan.create({ data: scanData('runs.test', 1, 'completed') })).rejects.toSatisfy(
      isUniqueViolation,
    );
  });

  it('enforces unique idempotency keys', async () => {
    const data = { ...scanData('idem.test', 1, 'completed'), idempotencyKey: 'usr_x:abc' };
    await db.scan.create({ data });
    await expect(
      db.scan.create({ data: { ...scanData('idem2.test', 1), idempotencyKey: 'usr_x:abc' } }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('keeps hostname counters gap free under concurrency', async () => {
    const hostname = 'counter.test';
    const numbers = await Promise.all(
      Array.from({ length: 8 }, () =>
        db.hostnameCounter
          .upsert({
            where: { hostname },
            create: { hostname, last: 1 },
            update: { last: { increment: 1 } },
          })
          .then((row) => row.last),
      ),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
