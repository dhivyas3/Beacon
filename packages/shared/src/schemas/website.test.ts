import { describe, expect, it } from 'vitest';
import { CreateScanBodySchema } from './scan.js';
import {
  CreateWebsiteBodySchema,
  UpdateWebsiteBodySchema,
  websiteConfigProblems,
  type WebsiteConfig,
} from './website.js';

const config = (overrides: Partial<WebsiteConfig> = {}): WebsiteConfig => ({
  url: 'https://www.example.com/',
  checkFrequency: 'monthly',
  scheduleDayOfWeek: null,
  scheduleDayOfMonth: 1,
  pageSelectionMode: 'random_sample',
  staticPageUrls: [],
  pinnedPageUrls: [],
  sampleSize: 8,
  enabledChecks: ['images'],
  ...overrides,
});

const fields = (overrides: Partial<WebsiteConfig>): string[] =>
  websiteConfigProblems(config(overrides)).map((problem) => problem.field);

describe('websiteConfigProblems', () => {
  it('accepts a sound configuration', () => {
    expect(websiteConfigProblems(config())).toEqual([]);
  });

  it('needs a day for weekly and monthly schedules', () => {
    expect(fields({ checkFrequency: 'weekly', scheduleDayOfWeek: null })).toEqual([
      'scheduleDayOfWeek',
    ]);
    expect(fields({ checkFrequency: 'monthly', scheduleDayOfMonth: null })).toEqual([
      'scheduleDayOfMonth',
    ]);
    expect(fields({ checkFrequency: 'daily', scheduleDayOfMonth: null })).toEqual([]);
    expect(fields({ checkFrequency: 'manual', scheduleDayOfMonth: null })).toEqual([]);
  });

  it('needs at least one check', () => {
    expect(fields({ enabledChecks: [] })).toEqual(['enabledChecks']);
  });

  it('needs pages for a static list, and only for a static list', () => {
    expect(fields({ pageSelectionMode: 'static_list', staticPageUrls: [] })).toEqual([
      'staticPageUrls',
    ]);
    expect(fields({ pageSelectionMode: 'random_sample', staticPageUrls: [] })).toEqual([]);
    expect(fields({ pageSelectionMode: 'full', staticPageUrls: [] })).toEqual([]);
  });

  it('keeps the sample size within range, but only for a sample', () => {
    expect(fields({ sampleSize: 0 })).toEqual(['sampleSize']);
    expect(fields({ sampleSize: 101 })).toEqual(['sampleSize']);
    expect(fields({ sampleSize: 100 })).toEqual([]);
    expect(fields({ pageSelectionMode: 'full', sampleSize: 0 })).toEqual([]);
  });

  it('keeps listed and pinned pages on the website, comparing origins', () => {
    expect(
      fields({
        pageSelectionMode: 'static_list',
        staticPageUrls: ['https://www.example.com/contact/', 'https://www.example.com/a?utm_x=1'],
      }),
    ).toEqual([]);
    const problems = websiteConfigProblems(
      config({
        pageSelectionMode: 'static_list',
        staticPageUrls: ['https://other.example.org/x', 'http://www.example.com/insecure'],
        pinnedPageUrls: ['https://evil.test/'],
      }),
    );
    expect(problems.map((p) => p.field).sort()).toEqual(['pinnedPageUrls', 'staticPageUrls']);
    expect(problems.find((p) => p.field === 'staticPageUrls')?.message).toContain(
      'https://other.example.org/x',
    );
  });

  it('reports every problem at once', () => {
    expect(
      fields({
        checkFrequency: 'weekly',
        scheduleDayOfWeek: null,
        enabledChecks: [],
        sampleSize: 0,
      }),
    ).toEqual(['scheduleDayOfWeek', 'enabledChecks', 'sampleSize']);
  });
});

