import {
  FixedIssuesResponseSchema,
  IdParamSchema,
  IssueSchema,
  ProgressEventSchema,
  type FixedIssuesResponse,
  type Issue,
  type ProgressEvent,
} from '@beacon/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../lib/openapi.js';
import { formatSse, SSE_HEARTBEAT, SSE_RETRY } from '../lib/sse.js';
import { comparisonLabels, listFixedIssues } from '../services/issues.js';
import { buildIssuesCsv, listReportGroups } from '../services/report-export.js';
import { buildReportPdf } from '../services/report-pdf.js';
import { toIssueDto, issueInclude } from '../services/scan-view.js';
import { ScanService } from '../services/scans.js';
import type { ScanQueue } from '../queue.js';
import type { HostResolver } from '@beacon/net';

export interface ScanExportRouteOptions {
  queue: ScanQueue;
  resolver: HostResolver | undefined;
  /** How often the event stream looks for changes. Tests shorten it. */
  eventIntervalMs?: number;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const HEARTBEAT_MS = 15_000;
/** A stream ends after this long and the browser reconnects, so no connection lives forever. */
const MAX_STREAM_MS = 60 * 60 * 1000;
const PDF_PROBLEM_LIMIT = 100;

const TRIGGER_LABELS: Record<string, string> = {
  manual_ui: 'Started from the dashboard',
  manual_api: 'Started through the API',
  scheduled: 'Scheduled check',
  n8n: 'Started by n8n',
  monday: 'Started from monday.com',
};

/** A file-name-safe fragment: letters, digits, dots and dashes only. */
function fileSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'scan';
}

