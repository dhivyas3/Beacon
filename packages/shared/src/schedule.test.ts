import { describe, expect, it } from 'vitest';
import { computeNextCheckAt, daysInMonthUtc, describeSchedule, type Schedule } from './schedule.js';

const at = (iso: string): Date => new Date(iso);
const schedule = (overrides: Partial<Schedule>): Schedule => ({
  checkFrequency: 'daily',
  scheduleDayOfWeek: null,
  scheduleDayOfMonth: null,
  scheduleHourUtc: 6,
  ...overrides,
});
const next = (s: Schedule, from: string): string | null =>
  computeNextCheckAt(s, at(from))?.toISOString() ?? null;

describe('computeNextCheckAt', () => {
  it('is null for a manual website', () => {
    expect(next(schedule({ checkFrequency: 'manual' }), '2026-09-21T10:00:00Z')).toBeNull();
  });

  describe('daily', () => {
    it('uses today when the hour has not passed yet', () => {
      expect(next(schedule({}), '2026-09-21T05:59:59Z')).toBe('2026-09-21T06:00:00.000Z');
    });
    it('uses tomorrow when the hour has passed, and when it is exactly now', () => {
      expect(next(schedule({}), '2026-09-21T06:00:01Z')).toBe('2026-09-22T06:00:00.000Z');
      expect(next(schedule({}), '2026-09-21T06:00:00Z')).toBe('2026-09-22T06:00:00.000Z');
    });
    it('rolls over month and year ends', () => {
      expect(next(schedule({}), '2026-12-31T23:00:00Z')).toBe('2027-01-01T06:00:00.000Z');
    });
  });

  describe('weekly', () => {
    const weekly = (day: number) => schedule({ checkFrequency: 'weekly', scheduleDayOfWeek: day });

    it('finds the next matching weekday', () => {
      // 21 Sep 2026 is a Monday.
      expect(next(weekly(3), '2026-09-21T10:00:00Z')).toBe('2026-09-23T06:00:00.000Z');
      expect(next(weekly(0), '2026-09-21T10:00:00Z')).toBe('2026-09-27T06:00:00.000Z');
    });
    it('uses today if it is the day and the hour is ahead, otherwise next week', () => {
      expect(next(weekly(1), '2026-09-21T05:00:00Z')).toBe('2026-09-21T06:00:00.000Z');
      expect(next(weekly(1), '2026-09-21T06:00:00Z')).toBe('2026-09-28T06:00:00.000Z');
      expect(next(weekly(1), '2026-09-21T10:00:00Z')).toBe('2026-09-28T06:00:00.000Z');
    });
    it('crosses a month and year boundary', () => {
      expect(next(weekly(5), '2026-12-30T10:00:00Z')).toBe('2027-01-01T06:00:00.000Z');
    });
    it('defaults to Monday when no day is stored', () => {
      expect(next(schedule({ checkFrequency: 'weekly' }), '2026-09-22T10:00:00Z')).toBe(
        '2026-09-28T06:00:00.000Z',
      );
    });
  });

  describe('monthly', () => {
    const monthly = (day: number, hour = 6) =>
      schedule({ checkFrequency: 'monthly', scheduleDayOfMonth: day, scheduleHourUtc: hour });

    it('uses this month when the day is still ahead, next month when it has passed', () => {
      expect(next(monthly(25), '2026-09-21T10:00:00Z')).toBe('2026-09-25T06:00:00.000Z');
      expect(next(monthly(5), '2026-09-21T10:00:00Z')).toBe('2026-10-05T06:00:00.000Z');
    });
    it('uses today only when the hour is still ahead', () => {
      expect(next(monthly(21, 12), '2026-09-21T10:00:00Z')).toBe('2026-09-21T12:00:00.000Z');
      expect(next(monthly(21, 9), '2026-09-21T10:00:00Z')).toBe('2026-10-21T09:00:00.000Z');
    });
    it('clamps to the last day of shorter months', () => {
      expect(next(monthly(31), '2026-02-01T00:00:00Z')).toBe('2026-02-28T06:00:00.000Z');
      expect(next(monthly(31), '2026-04-10T00:00:00Z')).toBe('2026-04-30T06:00:00.000Z');
      expect(next(monthly(30), '2026-01-31T10:00:00Z')).toBe('2026-02-28T06:00:00.000Z');
    });
    it('knows leap years', () => {
      expect(next(monthly(31), '2028-02-01T00:00:00Z')).toBe('2028-02-29T06:00:00.000Z');
      expect(next(monthly(29), '2027-02-01T00:00:00Z')).toBe('2027-02-28T06:00:00.000Z');
    });
    it('rolls from December into January', () => {
      expect(next(monthly(1), '2026-12-15T00:00:00Z')).toBe('2027-01-01T06:00:00.000Z');
    });
    it('never returns a time that is not after the starting point', () => {
      for (const day of [1, 15, 28, 29, 30, 31]) {
        for (let m = 0; m < 24; m += 1) {
          const from = new Date(Date.UTC(2026, m, 28, 6));
          const result = computeNextCheckAt(monthly(day), from);
          expect(result).not.toBeNull();
          expect((result as Date).getTime()).toBeGreaterThan(from.getTime());
        }
      }
    });
  });
});

describe('daysInMonthUtc', () => {
  it('handles every month length and leap years', () => {
    expect(daysInMonthUtc(2026, 0)).toBe(31);
    expect(daysInMonthUtc(2026, 1)).toBe(28);
    expect(daysInMonthUtc(2028, 1)).toBe(29);
    expect(daysInMonthUtc(2100, 1)).toBe(28);
    expect(daysInMonthUtc(2026, 3)).toBe(30);
  });
});

describe('describeSchedule', () => {
  it('reads as a sentence', () => {
    expect(describeSchedule(schedule({ checkFrequency: 'manual' }))).toBe(
      'Only when started manually',
    );
    expect(describeSchedule(schedule({}))).toBe('Daily at 06:00 UTC');
    expect(describeSchedule(schedule({ checkFrequency: 'weekly', scheduleDayOfWeek: 3 }))).toBe(
      'Weekly on Wednesday at 06:00 UTC',
    );
    for (const [day, text] of [
      [1, '1st'],
      [2, '2nd'],
      [3, '3rd'],
      [4, '4th'],
      [11, '11th'],
      [12, '12th'],
      [21, '21st'],
      [22, '22nd'],
      [31, '31st'],
    ] as const) {
      expect(
        describeSchedule(
          schedule({ checkFrequency: 'monthly', scheduleDayOfMonth: day, scheduleHourUtc: 9 }),
        ),
      ).toBe(`Monthly on the ${text} at 09:00 UTC`);
    }
  });
});
