import { describe, expect, it } from 'vitest';
import {
  average,
  computeProgress,
  describeProgress,
  formatDuration,
  formatEta,
  formatOrdinal,
  formatQueuePosition,
  pushRolling,
  smoothEta,
  type ProgressInput,
} from './progress.js';

const now = new Date('2026-09-18T10:44:00.000Z');
const startedAt = new Date(now.getTime() - 101_000);

function input(overrides: Partial<ProgressInput> = {}): ProgressInput {
  return {
    status: 'running',
    stage: 'pages',
    pagesFound: 214,
    pagesTotal: 214,
    pagesDone: 87,
    linksTotal: 1240,
    linksChecked: 0,
    avgPageMs: 5000,
    avgLinkMs: 200,
    pageConcurrency: 5,
    linkConcurrency: 10,
    seedDurationMs: null,
    progressPercent: 0,
    createdAt: new Date(startedAt.getTime() - 5000),
    startedAt,
    finishedAt: null,
    queuePosition: null,
    ...overrides,
  };
}

describe('computeProgress percent', () => {
  it('weights the page phase between 5 and 85', () => {
    expect(computeProgress(input({ pagesDone: 0 }), now).percent).toBe(5);
    expect(computeProgress(input({ pagesDone: 214 }), now).percent).toBe(85);
    expect(computeProgress(input({ pagesDone: 87 }), now).percent).toBe(38);
  });

  it('weights link verification between 85 and 98', () => {
    const base = { stage: 'links' as const, pagesDone: 214 };
    expect(computeProgress(input({ ...base, linksChecked: 0 }), now).percent).toBe(85);
    expect(computeProgress(input({ ...base, linksChecked: 620 }), now).percent).toBe(92);
    expect(computeProgress(input({ ...base, linksChecked: 1240 }), now).percent).toBe(98);
  });

  it('holds at 98 while finalising and only reaches 100 when completed', () => {
    expect(computeProgress(input({ stage: 'finalising' }), now).percent).toBe(98);
    const done = input({ status: 'completed', finishedAt: now, stage: null });
    expect(computeProgress(done, now).percent).toBe(100);
  });

  it('never goes backwards', () => {
    const progress = computeProgress(input({ pagesDone: 10, progressPercent: 60 }), now);
    expect(progress.percent).toBe(60);
  });

  it('never reports 100 for a running scan', () => {
    const progress = computeProgress(input({ progressPercent: 100 }), now);
    expect(progress.percent).toBe(99);
  });

  it('is zero while queued or discovering', () => {
    expect(computeProgress(input({ status: 'queued', stage: null }), now).percent).toBe(0);
    expect(computeProgress(input({ status: 'discovering', stage: null }), now).percent).toBe(0);
  });

  it('freezes failed and cancelled scans at their last value', () => {
    const failed = input({ status: 'failed', progressPercent: 41, finishedAt: now });
    expect(computeProgress(failed, now).percent).toBe(41);
    const cancelled = input({ status: 'cancelled', progressPercent: 12, finishedAt: now });
    expect(computeProgress(cancelled, now).percent).toBe(12);
  });

  it('treats a site with no pages as fully checked', () => {
    expect(computeProgress(input({ pagesTotal: 0, pagesDone: 0 }), now).percent).toBe(85);
  });
});