export const scanExportRoutes: FastifyPluginAsyncZod<ScanExportRouteOptions> = async (
  app,
  options,
) => {
  const scans = new ScanService({
    db: app.db,
    config: app.config,
    queue: options.queue,
    resolver: options.resolver,
  });
  const view = { publicUrl: app.config.PUBLIC_URL };
  const intervalMs = options.eventIntervalMs ?? 1000;

  app.get(
    '/scans/:id/events',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Scans'],
        summary: 'Follow a scan live',
        description: [
          'A server-sent event stream. Works with a session cookie, so the dashboard can open it with `EventSource`.',
          '',
          '- `progress`: sent when progress or the summary changes (`ProgressEvent`).',
          '- `issue`: sent for each issue found after you connected (`Issue`). Fetch `/issues` for the ones already there.',
          '- `done`: the scan finished, failed or was cancelled, with the final state. The stream then closes.',
          '',
          'A comment line is sent every 15 seconds so proxies keep the connection open. Behind a reverse proxy, turn response buffering off for this path.',
        ].join('\n'),
        produces: ['text/event-stream'],
        params: IdParamSchema,
        response: {
          200: z.string().meta({ description: 'The event stream.' }),
          ...errorResponses(401, 403, 404, 429),
        },
      },
    },
    async (request, reply) => {
      // 404 and auth failures are answered normally, before the connection becomes a stream.
      const first = await scans.getRow(request.params.id);
      const scanId = first.id;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // nginx buffers responses unless told not to, which would hold every event back.
        'x-accel-buffering': 'no',
        'x-request-id': request.id,
      });
      raw.write(SSE_RETRY);

      let closed = false;
      let wake: (() => void) | undefined;
      request.raw.on('close', () => {
        closed = true;
        wake?.();
      });
      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });

      // Only issues found from now on are pushed. The page loads the ones already there.
      let after: { createdAt: Date; id: string } | null = await app.db.scanIssue.findFirst({
        where: { scanId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true, id: true },
      });
      let lastProgress = '';
      let lastWrite = Date.now();
      const startedAt = Date.now();
      const send = (chunk: string) => {
        raw.write(chunk);
        lastWrite = Date.now();
      };

      try {
        while (!closed && Date.now() - startedAt < MAX_STREAM_MS) {
          const scan = await scans.get(scanId);
          const event: ProgressEvent = {
            scanId,
            status: scan.status,
            progress: scan.progress,
            summary: scan.summary,
          };
          const snapshot = JSON.stringify(event);
          if (snapshot !== lastProgress) {
            lastProgress = snapshot;
            send(formatSse('progress', event));
          }

          const finished = TERMINAL.has(scan.status);
          for (;;) {
            const cursor = after;
            const fresh = await app.db.scanIssue.findMany({
              where: {
                scanId,
                ...(cursor
                  ? {
                      OR: [
                        { createdAt: { gt: cursor.createdAt } },
                        { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                      ],
                    }
                  : {}),
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              include: issueInclude,
              take: 50,
            });
            if (fresh.length === 0) break;
            const labels = await comparisonLabels(app.db, first, [
              ...new Set(fresh.map((issue) => issue.fingerprint)),
            ]);
            for (const issue of fresh) {
              const dto: Issue = toIssueDto(issue, view, labels?.get(issue.fingerprint) ?? null);
              send(formatSse('issue', IssueSchema.parse(dto)));
            }
            const last = fresh[fresh.length - 1];
            if (last) after = { createdAt: last.createdAt, id: last.id };
            if (fresh.length < 50) break;
          }

          if (finished) {
            send(formatSse('done', ProgressEventSchema.parse(event)));
            break;
          }
          if (Date.now() - lastWrite >= HEARTBEAT_MS) send(SSE_HEARTBEAT);
          await pause(intervalMs);
        }
      } catch (error) {
        // The stream cannot carry an error envelope once it has started. Closing it makes the
        // browser reconnect, and a scan that is really gone answers 404 on that attempt.
        request.log.warn({ err: error }, 'scan event stream ended');
      } finally {
        if (!raw.writableEnded) raw.end();
      }
    },
  );

  app.get(
    '/scans/:id/fixed',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Issues'],
        summary: 'Problems fixed since the previous check',
        description:
          'Problems the previous completed check had and this scan does not. For a scan of a sample, only pages checked both times count: a page that was not looked at again is unseen, not fixed. Empty for a scan that has not completed or has nothing to compare with.',
        params: IdParamSchema,
        response: { 200: FixedIssuesResponseSchema, ...errorResponses(401, 403, 404, 429) },
      },
    },
    async (request): Promise<FixedIssuesResponse> => {
      const row = await scans.getRow(request.params.id);
      if (row.status !== 'completed') return { items: [] };
      const previous = await scans.previousCompleted(row);
      if (!previous) return { items: [] };
      return { items: await listFixedIssues(app.db, row, previous.id) };
    },
  );

  app.get(
    '/scans/:id/export.csv',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Scans'],
        summary: 'Export issues as CSV',
        description:
          'Every issue of the scan, open and ignored, one row per occurrence, most severe first. UTF-8 with a byte order mark so Excel reads it correctly. Cells that would run as a spreadsheet formula are prefixed with an apostrophe.',
        produces: ['text/csv'],
        params: IdParamSchema,
        response: {
          200: z.string().meta({ description: 'The CSV file.' }),
          ...errorResponses(401, 403, 404, 429),
        },
      },
    },
    async (request, reply) => {
      const row = await scans.getRow(request.params.id);
      const body = await buildIssuesCsv(app.db, row.id);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="beacon-${fileSafe(row.hostname)}-check-${row.runNumber}.csv"`,
        )
        .header('cache-control', 'private, no-store')
        .send(body);
    },
  );

  app.get(
    '/scans/:id/export.pdf',
    {
      config: { auth: 'scans:read' },
      schema: {
        tags: ['Scans'],
        summary: 'Export a report as PDF',
        description: `The summary and the open problems, one entry per problem with the pages it affects. Lists up to ${PDF_PROBLEM_LIMIT} problems, most severe first. The CSV export has every issue.`,
        produces: ['application/pdf'],
        params: IdParamSchema,
        response: {
          200: z.string().meta({ format: 'binary' }),
          ...errorResponses(401, 403, 404, 429),
        },
      },
    },
    async (request, reply) => {
      const row = await scans.getRow(request.params.id);
      const detail = await scans.getDetail(row.id);
      const { groups, omitted } = await listReportGroups(app.db, row.id, PDF_PROBLEM_LIMIT);
      const pdf = await buildReportPdf({
        title: row.website?.name ?? row.hostname,
        url: row.url,
        runNumber: row.runNumber,
        status: row.status,
        finishedAt: row.finishedAt,
        healthScore: detail.summary.healthScore,
        scoreChange: detail.scoreChange,
        pages: detail.summary.pages,
        critical: detail.summary.critical,
        warnings: detail.summary.warnings,
        passed: detail.summary.passed,
        checks: detail.checks,
        kind: `${row.website ? 'Website check' : 'One-off scan'}, ${TRIGGER_LABELS[row.triggeredByType]?.toLowerCase() ?? row.triggeredByType}`,
        groups,
        omittedGroups: omitted,
      });
      return (
        reply
          .header('content-type', 'application/pdf')
          .header(
            'content-disposition',
            `attachment; filename="beacon-${fileSafe(row.hostname)}-check-${row.runNumber}.pdf"`,
          )
          .header('cache-control', 'private, no-store')
          // The response schema describes a binary body for OpenAPI. Fastify sends a Buffer as is.
          .send(pdf as never)
      );
    },
  );
};
