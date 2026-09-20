import { describe, expect, it } from 'vitest';
import { CommonEnvSchema, EnvError, parseEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  WEBHOOK_SIGNING_SECRET: 'a-long-enough-secret-value',
};

describe('parseEnv', () => {
  it('applies documented defaults', () => {
    const env = parseEnv(CommonEnvSchema, valid);
    expect(env.MAX_PAGES).toBe(2000);
    expect(env.PAGE_CONCURRENCY).toBe(5);
    expect(env.MAX_CONCURRENT_SCANS).toBe(3);
    expect(env.ALLOW_LOCAL_TARGETS).toBe(false);
    expect(env.STAGING_PATTERNS).toContain('.netlify.app');
    expect(env.DEFAULT_CHECKS).toHaveLength(6);
  });

  it('parses booleans, numbers and lists', () => {
    const env = parseEnv(CommonEnvSchema, {
      ...valid,
      ALLOW_LOCAL_TARGETS: 'true',
      MAX_PAGES: '50',
      STAGING_PATTERNS: 'test., .preview.app',
      DEFAULT_CHECKS: 'images, seo',
    });
    expect(env.ALLOW_LOCAL_TARGETS).toBe(true);
    expect(env.MAX_PAGES).toBe(50);
    expect(env.STAGING_PATTERNS).toEqual(['test.', '.preview.app']);
    expect(env.DEFAULT_CHECKS).toEqual(['images', 'seo']);
  });

  it('reports every problem in one error', () => {
    try {
      parseEnv(CommonEnvSchema, { WEBHOOK_SIGNING_SECRET: 'short', MAX_PAGES: '0' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const issues = (error as EnvError).issues.join('\n');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('WEBHOOK_SIGNING_SECRET');
      expect(issues).toContain('MAX_PAGES');
    }
  });
});
