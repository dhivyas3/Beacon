import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../lib/crypto.js';
import { bearer, createTestApp, errorOf, type TestApp } from '../test/helpers.js';

let ctx: TestApp;
let admin: string;
let member: string;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await ctx.adminCookie();
  const m = await ctx.createUser({ role: 'member' });
  member = await ctx.login(m.email, m.password);
});

afterAll(async () => {
  await ctx.close();
});

async function createKey(scopes: string[] = ['scans:read', 'scans:write'], name = 'n8n') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/api-keys',
    headers: { cookie: admin },
    payload: { name, scopes },
  });
  return res;
}

describe('API key management', () => {
  it('is admin only', async () => {
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/api-keys' });
    expect(anonymous.statusCode).toBe(401);

    const asMember = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/api-keys',
      headers: { cookie: member },
    });
    expect(asMember.statusCode).toBe(403);
    expect(errorOf(asMember).message).toMatch(/admin/i);

    const memberCreate = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie: member },
      payload: { name: 'nope' },
    });
    expect(memberCreate.statusCode).toBe(403);
  });

  it('returns the raw key once and stores only its hash', async () => {
    const res = await createKey(['scans:read'], 'ci pipeline');
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; key: string; prefix: string; scopes: string[] }>();
    expect(body.key).toMatch(/^bcn_[A-Za-z0-9_-]{43}$/);
    expect(body.prefix).toBe(body.key.slice(0, 12));
    expect(body.scopes).toEqual(['scans:read']);

    const stored = await ctx.db.apiKey.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.keyHash).toBe(sha256(body.key));
    expect(JSON.stringify(stored)).not.toContain(body.key);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/api-keys',
      headers: { cookie: admin },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(body.key);
    const items = list.json<{ items: { id: string; name: string; createdByName: string }[] }>()
      .items;
    expect(items.find((item) => item.id === body.id)).toMatchObject({
      name: 'ci pipeline',
      createdByName: 'Admin',
    });
  });

  it('validates the body', async () => {
    const noName = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie: admin },
      payload: { scopes: ['scans:read'] },
    });
    expect(noName.statusCode).toBe(400);

    const badScope = await createKey(['scans:delete']);
    expect(badScope.statusCode).toBe(400);
    expect(errorOf(badScope).code).toBe('validation_error');

    const noScopes = await createKey([]);
    expect(noScopes.statusCode).toBe(400);
  });

  it('defaults to read and write scopes', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie: admin },
      payload: { name: 'default scopes' },
    });
    expect(res.json<{ scopes: string[] }>().scopes).toEqual(['scans:read', 'scans:write']);
  });

  it('renames a key and changes its scopes', async () => {
    const created = (await createKey()).json<{ id: string }>();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/api-keys/${created.id}`,
      headers: { cookie: admin },
      payload: { name: 'renamed', scopes: ['scans:read'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'renamed', scopes: ['scans:read'] });

    const missing = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/api-keys/key_doesnotexist',
      headers: { cookie: admin },
      payload: { name: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('API key authentication', () => {
  it('authenticates Bearer requests and records last use', async () => {
    const { id, key } = (await createKey()).json<{ id: string; key: string }>();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/scans', headers: bearer(key) });
    expect(res.statusCode).toBe(200);

    await expect
      .poll(async () => (await ctx.db.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt)
      .not.toBeNull();
  });

  it('still accepts keys created before the rename, which start with qah_', async () => {
    const { id, key } = (await createKey()).json<{ id: string; key: string }>();
    const legacy = `qah_${key.slice('bcn_'.length)}`;
    await ctx.db.apiKey.update({ where: { id }, data: { keyHash: sha256(legacy) } });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/scans',
      headers: bearer(legacy),
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects unknown keys, malformed headers and non-key tokens', async () => {
    for (const authorization of [
      'Bearer bcn_thisisnotarealkey',
      'Bearer something-else',
      'Basic dXNlcjpwYXNz',
      'Bearer',
    ]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/scans',
        headers: { authorization },
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('unauthorized');
    }
  });

  it('does not fall back to a session cookie when the Bearer key is bad', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/scans',
      headers: { authorization: 'Bearer bcn_bad', cookie: admin },
    });
    expect(res.statusCode).toBe(401);
  });

  it('stops working the moment a key is revoked', async () => {
    const { id, key } = (await createKey()).json<{ id: string; key: string }>();
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/scans',
      headers: bearer(key),
    });
    expect(before.statusCode).toBe(200);

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${id}`,
      headers: { cookie: admin },
    });
    expect(revoke.statusCode).toBe(204);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/scans',
      headers: bearer(key),
    });
    expect(after.statusCode).toBe(401);

    // Revoked keys stay listed, and revoking twice is harmless.
    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${id}`,
      headers: { cookie: admin },
    });
    expect(again.statusCode).toBe(204);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/api-keys',
      headers: { cookie: admin },
    });
    const revoked = list
      .json<{ items: { id: string; revokedAt: string | null }[] }>()
      .items.find((item) => item.id === id);
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it('enforces scopes', async () => {
    const { key } = await ctx.createApiKey(['scans:read']);
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/scans',
      headers: bearer(key),
    });
    expect(read.statusCode).toBe(200);

    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/scans',
      headers: bearer(key),
      payload: { url: 'https://www.example.com' },
    });
    expect(write.statusCode).toBe(403);
    expect(errorOf(write)).toMatchObject({
      code: 'forbidden',
      details: { requiredScope: 'scans:write' },
    });
  });

  it('cannot manage keys or domains, even with every scope', async () => {
    const { key } = await ctx.createApiKey(['scans:read', 'scans:write', 'forms:submit']);
    for (const url of ['/api/v1/api-keys', '/api/v1/allowed-domains']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: bearer(key) });
      expect(res.statusCode).toBe(403);
    }
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: bearer(key),
    });
    expect(me.statusCode).toBe(403);
  });
});