describe('computeProgress eta', () => {
  it('has no ETA while queued or discovering, and exposes the queue position', () => {
    const queued = computeProgress(
      input({ status: 'queued', stage: null, queuePosition: 2, startedAt: null }),
      now,
    );
    expect(queued.etaSeconds).toBeNull();
    expect(queued.estimating).toBe(false);
    expect(queued.queuePosition).toBe(2);
    expect(queued.phase).toBe('queued');

    const discovering = computeProgress(
      input({ status: 'discovering', stage: null, pagesFound: 143, pagesTotal: 0 }),
      now,
    );
    expect(discovering.etaSeconds).toBeNull();
    expect(discovering.pagesFound).toBe(143);
  });

  it('estimates during the first 10 pages instead of guessing', () => {
    const early = computeProgress(input({ pagesDone: 4 }), now);
    expect(early.etaSeconds).toBeNull();
    expect(early.estimating).toBe(true);
  });

  it('seeds the early ETA from the previous scan of the hostname', () => {
    const early = computeProgress(input({ pagesDone: 0, seedDurationMs: 240_000 }), now);
    expect(early.estimating).toBe(false);
    expect(early.etaSeconds).toBe(228);
  });

  it('uses the rolling page average divided by concurrency, plus link time', () => {
    // 127 pages left * 5s / 5 = 127s. 1240 links * 0.2s / 10 = 24.8s. Plus 5s finalising.
    const progress = computeProgress(input(), now);
    expect(progress.etaSeconds).toBe(157);
    expect(progress.estimating).toBe(false);
    expect(progress.estimatedFinishAt).toBe(new Date(now.getTime() + 157_000).toISOString());
  });

  it('adapts when pages get slower', () => {
    const fast = computeProgress(input({ avgPageMs: 2000 }), now).etaSeconds ?? 0;
    const slow = computeProgress(input({ avgPageMs: 8000 }), now).etaSeconds ?? 0;
    expect(slow).toBeGreaterThan(fast);
  });

  it('projects only link time once the link stage starts', () => {
    const progress = computeProgress(
      input({ stage: 'links', pagesDone: 214, linksChecked: 1000 }),
      now,
    );
    // 240 links * 0.2s / 10 = 4.8s, plus 5s.
    expect(progress.etaSeconds).toBe(10);
    expect(progress.phase).toBe('checking_links');
  });

  it('has no ETA once finished', () => {
    const done = computeProgress(input({ status: 'completed', stage: null, finishedAt: now }), now);
    expect(done.etaSeconds).toBeNull();
    expect(done.estimatedFinishAt).toBeNull();
    expect(done.elapsedSeconds).toBe(101);
  });
});

describe('computeProgress throughput', () => {
  it('derives pages per minute from the rolling average and concurrency', () => {
    expect(
      computeProgress(input({ avgPageMs: 5000, pageConcurrency: 5 }), now).pagesPerMinute,
    ).toBe(60);
  });

  it('falls back to overall throughput without a rolling average', () => {
    const progress = computeProgress(input({ avgPageMs: null, pagesDone: 50 }), now);
    expect(progress.pagesPerMinute).toBe(30);
  });
});

describe('rolling helpers', () => {
  it('keeps only the last 20 samples', () => {
    let window: number[] = [];
    for (let i = 1; i <= 25; i++) window = pushRolling(window, i);
    expect(window).toHaveLength(20);
    expect(window[0]).toBe(6);
    expect(average(window)).toBe(15.5);
    expect(average([])).toBeNull();
  });

  it('smooths ETA changes', () => {
    expect(smoothEta(null, 100)).toBe(100);
    expect(smoothEta(100, 200)).toBe(130);
    expect(smoothEta(100, null)).toBeNull();
  });
});

describe('formatting', () => {
  it('rounds ETAs for humans', () => {
    expect(formatEta(20)).toBe('less than a minute left');
    expect(formatEta(59)).toBe('less than a minute left');
    expect(formatEta(167)).toBe('about 3 min left');
    expect(formatEta(3600)).toBe('about 1 hr left');
    expect(formatEta(4800)).toBe('about 1 hr 20 min left');
  });

  it('formats exact durations', () => {
    expect(formatDuration(252)).toBe('4 min 12 s');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(120)).toBe('2 min');
    expect(formatDuration(3900)).toBe('1 hr 5 min');
  });

  it('formats queue positions', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(formatOrdinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
    ]);
    expect(formatQueuePosition(2)).toBe('2nd in queue');
  });

  it('describes progress in one line', () => {
    expect(
      describeProgress(computeProgress(input({ status: 'queued', queuePosition: 2 }), now)),
    ).toBe('2nd in queue');
    expect(
      describeProgress(
        computeProgress(
          input({ status: 'discovering', stage: null, pagesFound: 143, pagesTotal: 0 }),
          now,
        ),
      ),
    ).toBe('Discovering pages, 143 found so far');
    expect(describeProgress(computeProgress(input({ pagesDone: 2 }), now))).toBe('Estimating…');
    expect(describeProgress(computeProgress(input(), now))).toBe('about 3 min left');
    expect(
      describeProgress(
        computeProgress(
          input({
            status: 'completed',
            stage: null,
            startedAt: new Date(now.getTime() - 252_000),
            finishedAt: now,
          }),
          now,
        ),
      ),
    ).toBe('Completed in 4 min 12 s');
  });
});
