import { z } from 'zod';
import { EXAMPLE_PROGRESS } from './examples.js';

export const PROGRESS_PHASES = [
  'queued',
  'discovering',
  'running',
  'checking_links',
  'finalising',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ProgressPhase = (typeof PROGRESS_PHASES)[number];

export const PHASE_LABELS: Record<ProgressPhase, string> = {
  queued: 'Queued',
  discovering: 'Discovering pages',
  running: 'Checking pages',
  checking_links: 'Verifying links',
  finalising: 'Finalising',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const ProgressSchema = z
  .object({
    phase: z.enum(PROGRESS_PHASES),
    percent: z.number().int().min(0).max(100).describe('Monotonic. 100 only when completed.'),
    pagesFound: z.number().int().min(0).describe('Pages discovered so far.'),
    pagesDone: z.number().int().min(0),
    pagesTotal: z.number().int().min(0),
    linksChecked: z.number().int().min(0),
    linksTotal: z.number().int().min(0),
    pagesPerMinute: z.number().min(0),
    elapsedSeconds: z.number().int().min(0),
    etaSeconds: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Null while queued, discovering, estimating or finished.'),
    estimating: z.boolean().describe('True while there is not yet enough data for an ETA.'),
    estimatedFinishAt: z.iso.datetime().nullable(),
    queuePosition: z.number().int().min(1).nullable().describe('1-based, only while queued.'),
  })
  .meta({ id: 'Progress', example: EXAMPLE_PROGRESS });
export type Progress = z.infer<typeof ProgressSchema>;
