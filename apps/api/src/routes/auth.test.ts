import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieHeader, createTestApp, errorOf, type TestApp } from '../test/helpers.js';

let ctx: TestApp;
let user: { id: string; email: string; password: string };

beforeAll(async () => {
  ctx = await createTestApp();
  user = await ctx.createUser({ name: 'Dana Member' });
});

afterAll(async () => {
  await ctx.close();
});

function login(email: string, password: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
}

describe('POST /auth/login', () => {
  it('signs in and sets an httpOnly, SameSite=Lax session cookie', async () => {
    const res = await login(user.email, user.password);
    expect(res.statusCode).toBe(200);

    const body = res.json<{ user: Record<string, unknown>; scopes: string[] }>();
    expect(body.user).toMatchObject({ email: user.email, name: 'Dana Member', role: 'member' });
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.scopes).toEqual(expect.arrayContaining(['scans:read', 'scans:write']));

    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/qa_session=/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/Secure/i);
  });

  it('stores only a hash of the session token', async () => {
    const res = await login(user.email, user.password);
    const token = cookieHeader(res).split('=')[1] ?? '';
    const sessions = await ctx.db.session.findMany();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.some((session) => session.tokenHash === token)).toBe(false);
  });

  it('marks the cookie Secure when COOKIE_SECURE is enabled', async () => {
    const secure = await createTestApp({ COOKIE_SECURE: 'true' });
    try {
      const u = await secure.createUser();
      const res = await secure.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: u.email, password: u.password },
      });
      expect(String(res.headers['set-cookie'])).toMatch(/Secure/i);
    } finally {
      await secure.close();
    }
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrong = await login(user.email, 'not-the-password');
    const unknown = await login('nobody@example.com', 'whatever-password');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(errorOf(wrong)).toEqual(errorOf(unknown));
    expect(errorOf(wrong).code).toBe('unauthorized');
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('is case-insensitive on email and rejects malformed input with 400', async () => {
    const upper = await login(user.email.toUpperCase(), user.password);
    expect(upper.statusCode).toBe(200);

    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email },
    });
    expect(missing.statusCode).toBe(400);
    const error = errorOf(missing);
    expect(error.code).toBe('validation_error');
    expect(JSON.stringify(error.details)).toContain('password');
  });

  it('rate limits repeated attempts per IP', async () => {
    const limited = await createTestApp();
    try {
      let last = 0;
      for (let i = 0; i < 11; i++) {
        const res = await limited.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'x@example.com', password: 'wrong-password' },
        });
        last = res.statusCode;
        if (i < 10) expect(res.statusCode).toBe(401);
      }
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('sessions', () => {
  it('GET /auth/me returns the signed-in user', async () => {
    const cookie = await ctx.login(user.email, user.password);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { email: string } }>().user.email).toBe(user.email);
  });

  it('rejects requests with no session or a bogus one', async () => {
    const none = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(none.statusCode).toBe(401);
    expect(errorOf(none).code).toBe('unauthorized');

    const bogus = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: 'qa_session=not-a-real-token' },
    });
    expect(bogus.statusCode).toBe(401);
  });

  it('logout ends the session immediately', async () => {
    const cookie = await ctx.login(user.email, user.password);
    const out = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/qa_session=;/);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('rejects an expired session', async () => {
    const cookie = await ctx.login(user.email, user.password);
    await ctx.db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses cookie-authenticated writes that come from another origin', async () => {
    const cookie = await ctx.login(user.email, user.password);

    const foreign = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(errorOf(foreign).code).toBe('forbidden');

    const same = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, origin: 'http://qa.test' },
    });
    expect(same.statusCode).toBe(204);
  });
});
