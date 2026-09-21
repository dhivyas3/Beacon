import { newId } from '@beacon/shared';
import type { CheckType, FormMode, PageSelectionMode, TriggerType } from '@beacon/shared';
import type { Prisma, PrismaClient, Scan } from '@prisma/client';

/** Statuses of a scan that is still going. Only one scan per hostname may be in one of them. */
export const ACTIVE_SCAN_STATUSES = ['queued', 'discovering', 'running'] as const;

/** Thrown when a scan of the same hostname is already queued or running. */
export class ActiveScanError extends Error {
  constructor(
    readonly scanId: string,
    readonly hostname: string,
  ) {
    super(`A scan of ${hostname} is already active.`);
    this.name = 'ActiveScanError';
  }
}

export interface NewScan {
  url: string;
  hostname: string;
  checks: readonly CheckType[];
  formMode: FormMode;
  callbackUrl?: string | null;
  metadata?: Prisma.InputJsonObject | undefined;
  idempotencyKey?: string | null;
  triggeredByUserId?: string | null;
  triggeredByApiKeyId?: string | null;
  triggeredByType: TriggerType;
  websiteId?: string | null;
  pageSelectionMode: PageSelectionMode;
  staticPageUrls?: readonly string[];
  pinnedPageUrls?: readonly string[];
  sampleSize?: number;
  pageConcurrency: number;
  linkConcurrency: number;
  /** How long the previous scan of this host took, to seed the first estimate. */
  seedDurationMs?: number | null;
}

/**
 * Creates a queued scan. Shared by the API (a person or a key asks for one) and the scheduler (a
 * website is due), so both follow the same rules: the run number counts up per hostname, and only
 * one scan per hostname may be active. The caller puts the scan on the queue afterwards.
 *
 * The counter row is locked for the rest of the transaction, so concurrent requests for a hostname
 * run one after another and the loser finds the winner's active scan.
 */
export async function createQueuedScan(db: PrismaClient, input: NewScan): Promise<Scan> {
  return db.$transaction(async (tx) => {
    const counter = await tx.hostnameCounter.upsert({
      where: { hostname: input.hostname },
      create: { hostname: input.hostname, last: 1 },
      update: { last: { increment: 1 } },
    });

    const active = await tx.scan.findFirst({
      where: { hostname: input.hostname, status: { in: [...ACTIVE_SCAN_STATUSES] } },
      select: { id: true },
    });
    if (active) throw new ActiveScanError(active.id, input.hostname);

    return tx.scan.create({
      data: {
        id: newId('scn'),
        url: input.url,
        hostname: input.hostname,
        runNumber: counter.last,
        status: 'queued',
        checks: [...input.checks],
        formMode: input.formMode,
        callbackUrl: input.callbackUrl ?? null,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        idempotencyKey: input.idempotencyKey ?? null,
        triggeredByUserId: input.triggeredByUserId ?? null,
        triggeredByApiKeyId: input.triggeredByApiKeyId ?? null,
        triggeredByType: input.triggeredByType,
        websiteId: input.websiteId ?? null,
        pageSelectionMode: input.pageSelectionMode,
        staticPageUrls: [...(input.staticPageUrls ?? [])],
        pinnedPageUrls: [...(input.pinnedPageUrls ?? [])],
        ...(input.sampleSize === undefined ? {} : { sampleSize: input.sampleSize }),
        pageConcurrency: input.pageConcurrency,
        linkConcurrency: input.linkConcurrency,
        seedDurationMs: input.seedDurationMs ?? null,
      },
    });
  });
}

/** How long the last completed scan of a hostname took, or null when there is none. */
export async function previousDurationMs(
  db: PrismaClient,
  hostname: string,
): Promise<number | null> {
  const previous = await db.scan.findFirst({
    where: { hostname, status: 'completed', startedAt: { not: null }, finishedAt: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { startedAt: true, finishedAt: true },
  });
  if (!previous?.startedAt || !previous.finishedAt) return null;
  return Math.max(0, previous.finishedAt.getTime() - previous.startedAt.getTime());
}

export interface ScanReference {
  id: string;
  hostname: string;
  websiteId: string | null;
  previousScanId: string | null;
  createdAt: Date;
}

/**
 * The completed scan this one is compared with. Once a scan completes it points at that scan
 * (`previousScanId`). Before that, and for older rows, it is the latest completed scan that started
 * earlier, of the same website, or of no website for one-off scans, so a full audit is never
 * compared with a sample of a few pages.
 */
export async function findPreviousScan(
  db: PrismaClient,
  scan: ScanReference,
): Promise<Scan | null> {
  if (scan.previousScanId !== null) {
    const stored = await db.scan.findUnique({ where: { id: scan.previousScanId } });
    if (stored) return stored;
  }
  return db.scan.findFirst({
    where: {
      hostname: scan.hostname,
      websiteId: scan.websiteId,
      status: 'completed',
      id: { not: scan.id },
      createdAt: { lt: scan.createdAt },
    },
    orderBy: { createdAt: 'desc' },
  });
}
