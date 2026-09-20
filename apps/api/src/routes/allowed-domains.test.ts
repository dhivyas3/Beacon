import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, errorOf, type TestApp } from '../test/helpers.js';

let ctx: TestApp;
let admin: string;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await ctx.adminCookie();
});

afterAll(async () => {
  await ctx.close();
});

function post(payload: unknown) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/allowed-domains',
    headers: { cookie: admin },
    payload: payload as Record<string, unknown>,
  });
}

describe('allowed domains', () => {
  it('is admin only', async () => {
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/allowed-domains' })).statusCode,
    ).toBe(401);
    const member = await ctx.createUser({ role: 'member' });
    const cookie = await ctx.login(member.email, member.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/allowed-domains',
      headers: { cookie },
      payload: { hostname: 'example.com' },
    });
    expect(res.statusCode).toBe(403);
    const { key } = await ctx.createApiKey(['scans:read', 'scans:write']);
    const withKey = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/allowed-domains',
      headers: bearer(key),
    });
    expect(withKey.statusCode).toBe(403);
  });

  it('creates, lists, edits and deletes entries', async () => {
    const created = await post({ hostname: 'Client-Site.CO.uk', note: 'Main site' });
    expect(created.statusCode).toBe(201);
    const body = created.json<{
      id: string;
      hostname: string;
      note: string;
      createdByName: string;
    }>();
    expect(body).toMatchObject({
      hostname: 'client-site.co.uk',
      note: 'Main site',
      createdByName: 'Admin',
    });

    const wildcard = await post({ hostname: '*.example-estates.co.uk' });
    expect(wildcard.statusCode).toBe(201);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/allowed-domains',
      headers: { cookie: admin },
    });
    const hostnames = list.json<{ items: { hostname: string }[] }>().items.map((i) => i.hostname);
    expect(hostnames).toEqual(['*.example-estates.co.uk', 'client-site.co.uk']);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/allowed-domains/${body.id}`,
      headers: { cookie: admin },
      payload: { note: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ note: string | null }>().note).toBeNull();

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/allowed-domains/${body.id}`,
      headers: { cookie: admin },
    });
    expect(removed.statusCode).toBe(204);
    const gone = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/allowed-domains/${body.id}`,
      headers: { cookie: admin },
    });
    expect(gone.statusCode).toBe(404);
    expect(errorOf(gone).code).toBe('not_found');
  });

  it('rejects duplicates with 409', async () => {
    expect((await post({ hostname: 'dupe.example.com' })).statusCode).toBe(201);
    const again = await post({ hostname: 'DUPE.example.com' });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('conflict');
  });

  it('rejects things that are not hostnames', async () => {
    for (const hostname of ['https://example.com', 'example.com/path', 'has space.com', '', '*.']) {
      const res = await post({ hostname });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('validation_error');
    }
  });
});
