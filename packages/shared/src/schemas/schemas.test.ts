import { describe, expect, it } from 'vitest';
import { CreateAllowedDomainBodySchema } from './domain.js';
import { CreateScanBodySchema } from './scan.js';
import { WebhookPayloadSchema } from './events.js';
import { LoginBodySchema } from './auth.js';

describe('CreateScanBodySchema', () => {
  it('accepts a minimal body', () => {
    expect(CreateScanBodySchema.safeParse({ url: 'https://example.com' }).success).toBe(true);
  });

  it('rejects non-http URLs', () => {
    expect(CreateScanBodySchema.safeParse({ url: 'ftp://example.com' }).success).toBe(false);
    expect(CreateScanBodySchema.safeParse({ url: 'example.com' }).success).toBe(false);
  });

  it('rejects unknown checks and empty check lists', () => {
    expect(
      CreateScanBodySchema.safeParse({ url: 'https://example.com', checks: ['nope'] }).success,
    ).toBe(false);
    expect(CreateScanBodySchema.safeParse({ url: 'https://example.com', checks: [] }).success).toBe(
      false,
    );
  });

  it('rejects oversized metadata', () => {
    const metadata = { blob: 'x'.repeat(9000) };
    expect(CreateScanBodySchema.safeParse({ url: 'https://example.com', metadata }).success).toBe(
      false,
    );
  });

  it('accepts the documented example', () => {
    const parsed = CreateScanBodySchema.safeParse({
      url: 'https://www.example-estates.co.uk',
      checks: ['images', 'links', 'seo'],
      formMode: 'detect',
      callbackUrl: 'https://n8n.example.com/webhook/qa-hub-callback',
      metadata: { mondayItemId: '1234567890' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('CreateAllowedDomainBodySchema', () => {
  it('accepts exact and wildcard hostnames and lowercases them', () => {
    const exact = CreateAllowedDomainBodySchema.parse({ hostname: 'Example.com' });
    expect(exact.hostname).toBe('example.com');
    expect(CreateAllowedDomainBodySchema.safeParse({ hostname: '*.example.com' }).success).toBe(
      true,
    );
  });

  it('rejects URLs, paths and bad wildcards', () => {
    for (const hostname of ['https://example.com', 'example.com/path', 'exa*mple.com', '']) {
      expect(CreateAllowedDomainBodySchema.safeParse({ hostname }).success).toBe(false);
    }
  });
});

describe('LoginBodySchema', () => {
  it('normalises the email', () => {
    const parsed = LoginBodySchema.parse({ email: ' Admin@Example.com ', password: 'x' });
    expect(parsed.email).toBe('admin@example.com');
  });
});

describe('WebhookPayloadSchema', () => {
  it('validates the documented payload', () => {
    const parsed = WebhookPayloadSchema.safeParse({
      event: 'scan.completed',
      id: 'scn_a1B2c3D4e5F6',
      status: 'completed',
      url: 'https://example.com',
      summary: { healthScore: 82, pages: 214, critical: 6, warnings: 41 },
      reportUrl: 'https://qa.example.com/scans/scn_a1B2c3D4e5F6',
      metadata: null,
    });
    expect(parsed.success).toBe(true);
  });
});
