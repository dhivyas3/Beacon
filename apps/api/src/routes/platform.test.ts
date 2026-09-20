import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authPlugin } from '../plugins/auth.js';
import { bearer, createTestApp, errorOf, type TestApp } from '../test/helpers.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

describe('error conventions', () => {
  it('answers unknown routes with a JSON 404', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope?x=1' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'Route GET /api/v1/nope does not exist.' },
    });
  });

  it('puts a request id on every response, including errors', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/scans' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(errorOf(res).code).toBe('unauthorized');
  });

  it('never leaks internals on unexpected failures', async () => {
    // A dedicated app, because the database client is deliberately broken for this test.
    const broken = await createTestApp();
    try {
      const { key } = await broken.createApiKey();
      vi.spyOn(broken.db.scan, 'findMany').mockImplementation(() => {
        throw new Error('connection string postgresql://secret@host exploded');
      });
      const res = await broken.app.inject({
        method: 'GET',
        url: '/api/v1/scans',
        headers: bearer(key),
      });
      expect(res.statusCode).toBe(500);
      expect(errorOf(res).code).toBe('internal_error');
      expect(res.body).not.toContain('secret');
    } finally {
      vi.restoreAllMocks();
      await broken.close();
    }
  });

  it('refuses to start when a route forgets to declare its auth requirement', async () => {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(authPlugin);
    expect(() => app.get('/api/v1/oops', async () => ({ ok: true }))).toThrow(
      /must declare config\.auth/,
    );
    await app.close();
  });
});

