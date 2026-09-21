import {
  ActiveScanError,
  createQueuedScan,
  findPreviousScan,
  isUniqueViolation,
  previousDurationMs,
  type Prisma,
  type Db,
} from '@beacon/db';
import {
  isHostAllowed,
  normalizeUrl,
  type CheckType,
  type CreateScanBody,
  type FormMode,
  type ListScansQuery,
  type Page,
  SAMPLE_SIZE,
  type Scan,
  type ScanDetail,
  type TriggerType,
  websiteConfigProblems,
} from '@beacon/shared';
import { assertPublicUrl, UrlBlockedError, type HostResolver } from '@beacon/net';
import type { ApiConfig } from '../config.js';
import { ApiError, notFound } from '../lib/errors.js';
import { paginateById } from '../lib/pagination.js';
import type { ScanQueue } from '../queue.js';
import type { Actor } from '../types.js';
import { listFixedIssues } from './issues.js';
import { queuePositions, scanInclude, toScanDto, type ScanRow } from './scan-view.js';
import { loadSettings } from './settings.js';

export interface ScanServiceDeps {
  db: Db;
  config: ApiConfig;
  queue: ScanQueue;
  resolver: HostResolver | undefined;
}

const ACTIVE = ['queued', 'discovering', 'running'] as const;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export interface CreateScanResult {
  scan: Scan;
  /** True when an earlier request with the same Idempotency-Key already created this scan. */
  replayed: boolean;
}

export class ScanService {
  constructor(private readonly deps: ScanServiceDeps) {}

  private get view() {
    return { publicUrl: this.deps.config.PUBLIC_URL };
  }

  /** Builds the public shape for one scan, including its queue position when queued. */
  async toDto(row: ScanRow): Promise<Scan> {
    const position =
      row.status === 'queued' ? ((await queuePositions(this.deps.db)).get(row.id) ?? null) : null;
    return toScanDto(row, this.view, position);
  }