describe('CreateWebsiteBodySchema', () => {
  const minimal = { name: 'Example', url: 'https://www.example.com' };

  it('fills in sensible defaults: weekly, a sample of 10, validate-only forms, every check', () => {
    const body = CreateWebsiteBodySchema.parse(minimal);
    expect(body).toMatchObject({
      checkFrequency: 'weekly',
      scheduleDayOfWeek: 1,
      scheduleHourUtc: 6,
      pageSelectionMode: 'random_sample',
      sampleSize: 10,
      formMode: 'validate_only',
      isActive: true,
      staticPageUrls: [],
      pinnedPageUrls: [],
      recipients: [],
    });
    expect(body.enabledChecks).toHaveLength(6);
  });

  it('accepts the monthly, eight random pages, two recipients configuration', () => {
    const body = CreateWebsiteBodySchema.parse({
      ...minimal,
      checkFrequency: 'monthly',
      scheduleDayOfMonth: 1,
      sampleSize: 8,
      recipients: [{ email: 'a@example.com' }, { email: 'b@example.com', name: 'B' }],
    });
    expect(body.recipients).toHaveLength(2);
  });

  it('rejects bad input with a message per field', () => {
    for (const [input, path] of [
      [{ ...minimal, name: '   ' }, 'name'],
      [{ ...minimal, url: 'ftp://x.test' }, 'url'],
      [{ ...minimal, scheduleHourUtc: 24 }, 'scheduleHourUtc'],
      [{ ...minimal, checkFrequency: 'hourly' }, 'checkFrequency'],
      [{ ...minimal, sampleSize: 500 }, 'sampleSize'],
      [{ ...minimal, recipients: [{ email: 'not-an-email' }] }, 'recipients'],
      [{ ...minimal, pageSelectionMode: 'static_list' }, 'staticPageUrls'],
    ] as const) {
      const result = CreateWebsiteBodySchema.safeParse(input);
      expect(result.success, JSON.stringify(input)).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path[0])).toContain(path);
    }
  });

  it('limits how many recipients, pages and pinned pages there can be', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://www.example.com/p${i}`);
    expect(
      CreateWebsiteBodySchema.safeParse({
        ...minimal,
        recipients: Array.from({ length: 21 }, (_, i) => ({ email: `u${i}@example.com` })),
      }).success,
    ).toBe(false);
    expect(
      CreateWebsiteBodySchema.safeParse({ ...minimal, pinnedPageUrls: many(21) }).success,
    ).toBe(false);
    expect(
      CreateWebsiteBodySchema.safeParse({
        ...minimal,
        pageSelectionMode: 'static_list',
        staticPageUrls: many(51),
      }).success,
    ).toBe(false);
  });
});

describe('UpdateWebsiteBodySchema', () => {
  it('accepts any subset of fields, and applies no defaults', () => {
    expect(UpdateWebsiteBodySchema.parse({})).toEqual({});
    expect(UpdateWebsiteBodySchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(UpdateWebsiteBodySchema.safeParse({ scheduleHourUtc: 30 }).success).toBe(false);
  });
});

describe('CreateScanBodySchema with a website', () => {
  it('needs a url or a websiteId', () => {
    expect(CreateScanBodySchema.safeParse({}).success).toBe(false);
    expect(CreateScanBodySchema.safeParse({ url: 'https://www.example.com' }).success).toBe(true);
    expect(CreateScanBodySchema.safeParse({ websiteId: 'web_a1B2c3D4e5F6' }).success).toBe(true);
  });

  it('only allows n8n and monday as a source', () => {
    const base = { websiteId: 'web_a1B2c3D4e5F6' };
    expect(CreateScanBodySchema.safeParse({ ...base, source: 'n8n' }).success).toBe(true);
    expect(CreateScanBodySchema.safeParse({ ...base, source: 'monday' }).success).toBe(true);
    expect(CreateScanBodySchema.safeParse({ ...base, source: 'scheduled' }).success).toBe(false);
  });
});