describe('rate limiting', () => {
  it('limits per API key and answers 429 in the standard envelope', async () => {
    const limited = await createTestApp({ RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const a = await limited.createApiKey();
      const b = await limited.createApiKey();
      const call = (key: string) =>
        limited.app.inject({ method: 'GET', url: '/api/v1/scans', headers: bearer(key) });

      for (let i = 0; i < 3; i++) expect((await call(a.key)).statusCode).toBe(200);
      const blocked = await call(a.key);
      expect(blocked.statusCode).toBe(429);
      expect(errorOf(blocked)).toMatchObject({
        code: 'rate_limited',
        details: { limit: 3, retryAfterSeconds: expect.any(Number) },
      });
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.headers['x-ratelimit-limit']).toBe('3');

      // Another key has its own budget.
      expect((await call(b.key)).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('does not rate limit health probes', async () => {
    const limited = await createTestApp({ RATE_LIMIT_PER_MINUTE: '1' });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await limited.app.inject({ method: 'GET', url: '/api/v1/health' });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await limited.close();
    }
  });
});

describe('settings', () => {
  it('returns environment defaults with the secret masked', async () => {
    const { key } = await ctx.createApiKey(['scans:read']);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: bearer(key),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      defaultFormMode: 'detect',
      maxPages: 2000,
      pageConcurrency: 5,
      formTestEmail: 'qa-test@example.com',
    });
    expect(body.webhookSecretPreview).toMatch(/^•{8}6789$/);
    expect(res.body).not.toContain('test-signing-secret');
  });

  it('lets an admin change defaults and applies them to new scans', async () => {
    const admin = await ctx.adminCookie();
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { cookie: admin },
      payload: { defaultChecks: ['seo', 'links'], defaultFormMode: 'validate_only' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      defaultChecks: ['seo', 'links'],
      defaultFormMode: 'validate_only',
    });

    await ctx.allowDomain('defaults.example.com');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/scans',
      headers: { cookie: admin },
      payload: { url: 'https://defaults.example.com' },
    });
    const scan = await ctx.db.scan.findUniqueOrThrow({
      where: { id: created.json<{ id: string }>().id },
    });
    expect(scan.checks).toEqual(['seo', 'links']);
    expect(scan.formMode).toBe('validate_only');
  });

  it('does not let a key without forms:submit run a submit default', async () => {
    const admin = await ctx.adminCookie();
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { cookie: admin },
      payload: { defaultFormMode: 'submit' },
    });
    await ctx.allowDomain('safe-default.example.com');
    const { key } = await ctx.createApiKey(['scans:read', 'scans:write']);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/scans',
      headers: bearer(key),
      payload: { url: 'https://safe-default.example.com' },
    });
    expect(res.statusCode).toBe(202);
    const scan = await ctx.db.scan.findUniqueOrThrow({
      where: { id: res.json<{ id: string }>().id },
    });
    expect(scan.formMode).toBe('detect');
  });

  it('is admin only to change and validates input', async () => {
    const member = await ctx.createUser({ role: 'member' });
    const cookie = await ctx.login(member.email, member.password);
    const denied = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { cookie },
      payload: { defaultFormMode: 'detect' },
    });
    expect(denied.statusCode).toBe(403);

    const admin = await ctx.adminCookie();
    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { cookie: admin },
      payload: { defaultChecks: [], formTestEmail: 'not-an-email' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('OpenAPI document', () => {
  interface Operation {
    tags?: string[];
    summary?: string;
    security?: unknown[];
    responses: Record<string, unknown>;
  }
  interface Spec {
    openapi: string;
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    security: unknown[];
  }

  async function loadSpec(): Promise<Spec> {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/docs/json' });
    return res.json<Spec>();
  }

  it('documents every public route', async () => {
    const spec = await loadSpec();
    expect(spec.openapi).toBe('3.1.0');
    const documented = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(documented).toEqual(
      expect.arrayContaining([
        'GET /api/v1/health',
        'GET /api/v1/ready',
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/logout',
        'GET /api/v1/auth/me',
        'GET /api/v1/api-keys',
        'POST /api/v1/api-keys',
        'PATCH /api/v1/api-keys/{id}',
        'DELETE /api/v1/api-keys/{id}',
        'GET /api/v1/allowed-domains',
        'POST /api/v1/allowed-domains',
        'PATCH /api/v1/allowed-domains/{id}',
        'DELETE /api/v1/allowed-domains/{id}',
        'GET /api/v1/settings',
        'PATCH /api/v1/settings',
        'POST /api/v1/scans',
        'GET /api/v1/scans',
        'GET /api/v1/scans/{id}',
        'POST /api/v1/scans/{id}/cancel',
        'GET /api/v1/scans/{id}/pages',
        'GET /api/v1/scans/{id}/issues',
        'PATCH /api/v1/scans/{id}/issues/{issueId}',
      ]),
    );
  });

  it('gives every operation a tag, a summary and error responses', async () => {
    const spec = await loadSpec();
    for (const [path, methods] of Object.entries(spec.paths)) {
      if (!path.startsWith('/api/v1')) continue;
      for (const [method, operation] of Object.entries(methods)) {
        const label = `${method.toUpperCase()} ${path}`;
        expect(operation.tags?.length, `${label} tags`).toBeGreaterThan(0);
        expect(operation.summary, `${label} summary`).toBeTruthy();
        if (!path.endsWith('/health') && !path.endsWith('/ready')) {
          expect(
            Object.keys(operation.responses).some((code) => code.startsWith('4')),
            `${label} errors`,
          ).toBe(true);
        }
      }
    }
  });

  it('describes the start-scan contract n8n users need', async () => {
    const spec = await loadSpec();
    const op = spec.paths['/api/v1/scans']?.post;
    expect(Object.keys(op?.responses ?? {})).toEqual(
      expect.arrayContaining(['202', '400', '401', '403', '409', '422', '429']),
    );
    expect(JSON.stringify(op)).toContain('Idempotency-Key'.toLowerCase());
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining([
        'CreateScanBody',
        'CreateScanResponse',
        'Scan',
        'ErrorResponse',
        'Progress',
      ]),
    );
    const body = JSON.stringify(spec.components.schemas.CreateScanBody);
    expect(body).toContain('mondayItemId');
    expect(Object.keys(spec.components.securitySchemes)).toEqual(['bearerAuth', 'cookieAuth']);
  });

  it('marks health probes as unauthenticated', async () => {
    const spec = await loadSpec();
    expect(spec.paths['/api/v1/health']?.get?.security).toEqual([]);
  });

  it('serves the interactive docs page', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

describe('OpenAPI validity', () => {
  it('passes a strict OpenAPI 3.1 validator so n8n can import it', async () => {
    const { default: SwaggerParser } = await import('@apidevtools/swagger-parser');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/docs/json' });
    const spec = JSON.parse(res.body) as object;
    const validated = await SwaggerParser.validate(structuredClone(spec) as never);
    expect((validated as { openapi: string }).openapi).toBe('3.1.0');
  });
});
