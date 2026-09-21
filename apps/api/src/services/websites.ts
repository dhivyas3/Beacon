import { isUniqueViolation, type Db, type Prisma } from '@beacon/db';
import {
  computeNextCheckAt,
  isHostAllowed,
  newId,
  normalizeUrl,
  websiteConfigProblems,
  type CheckNowBody,
  type CheckType,
  type CreateWebsiteBody,
  type EmailDelivery,
  type EmailStatus,
  type ListEmailDeliveriesQuery,
  type ListWebsitesQuery,
  type Page,
  type RecipientInput,
  type UpdateRecipientBody,
  type UpdateWebsiteBody,
  type Website,
  type WebsiteHistoryItem,
  type WebsiteRecipient,
} from '@beacon/shared';
import { ApiError, notFound } from '../lib/errors.js';
import { paginateById } from '../lib/pagination.js';
import type { Actor } from '../types.js';
import type { CreateScanResult, ScanService } from './scans.js';

const ACTIVE = ['queued', 'discovering', 'running'] as const;

const websiteInclude = {
  owner: { select: { id: true, name: true } },
  recipients: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.WebsiteInclude;

type WebsiteRow = Prisma.WebsiteGetPayload<{ include: typeof websiteInclude }>;

interface Extras {
  latest: Website['latest'];
  pagesEverChecked: number;
  activeScanId: string | null;
  emailStatus: EmailStatus | null;
}

function recipientDto(row: WebsiteRow['recipients'][number]): WebsiteRecipient {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isActive: row.isActive,
    notify: row.notify,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWebsiteDto(row: WebsiteRow, extras: Extras): Website {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    hostname: row.hostname,
    owner: row.owner ? { id: row.owner.id, name: row.owner.name } : null,
    checkFrequency: row.checkFrequency,
    scheduleDayOfWeek: row.scheduleDayOfWeek,
    scheduleDayOfMonth: row.scheduleDayOfMonth,
    scheduleHourUtc: row.scheduleHourUtc,
    pageSelectionMode: row.pageSelectionMode,
    staticPageUrls: row.staticPageUrls,
    pinnedPageUrls: row.pinnedPageUrls,
    sampleSize: row.sampleSize,
    enabledChecks: row.enabledChecks as CheckType[],
    formMode: row.formMode,
    isActive: row.isActive,
    emailEnabled: row.emailEnabled,
    lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
    nextCheckAt: row.nextCheckAt?.toISOString() ?? null,
    lastRunError: row.lastRunError,
    recipients: row.recipients.map(recipientDto),
    latest: extras.latest,
    pagesEverChecked: extras.pagesEverChecked,
    activeScanId: extras.activeScanId,
    emailStatus: extras.emailStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normaliseUrls(urls: readonly string[]): string[] {
  return [...new Set(urls.map((entry) => normalizeUrl(entry)).filter((entry) => entry !== null))];
}

function normaliseRecipients(recipients: readonly RecipientInput[]): RecipientInput[] {
  const seen = new Map<string, RecipientInput>();
  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (!seen.has(email)) {
      seen.set(email, {
        email,
        name: recipient.name ?? null,
        notify: recipient.notify ?? 'every_check',
      });
    }
  }
  return [...seen.values()];
}

export interface WebsiteServiceDeps {
  db: Db;
  scans: ScanService;
}

export class WebsiteService {
  constructor(private readonly deps: WebsiteServiceDeps) {}

  // ---- Reading ---------------------------------------------------------------------------------

  /** Latest finished check, pages ever checked and any running check, for a batch of websites. */
  private async extrasFor(rows: readonly WebsiteRow[]): Promise<Map<string, Extras>> {
    const { db } = this.deps;
    const ids = rows.map((row) => row.id);
    const extras = new Map<string, Extras>(
      ids.map((id) => [
        id,
        { latest: null, pagesEverChecked: 0, activeScanId: null, emailStatus: null },
      ]),
    );
    if (ids.length === 0) return extras;

    const [latest, active, pages] = await Promise.all([
      db.scan.findMany({
        where: { websiteId: { in: ids }, status: { in: ['completed', 'failed'] } },
        orderBy: [{ websiteId: 'asc' }, { finishedAt: 'desc' }, { id: 'desc' }],
        distinct: ['websiteId'],
      }),
      db.scan.findMany({
        where: { websiteId: { in: ids }, status: { in: [...ACTIVE] } },
        select: { id: true, websiteId: true },
      }),
      db.$queryRaw<{ websiteId: string; count: number }[]>`
        SELECT s."websiteId", COUNT(DISTINCT p."url")::int AS count
        FROM "ScanPage" p
        JOIN "Scan" s ON s."id" = p."scanId"
        WHERE s."websiteId" = ANY(${ids}) AND p."status" = 'done'
        GROUP BY s."websiteId"`,
    ]);

    const previousIds = latest.flatMap((scan) =>
      scan.previousScanId ? [scan.previousScanId] : [],
    );
    const previous = new Map(
      (
        await db.scan.findMany({
          where: { id: { in: previousIds } },
          select: { id: true, healthScore: true },
        })
      ).map((scan) => [scan.id, scan.healthScore]),
    );

    for (const scan of latest) {
      if (scan.websiteId === null) continue;
      const before = scan.previousScanId ? (previous.get(scan.previousScanId) ?? null) : null;
      const entry = extras.get(scan.websiteId);
      if (entry) {
        entry.latest = {
          scanId: scan.id,
          runNumber: scan.runNumber,
          status: scan.status,
          healthScore: scan.healthScore,
          critical: scan.criticalCount,
          warnings: scan.warningCount,
          pages: scan.pagesTotal,
          finishedAt: scan.finishedAt?.toISOString() ?? null,
          scoreChange:
            scan.status === 'completed' && scan.healthScore !== null && before !== null
              ? scan.healthScore - before
              : null,
          triggeredByType: scan.triggeredByType,
        };
      }
    }
    for (const scan of active) {
      const entry = scan.websiteId ? extras.get(scan.websiteId) : undefined;
      if (entry) entry.activeScanId = scan.id;
    }
    for (const row of pages) {
      const entry = extras.get(row.websiteId);
      if (entry) entry.pagesEverChecked = row.count;
    }
    await this.addEmailStatus(ids, extras);
    return extras;
  }

  /** How the emails of each website's most recent emailed check went. */
  private async addEmailStatus(ids: string[], extras: Map<string, Extras>): Promise<void> {
    const { db } = this.deps;
    const newest = await db.emailDelivery.findMany({
      where: { websiteId: { in: ids } },
      orderBy: [{ websiteId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['websiteId'],
      select: { websiteId: true, scanId: true },
    });
    if (newest.length === 0) return;
    const scanIds = newest.map((row) => row.scanId);
    const [counts, failures] = await Promise.all([
      db.emailDelivery.groupBy({
        by: ['scanId', 'status'],
        where: { scanId: { in: scanIds } },
        _count: { _all: true },
      }),
      db.emailDelivery.findMany({
        where: { scanId: { in: scanIds }, status: 'failed' },
        orderBy: { updatedAt: 'desc' },
        select: { scanId: true, error: true, email: true },
      }),
    ]);
    for (const { websiteId, scanId } of newest) {
      if (websiteId === null) continue;
      const count = (status: string): number =>
        counts.find((c) => c.scanId === scanId && c.status === status)?._count._all ?? 0;
      const failure = failures.find((f) => f.scanId === scanId);
      const entry = extras.get(websiteId);
      if (entry) {
        entry.emailStatus = {
          scanId,
          sent: count('sent'),
          failed: count('failed'),
          pending: count('pending'),
          lastError: failure
            ? `${failure.email}: ${failure.error ?? 'It could not be sent.'}`
            : null,
        };
      }
    }
  }

  private async toDtos(rows: readonly WebsiteRow[]): Promise<Website[]> {
    const extras = await this.extrasFor(rows);
    return rows.map((row) => toWebsiteDto(row, extras.get(row.id) as Extras));
  }

  private async getRow(id: string): Promise<WebsiteRow> {
    const row = await this.deps.db.website.findUnique({ where: { id }, include: websiteInclude });
    if (!row) throw notFound('Website', id);
    return row;
  }

  async get(id: string): Promise<Website> {
    const [dto] = await this.toDtos([await this.getRow(id)]);
    return dto as Website;
  }

  async list(query: ListWebsitesQuery): Promise<Page<Website>> {
    const where: Prisma.WebsiteWhereInput = {
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { url: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const { rows, nextCursor } = await paginateById(query.limit, query.cursor, (args) =>
      this.deps.db.website.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        include: websiteInclude,
        ...args,
      }),
    );
    return { items: await this.toDtos(rows), nextCursor };
  }

  async history(
    id: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<Page<WebsiteHistoryItem>> {
    await this.getRow(id);
    const { rows, nextCursor } = await paginateById(query.limit, query.cursor, (args) =>
      this.deps.db.scan.findMany({
        where: { websiteId: id, status: 'completed' },
        orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
        ...args,
      }),
    );
    return {
      items: rows.map((scan) => ({
        scanId: scan.id,
        runNumber: scan.runNumber,
        triggeredByType: scan.triggeredByType,
        healthScore: scan.healthScore,
        critical: scan.criticalCount,
        warnings: scan.warningCount,
        pages: scan.pagesTotal,
        startedAt: scan.startedAt?.toISOString() ?? null,
        finishedAt: scan.finishedAt?.toISOString() ?? null,
      })),
      nextCursor,
    };
  }

  // ---- Writing ---------------------------------------------------------------------------------

  private requireFormsScope(actor: Actor, formMode: string | undefined): void {
    if (formMode === 'submit' && !actor.scopes.includes('forms:submit')) {
      throw new ApiError(
        'forbidden',
        'Submitting forms needs the forms:submit scope. Use formMode "validate_only" or "detect", or ask an admin for a key with that scope.',
        { requiredScope: 'forms:submit' },
      );
    }
  }

  /** The user a website belongs to. A key acts on behalf of whoever created it. */
  private async ownerFor(actor: Actor): Promise<string> {
    const { db } = this.deps;
    if (actor.kind === 'user') return actor.id;
    const key = await db.apiKey.findUnique({
      where: { id: actor.id },
      select: { createdById: true },
    });
    if (key?.createdById) return key.createdById;
    const admin = await db.user.findFirst({
      where: { role: 'admin' },
      orderBy: { createdAt: 'asc' },
    });
    if (!admin) throw new ApiError('bad_request', 'There is no user to own this website.');
    return admin.id;
  }

  private async assertAllowed(hostname: string): Promise<void> {
    const allowed = await this.deps.db.allowedDomain.findMany({ select: { hostname: true } });
    if (
      !isHostAllowed(
        hostname,
        allowed.map((entry) => entry.hostname),
      )
    ) {
      throw new ApiError(
        'domain_not_allowed',
        `${hostname} is not on the allowed domains list. Ask an admin to add it in Settings, then try again.`,
        { hostname },
      );
    }
  }

  private static problemsToError(problems: { field: string; message: string }[]): ApiError {
    return new ApiError('validation_error', problems.map((p) => p.message).join(' '), { problems });
  }

  async create(actor: Actor, body: CreateWebsiteBody): Promise<Website> {
    const { db } = this.deps;
    this.requireFormsScope(actor, body.formMode);

    const url = normalizeUrl(body.url);
    if (url === null) {
      throw new ApiError('validation_error', 'The url is not a valid http or https address.');
    }
    const hostname = new URL(url).hostname.toLowerCase();
    await this.assertAllowed(hostname);
    await this.deps.scans.assertReachablePublicly(url, 'url');

    const staticPageUrls = normaliseUrls(body.staticPageUrls);
    const pinnedPageUrls = normaliseUrls(body.pinnedPageUrls);
    const problems = websiteConfigProblems({ ...body, url, staticPageUrls, pinnedPageUrls });
    if (problems.length > 0) throw WebsiteService.problemsToError(problems);

    const ownerId = await this.ownerFor(actor);
    const now = new Date();
    const nextCheckAt = body.isActive ? computeNextCheckAt(body, now) : null;

    try {
      const row = await db.website.create({
        data: {
          id: newId('web'),
          name: body.name,
          url,
          hostname,
          ownerId,
          checkFrequency: body.checkFrequency,
          scheduleDayOfWeek: body.checkFrequency === 'weekly' ? body.scheduleDayOfWeek : null,
          scheduleDayOfMonth: body.checkFrequency === 'monthly' ? body.scheduleDayOfMonth : null,
          scheduleHourUtc: body.scheduleHourUtc,
          pageSelectionMode: body.pageSelectionMode,
          staticPageUrls,
          pinnedPageUrls,
          sampleSize: body.sampleSize,
          enabledChecks: [...new Set(body.enabledChecks)],
          formMode: body.formMode,
          isActive: body.isActive,
          emailEnabled: body.emailEnabled,
          nextCheckAt,
          recipients: {
            create: normaliseRecipients(body.recipients).map((recipient) => ({
              id: newId('rcp'),
              email: recipient.email,
              name: recipient.name ?? null,
              notify: recipient.notify ?? 'every_check',
            })),
          },
        },
        include: websiteInclude,
      });
      const [dto] = await this.toDtos([row]);
      return dto as Website;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await db.website.findUnique({
          where: { hostname },
          select: { id: true, name: true },
        });
        throw new ApiError(
          'conflict',
          `${hostname} is already registered${existing ? ` as ${existing.name}` : ''}. Edit that website instead.`,
          { websiteId: existing?.id },
        );
      }
      throw error;
    }
  }

  async update(actor: Actor, id: string, body: UpdateWebsiteBody): Promise<Website> {
    const { db } = this.deps;
    const current = await this.getRow(id);
    this.requireFormsScope(actor, body.formMode);

    let url = current.url;
    if (body.url !== undefined) {
      const normal = normalizeUrl(body.url);
      if (normal === null) {
        throw new ApiError('validation_error', 'The url is not a valid http or https address.');
      }
      if (new URL(normal).hostname.toLowerCase() !== current.hostname) {
        throw new ApiError(
          'validation_error',
          `The url must stay on ${current.hostname}. To monitor another hostname, add it as a new website.`,
          { field: 'url' },
        );
      }
      url = normal;
    }

    const merged = {
      url,
      checkFrequency: body.checkFrequency ?? current.checkFrequency,
      scheduleDayOfWeek:
        body.scheduleDayOfWeek === undefined ? current.scheduleDayOfWeek : body.scheduleDayOfWeek,
      scheduleDayOfMonth:
        body.scheduleDayOfMonth === undefined
          ? current.scheduleDayOfMonth
          : body.scheduleDayOfMonth,
      scheduleHourUtc: body.scheduleHourUtc ?? current.scheduleHourUtc,
      pageSelectionMode: body.pageSelectionMode ?? current.pageSelectionMode,
      staticPageUrls: body.staticPageUrls
        ? normaliseUrls(body.staticPageUrls)
        : current.staticPageUrls,
      pinnedPageUrls: body.pinnedPageUrls
        ? normaliseUrls(body.pinnedPageUrls)
        : current.pinnedPageUrls,
      sampleSize: body.sampleSize ?? current.sampleSize,
      enabledChecks: body.enabledChecks ? [...new Set(body.enabledChecks)] : current.enabledChecks,
    };
    const problems = websiteConfigProblems(merged);
    if (problems.length > 0) throw WebsiteService.problemsToError(problems);
    if (body.url !== undefined) await this.deps.scans.assertReachablePublicly(url, 'url');

    const isActive = body.isActive ?? current.isActive;
    const scheduleChanged =
      body.checkFrequency !== undefined ||
      body.scheduleDayOfWeek !== undefined ||
      body.scheduleDayOfMonth !== undefined ||
      body.scheduleHourUtc !== undefined;
    const resumed = !current.isActive && isActive;
    // Pausing clears the next check. A change of schedule, or resuming, plans it again from now.
    // Otherwise a planned check keeps its time, so editing the name never postpones a run.
    const nextCheckAt = !isActive
      ? null
      : scheduleChanged || resumed || current.nextCheckAt === null
        ? computeNextCheckAt(merged, new Date())
        : current.nextCheckAt;

    const row = await db.website.update({
      where: { id },
      data: {
        ...(body.name === undefined ? {} : { name: body.name }),
        url,
        checkFrequency: merged.checkFrequency,
        scheduleDayOfWeek: merged.checkFrequency === 'weekly' ? merged.scheduleDayOfWeek : null,
        scheduleDayOfMonth: merged.checkFrequency === 'monthly' ? merged.scheduleDayOfMonth : null,
        scheduleHourUtc: merged.scheduleHourUtc,
        pageSelectionMode: merged.pageSelectionMode,
        staticPageUrls: merged.staticPageUrls,
        pinnedPageUrls: merged.pinnedPageUrls,
        sampleSize: merged.sampleSize,
        enabledChecks: merged.enabledChecks,
        ...(body.formMode === undefined ? {} : { formMode: body.formMode }),
        ...(body.emailEnabled === undefined ? {} : { emailEnabled: body.emailEnabled }),
        isActive,
        nextCheckAt,
        ...(resumed ? { lastRunError: null } : {}),
      },
      include: websiteInclude,
    });
    const [dto] = await this.toDtos([row]);
    return dto as Website;
  }

  /** Removes the website and its recipients. Its checks stay, as scans of no website. */
  async remove(id: string): Promise<void> {
    await this.getRow(id);
    await this.deps.db.website.delete({ where: { id } });
  }

  async addRecipient(id: string, input: RecipientInput): Promise<WebsiteRecipient> {
    const { db } = this.deps;
    await this.getRow(id);
    const email = input.email.trim().toLowerCase();
    try {
      const row = await db.websiteRecipient.create({
        data: {
          id: newId('rcp'),
          websiteId: id,
          email,
          name: input.name ?? null,
          notify: input.notify ?? 'every_check',
        },
      });
      return recipientDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('conflict', `${email} already receives this website's reports.`, {
          email,
        });
      }
      throw error;
    }
  }

  /** Changes who a recipient is, whether they receive reports, and what they receive. */
  async updateRecipient(
    id: string,
    recipientId: string,
    body: UpdateRecipientBody,
  ): Promise<WebsiteRecipient> {
    const { db } = this.deps;
    const updated = await db.websiteRecipient.updateMany({
      where: { id: recipientId, websiteId: id },
      data: {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
        ...(body.notify === undefined ? {} : { notify: body.notify }),
      },
    });
    if (updated.count === 0) {
      await this.getRow(id);
      throw notFound('Recipient', recipientId);
    }
    return recipientDto(
      await db.websiteRecipient.findUniqueOrThrow({ where: { id: recipientId } }),
    );
  }

  /** The emails sent for a website's checks, newest first, so a failure is visible in the app. */
  async emailDeliveries(id: string, query: ListEmailDeliveriesQuery): Promise<Page<EmailDelivery>> {
    await this.getRow(id);
    const { rows, nextCursor } = await paginateById(query.limit, query.cursor, (args) =>
      this.deps.db.emailDelivery.findMany({
        where: {
          websiteId: id,
          ...(query.scanId ? { scanId: query.scanId } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...args,
      }),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        scanId: row.scanId,
        email: row.email,
        subject: row.subject,
        status: row.status,
        attempts: row.attempts,
        provider: row.provider,
        providerMessageId: row.providerMessageId,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      })),
      nextCursor,
    };
  }

  async removeRecipient(id: string, recipientId: string): Promise<void> {
    const removed = await this.deps.db.websiteRecipient.deleteMany({
      where: { id: recipientId, websiteId: id },
    });
    if (removed.count === 0) {
      await this.getRow(id);
      throw notFound('Recipient', recipientId);
    }
  }

  /** Starts a check now, outside the schedule. The schedule itself is left alone. */
  async checkNow(actor: Actor, id: string, body: CheckNowBody): Promise<CreateScanResult> {
    await this.getRow(id);
    return this.deps.scans.create(
      actor,
      {
        websiteId: id,
        ...(body.source === undefined ? {} : { source: body.source }),
        ...(body.callbackUrl === undefined ? {} : { callbackUrl: body.callbackUrl }),
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      },
      undefined,
    );
  }
}
