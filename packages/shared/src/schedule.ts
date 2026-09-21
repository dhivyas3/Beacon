import type { CheckFrequency } from './constants.js';

/** The part of a website that says when it is checked. Times are UTC. */
export interface Schedule {
  checkFrequency: CheckFrequency;
  /** 0 is Sunday. Used by `weekly`. */
  scheduleDayOfWeek: number | null;
  /** 1 to 31. Used by `monthly`, and clamped to the last day of shorter months. */
  scheduleDayOfMonth: number | null;
  /** 0 to 23. */
  scheduleHourUtc: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysInMonthUtc(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The first scheduled moment strictly after `from`, or null for a `manual` website.
 *
 * Monthly schedules on the 29th, 30th or 31st run on the last day of months that are shorter, so a
 * "31st" website is checked every month rather than skipping February.
 */
export function computeNextCheckAt(schedule: Schedule, from: Date): Date | null {
  const hour = schedule.scheduleHourUtc;
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();

  switch (schedule.checkFrequency) {
    case 'manual':
      return null;

    case 'daily': {
      const today = Date.UTC(year, month, day, hour);
      return new Date(today > from.getTime() ? today : today + DAY_MS);
    }

    case 'weekly': {
      const wanted = schedule.scheduleDayOfWeek ?? 1;
      const ahead = (wanted - from.getUTCDay() + 7) % 7;
      const candidate = Date.UTC(year, month, day + ahead, hour);
      return new Date(candidate > from.getTime() ? candidate : candidate + 7 * DAY_MS);
    }

    case 'monthly': {
      const wanted = schedule.scheduleDayOfMonth ?? 1;
      for (let offset = 0; offset < 2; offset += 1) {
        // Date.UTC rolls a month index past 11 into the next year.
        const target = new Date(Date.UTC(year, month + offset, 1));
        const candidate = Date.UTC(
          target.getUTCFullYear(),
          target.getUTCMonth(),
          Math.min(wanted, daysInMonthUtc(target.getUTCFullYear(), target.getUTCMonth())),
          hour,
        );
        if (candidate > from.getTime()) return new Date(candidate);
      }
      // Unreachable: next month's candidate is always in the future.
      return null;
    }
  }
}

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** A sentence for the schedule, in UTC, such as "Weekly on Monday at 06:00 UTC". */
export function describeSchedule(schedule: Schedule): string {
  const time = `${String(schedule.scheduleHourUtc).padStart(2, '0')}:00 UTC`;
  switch (schedule.checkFrequency) {
    case 'manual':
      return 'Only when started manually';
    case 'daily':
      return `Daily at ${time}`;
    case 'weekly':
      return `Weekly on ${WEEKDAYS[schedule.scheduleDayOfWeek ?? 1] ?? 'Monday'} at ${time}`;
    case 'monthly':
      return `Monthly on the ${ordinal(schedule.scheduleDayOfMonth ?? 1)} at ${time}`;
  }
}
