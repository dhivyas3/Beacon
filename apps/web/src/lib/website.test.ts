import { describe, expect, it } from 'vitest';
import {
  describePageSelection,
  describeScheduleLocal,
  localTimeOfUtcHour,
  parseUrlLines,
} from './website';

describe('describePageSelection', () => {
  it('says what a check covers in words', () => {
    const base = { sampleSize: 8, pinnedPageUrls: [], staticPageUrls: [] };
    expect(describePageSelection({ ...base, pageSelectionMode: 'full' })).toBe('Every page');
    expect(describePageSelection({ ...base, pageSelectionMode: 'random_sample' })).toBe(
      '8 random pages, homepage always included',
    );
    expect(
      describePageSelection({
        ...base,
        pageSelectionMode: 'random_sample',
        pinnedPageUrls: ['https://a.example.com/x'],
      }),
    ).toBe('8 random pages, homepage always included, plus 1 pinned');
    expect(
      describePageSelection({
        ...base,
        pageSelectionMode: 'static_list',
        staticPageUrls: ['https://a.example.com/'],
      }),
    ).toBe('1 chosen page');
  });
});

describe('localTimeOfUtcHour', () => {
  const summer = new Date('2026-07-15T12:00:00Z');
  const winter = new Date('2026-01-15T12:00:00Z');

  it('converts to the viewer time zone, including daylight saving', () => {
    expect(localTimeOfUtcHour(6, summer, 'Europe/London')).toBe('07:00 BST');
    expect(localTimeOfUtcHour(6, summer, 'Asia/Kolkata')).toBe('11:30 GMT+5:30');
  });

  it('says nothing when the time reads the same as UTC', () => {
    expect(localTimeOfUtcHour(6, winter, 'Europe/London')).toBeNull();
    expect(localTimeOfUtcHour(6, summer, 'UTC')).toBeNull();
  });
});

describe('describeScheduleLocal', () => {
  it('adds the local time to the UTC sentence, and leaves manual alone', () => {
    const at = new Date('2026-07-15T12:00:00Z');
    expect(
      describeScheduleLocal(
        {
          checkFrequency: 'monthly',
          scheduleDayOfWeek: null,
          scheduleDayOfMonth: 1,
          scheduleHourUtc: 6,
        },
        at,
        'Europe/London',
      ),
    ).toBe('Monthly on the 1st at 06:00 UTC (07:00 BST)');
    expect(
      describeScheduleLocal(
        {
          checkFrequency: 'manual',
          scheduleDayOfWeek: null,
          scheduleDayOfMonth: null,
          scheduleHourUtc: 6,
        },
        at,
        'Europe/London',
      ),
    ).toBe('Only when started manually');
  });
});

describe('parseUrlLines', () => {
  it('reads one address per line, resolves paths and drops repeats and blanks', () => {
    const result = parseUrlLines(
      'https://www.example.com/about\n\n  /contact  \n/contact\nhttps://www.example.com/about\n',
      'https://www.example.com/',
    );
    expect(result.invalid).toEqual([]);
    expect(result.urls).toEqual([
      'https://www.example.com/about',
      'https://www.example.com/contact',
    ]);
  });

  it('reports lines that are not addresses', () => {
    const result = parseUrlLines(
      'not a url\nftp://www.example.com/x\n/ok',
      'https://www.example.com',
    );
    expect(result.invalid).toEqual(['not a url', 'ftp://www.example.com/x']);
    expect(result.urls).toEqual(['https://www.example.com/ok']);
  });
});
