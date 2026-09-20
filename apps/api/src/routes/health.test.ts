import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test/helpers.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

describe('health endpoints', () => {
  it('GET /api/v1/health returns ok without authentication', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/v1/ready reports database and redis', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', redis: 'ok' } });
  });

  it('adds a request id to every response and honours an incoming one', async () => {
    const generated = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'req-from-n8n' },
    });
    expect(echoed.headers['x-request-id']).toBe('req-from-n8n');
  });

  it('serves an OpenAPI 3.1 document', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toContain('/api/v1/health');
  });
});
