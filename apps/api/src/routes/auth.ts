import { LoginBodySchema, scopesForRole, SessionResponseSchema, type User } from '@beacon/shared';
import { newId } from '@beacon/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomToken, sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { errorResponses } from '../lib/openapi.js';
import { verifyPassword } from '../lib/passwords.js';
import { SESSION_COOKIE } from '../plugins/auth.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  createdAt: Date;
}

export function toUserDto(user: UserRow): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/login',
    {
      config: { auth: false, rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Sign in',
        description:
          'Verifies an email and password and sets an httpOnly session cookie. Used by the dashboard. Integrations should use API keys instead.',
        security: [],
        body: LoginBodySchema,
        response: { 200: SessionResponseSchema, ...errorResponses(400, 401, 429) },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = await app.db.user.findUnique({ where: { email } });
      const valid = await verifyPassword(user?.passwordHash ?? null, password);
      if (!user || !valid) {
        throw new ApiError(
          'unauthorized',
          'The email or password is incorrect. Check them and try again.',
        );
      }

      const token = randomToken();
      const ttlMs = app.config.SESSION_TTL_HOURS * 60 * 60 * 1000;
      await app.db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await app.db.session.create({
        data: {
          id: newId('ses'),
          userId: user.id,
          tokenHash: sha256(token),
          userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
          expiresAt: new Date(Date.now() + ttlMs),
        },
      });

      void reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: app.config.COOKIE_SECURE,
        path: '/',
        maxAge: Math.floor(ttlMs / 1000),
      });
      return { user: toUserDto(user), scopes: scopesForRole(user.role) };
    },
  );

  app.post(
    '/auth/logout',
    {
      config: { auth: 'session' },
      schema: {
        tags: ['Auth'],
        summary: 'Sign out',
        description: 'Ends the current session and clears the cookie.',
        security: [{ cookieAuth: [] }],
        response: { 204: z.null(), ...errorResponses(401, 403) },
      },
    },
    async (request, reply) => {
      const actor = request.actor;
      if (actor?.kind === 'user') {
        await app.db.session.deleteMany({ where: { id: actor.sessionId } });
      }
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/auth/me',
    {
      config: { auth: 'session' },
      schema: {
        tags: ['Auth'],
        summary: 'Current user',
        security: [{ cookieAuth: [] }],
        response: { 200: SessionResponseSchema, ...errorResponses(401, 403) },
      },
    },
    async (request) => {
      const actor = request.actor;
      if (actor?.kind !== 'user') throw new ApiError('unauthorized', 'Sign in to continue.');
      const user = await app.db.user.findUniqueOrThrow({ where: { id: actor.id } });
      return { user: toUserDto(user), scopes: actor.scopes };
    },
  );
};