  async create(
    actor: Actor,
    body: CreateScanBody,
    idempotencyHeader: string | undefined,
  ): Promise<CreateScanResult> {
    const { db, config } = this.deps;

    let idempotencyKey: string | null = null;
    if (idempotencyHeader !== undefined) {
      const trimmed = idempotencyHeader.trim();
      if (trimmed === '' || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new ApiError(
          'bad_request',
          `The Idempotency-Key header must be between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
        );
      }
      idempotencyKey = `${actor.kind}:${actor.id}:${trimmed}`;
      const existing = await this.findByIdempotencyKey(idempotencyKey);
      if (existing) return { scan: await this.toDto(existing), replayed: true };
    }

    if (body.formMode === 'submit' && !actor.scopes.includes('forms:submit')) {
      throw new ApiError(
        'forbidden',
        'Submitting forms needs the forms:submit scope. Use formMode "validate_only" or "detect", or ask an admin for a key with that scope.',
        { requiredScope: 'forms:submit' },
      );
    }

    const website =
      body.websiteId === undefined
        ? null
        : await db.website.findUnique({ where: { id: body.websiteId } });
    if (body.websiteId !== undefined && website === null) throw notFound('Website', body.websiteId);

    const url = normalizeUrl(body.url ?? website?.url ?? '');
    if (url === null)
      throw new ApiError('validation_error', 'The url is not a valid http or https address.');
    const hostname = new URL(url).hostname.toLowerCase();
    if (website !== null && hostname !== website.hostname) {
      throw new ApiError(
        'validation_error',
        `The url is on ${hostname}, but ${website.name} is ${website.hostname}. Leave the url out to check the website itself.`,
        { field: 'url', websiteId: website.id },
      );
    }

    const allowed = await db.allowedDomain.findMany({ select: { hostname: true } });
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

    await this.assertReachablePublicly(url, 'url');
    if (body.callbackUrl !== undefined)
      await this.assertReachablePublicly(body.callbackUrl, 'callbackUrl');

    const settings = await loadSettings(db, config);
    // A website's own configuration is what its scheduled runs use, so a manual check runs the same
    // way unless the request overrides it. The website's form mode was authorised when it was saved.
    const checks: CheckType[] = [
      ...new Set(
        body.checks ??
          (website?.enabledChecks as CheckType[] | undefined) ??
          settings.defaultChecks,
      ),
    ];
    let formMode: FormMode = body.formMode ?? website?.formMode ?? settings.defaultFormMode;
    if (
      body.formMode === undefined &&
      website === null &&
      formMode === 'submit' &&
      !actor.scopes.includes('forms:submit')
    ) {
      formMode = 'detect';
    }

    const selection = this.resolveSelection(body, website, url);
    const triggeredByType: TriggerType =
      actor.kind === 'user' ? 'manual_ui' : (body.source ?? 'manual_api');
    const seedDurationMs = await previousDurationMs(db, hostname);

    try {
      const created = await createQueuedScan(db, {
        url,
        hostname,
        checks,
        formMode,
        callbackUrl: body.callbackUrl ?? null,
        ...(body.metadata === undefined
          ? {}
          : { metadata: body.metadata as Prisma.InputJsonObject }),
        idempotencyKey,
        triggeredByUserId: actor.kind === 'user' ? actor.id : null,
        triggeredByApiKeyId: actor.kind === 'api_key' ? actor.id : null,
        triggeredByType,
        websiteId: website?.id ?? null,
        ...selection,
        pageConcurrency: config.PAGE_CONCURRENCY,
        linkConcurrency: config.LINK_CONCURRENCY,
        seedDurationMs,
      });
      const row = await this.getRow(created.id);

      try {
        await this.deps.queue.enqueue(row.id);
      } catch (error) {
        await db.scan.update({
          where: { id: row.id },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            errorMessage: 'The scan could not be queued. Try again in a moment.',
          },
        });
        throw error;
      }

      return { scan: await this.toDto(row), replayed: false };
    } catch (error) {
      const raced = error instanceof ActiveScanError || isUniqueViolation(error);
      if (raced) {
        // A concurrent request got there first. If it carried our Idempotency-Key it is a retry of
        // this same request, so answer with that scan rather than a conflict.
        if (idempotencyKey !== null) {
          const existing = await this.findByIdempotencyKey(idempotencyKey);
          if (existing) return { scan: await this.toDto(existing), replayed: true };
        }
        const active = await db.scan.findFirst({
          where: { hostname, status: { in: [...ACTIVE] } },
          include: scanInclude,
        });
        if (active) throw await this.conflict(active);
      }
      throw error;
    }
  }

  /**
   * Which pages the scan checks: what the request says, else what the website says, else every
   * page. Lists are normalised, and a selection that cannot work is refused before the scan exists.
   */
  private resolveSelection(
    body: CreateScanBody,
    website: {
      pageSelectionMode: 'full' | 'static_list' | 'random_sample';
      staticPageUrls: string[];
      pinnedPageUrls: string[];
      sampleSize: number;
    } | null,
    url: string,
  ) {
    const normalise = (urls: readonly string[]): string[] => [
      ...new Set(urls.map((entry) => normalizeUrl(entry)).filter((entry) => entry !== null)),
    ];
    const pageSelectionMode = body.pageSelectionMode ?? website?.pageSelectionMode ?? 'full';
    const staticPageUrls = normalise(body.staticPageUrls ?? website?.staticPageUrls ?? []);
    const pinnedPageUrls = normalise(body.pinnedPageUrls ?? website?.pinnedPageUrls ?? []);
    const sampleSize = body.sampleSize ?? website?.sampleSize ?? SAMPLE_SIZE.default;

    const problems = websiteConfigProblems({
      url,
      checkFrequency: 'manual',
      scheduleDayOfWeek: null,
      scheduleDayOfMonth: null,
      pageSelectionMode,
      staticPageUrls,
      pinnedPageUrls,
      sampleSize,
      enabledChecks: ['images'],
    }).filter((problem) =>
      ['staticPageUrls', 'pinnedPageUrls', 'sampleSize'].includes(problem.field),
    );
    if (problems.length > 0) {
      throw new ApiError('validation_error', problems.map((p) => p.message).join(' '), {
        problems,
      });
    }
    return { pageSelectionMode, staticPageUrls, pinnedPageUrls, sampleSize };
  }

  async list(query: ListScansQuery): Promise<Page<Scan>> {
    const { db } = this.deps;
    const where: Prisma.ScanWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.hostname ? { hostname: query.hostname } : {}),
      ...(query.q ? { url: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const { rows, nextCursor } = await paginateById(query.limit, query.cursor, (args) =>
      db.scan.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: scanInclude,
        ...args,
      }),
    );
    const positions = rows.some((row) => row.status === 'queued')
      ? await queuePositions(db)
      : new Map<string, number>();
    return {
      items: rows.map((row) => toScanDto(row, this.view, positions.get(row.id) ?? null)),
      nextCursor,
    };
  }

  async getRow(id: string): Promise<ScanRow> {
    const row = await this.deps.db.scan.findUnique({ where: { id }, include: scanInclude });
    if (!row) throw notFound('Scan', id);
    return row;
  }

  async get(id: string): Promise<Scan> {
    return this.toDto(await this.getRow(id));
  }

  async getDetail(id: string): Promise<ScanDetail> {
    const { db } = this.deps;
    const row = await this.getRow(id);
    const scan = await this.toDto(row);

    const [results, previous] = await Promise.all([
      db.checkResult.findMany({ where: { scanId: id }, orderBy: { checkType: 'asc' } }),
      this.previousCompleted(row),
    ]);

    const fixedIssueCount =
      previous && row.status === 'completed'
        ? (await listFixedIssues(db, row, previous.id)).length
        : 0;

    const scoreChange =
      previous?.healthScore != null && row.healthScore != null
        ? row.healthScore - previous.healthScore
        : null;

    return {
      ...scan,
      checkResults: results.map((result) => ({
        checkType: result.checkType as CheckType,
        pagesChecked: result.pagesChecked,
        issuesFound: result.issuesFound,
      })),
      previousScan: previous
        ? {
            id: previous.id,
            runNumber: previous.runNumber,
            healthScore: previous.healthScore,
            finishedAt: previous.finishedAt?.toISOString() ?? null,
          }
        : null,
      scoreChange,
      fixedIssueCount,
    };
  }

  /** Cancels a scan that has not finished. The worker stops on its next page boundary. */
  async cancel(id: string): Promise<Scan> {
    const { db, queue } = this.deps;
    const updated = await db.scan.updateMany({
      where: { id, status: { in: [...ACTIVE] } },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    if (updated.count === 0) {
      const existing = await db.scan.findUnique({ where: { id }, select: { status: true } });
      if (!existing) throw notFound('Scan', id);
      throw new ApiError(
        'conflict',
        `This scan already ${existing.status}, so it cannot be cancelled.`,
        {
          status: existing.status,
        },
      );
    }
    await queue.remove(id);
    // Someone may be waiting for this cancellation, such as an n8n workflow. Announcing it must not
    // undo a cancellation that already happened.
    await queue.notifyFinished(id).catch(() => undefined);
    return this.get(id);
  }

  /** The completed scan this one is compared with. See `findPreviousScan`. */
  async previousCompleted(row: ScanRow) {
    return findPreviousScan(this.deps.db, row);
  }

  private async findByIdempotencyKey(key: string): Promise<ScanRow | null> {
    return this.deps.db.scan.findUnique({ where: { idempotencyKey: key }, include: scanInclude });
  }

  async assertReachablePublicly(url: string, field: 'url' | 'callbackUrl'): Promise<void> {
    try {
      await assertPublicUrl(url, {
        allowLocal: this.deps.config.ALLOW_LOCAL_TARGETS,
        ...(this.deps.resolver ? { resolver: this.deps.resolver } : {}),
      });
    } catch (error) {
      if (error instanceof UrlBlockedError) {
        throw new ApiError(
          'url_blocked',
          `${field === 'url' ? 'The site URL' : 'The callback URL'} cannot be used: ${error.message}`,
          { field, reason: error.reason },
        );
      }
      throw error;
    }
  }

  private async conflict(active: ScanRow): Promise<ApiError> {
    return new ApiError(
      'conflict',
      `A scan of ${active.hostname} is already ${active.status}. Wait for it to finish or cancel it first.`,
      { scan: await this.toDto(active) },
    );
  }
}
