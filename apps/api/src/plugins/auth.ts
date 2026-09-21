import {
  API_KEY_PREFIX,
  LEGACY_API_KEY_PREFIXES,
  SCOPES,
  scopesForRole,
  type Scope,
} from '@beacon/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import type { Actor, AuthRequirement } from '../types.js';

export const SESSION_COOKIE = 'beacon_session';
const BEARER = /^Bearer\s+(\S+)\s*$/i;
const LAST_USED_THROTTLE_MS = 60_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

async function actorFromApiKey(app: FastifyInstance, raw: string): Promise<Actor> {
  const invalid = new ApiError(
    'unauthorized',
    'The API key is invalid or has been revoked. Create a new key in Settings.',
  );
  if (![API_KEY_PREFIX, ...LEGACY_API_KEY_PREFIXES].some((prefix) => raw.startsWith(prefix))) {
    throw invalid;
  }

  const key = await app.db.apiKey.findUnique({ where: { keyHash: sha256(raw) } });
  if (!key || key.revokedAt !== null) throw invalid;

  // Record usage at most once a minute per key, without slowing the request down.
  const cutoff = new Date(Date.now() - LAST_USED_THROTTLE_MS);
  void app.db.apiKey
    .updateMany({
      where: { id: key.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] },
      data: { lastUsedAt: new Date() },
    })
    .catch((error: unknown) => app.log.warn({ err: error }, 'could not record API key usage'));

  return { kind: 'api_key', id: key.id, name: key.name, scopes: key.scopes.filter(isScope) };
}

async function actorFromSession(app: FastifyInstance, token: string): Promise<Actor | null> {
  const session = await app.db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  return {
    kind: 'user',
    id: session.user.id,
    name: session.user.name,
    role: session.user.role,
    scopes: scopesForRole(session.user.role),
    sessionId: session.id,
  };
}

function requestHost(request: FastifyRequest): string | undefined {
  const forwarded = request.headers['x-forwarded-host'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value ?? request.headers.host;
}

/**
 * Browsers always send Origin on cross-site writes. A session cookie used from a foreign origin is
 * refused, which closes CSRF on top of SameSite=Lax. Requests without Origin (curl, servers) pass.
 */
function assertSameOrigin(app: FastifyInstance, request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError('forbidden', 'The request origin is not valid.');
  }
  const allowed = new Set([new URL(app.config.PUBLIC_URL).host, requestHost(request)]);
  if (!allowed.has(originHost)) {
    throw new ApiError(
      'forbidden',
      'This request came from a different site than the one you signed in on.',
    );
  }
}

function enforce(requirement: AuthRequirement, actor: Actor | null): void {
  if (requirement === false) return;
  if (actor === null) {
    throw new ApiError(
      'unauthorized',
      'Sign in, or send an API key as "Authorization: Bearer <key>".',
    );
  }
  if (requirement === 'admin') {
    if (actor.kind !== 'user' || actor.role !== 'admin') {
      throw new ApiError('forbidden', 'Only admins can do this.');
    }
    return;
  }
  if (requirement === 'session') {
    if (actor.kind !== 'user') {
      throw new ApiError('forbidden', 'This action needs a signed-in user. API keys cannot do it.');
    }
    return;
  }
  if (!actor.scopes.includes(requirement)) {
    throw new ApiError(
      'forbidden',
      `This ${actor.kind === 'api_key' ? 'API key' : 'account'} does not have the ${requirement} scope.`,
      { requiredScope: requirement },
    );
  }
}

/**
 * Resolves the actor for every request and enforces the route's declared `config.auth`.
 * A route under /api/v1 that does not declare `config.auth` fails at startup.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('actor', null);

  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/api/v1') && route.config?.auth === undefined) {
      throw new Error(`Route ${String(route.method)} ${route.url} must declare config.auth.`);
    }
  });

  app.addHook('onRequest', async (request) => {
    const requirement = request.routeOptions.config.auth;
    if (requirement === undefined) return; // not an /api/v1 route (docs, 404 handler)

    let actor: Actor | null = null;
    const header = request.headers.authorization;
    if (header !== undefined) {
      const match = BEARER.exec(header);
      if (!match?.[1]) {
        throw new ApiError(
          'unauthorized',
          'The Authorization header must look like "Bearer <api key>".',
        );
      }
      actor = await actorFromApiKey(app, match[1]);
    } else {
      const token = request.cookies[SESSION_COOKIE];
      if (token) {
        actor = await actorFromSession(app, token);
        if (actor && !SAFE_METHODS.has(request.method)) assertSameOrigin(app, request);
      }
    }

    request.actor = actor;
    enforce(requirement, actor);
  });
});
