import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Db } from '@qa-hub/db';
import type { HostResolver } from '@qa-hub/net';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { ApiConfig } from './config.js';
import { ApiError } from './lib/errors.js';
import { authPlugin } from './plugins/auth.js';
import { registerErrorHandling } from './plugins/errors.js';
import { BullScanQueue, type ScanQueue } from './queue.js';
import { allowedDomainRoutes } from './routes/allowed-domains.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { scanRoutes } from './routes/scans.js';
import { settingsRoutes } from './routes/settings.js';

export interface ServerDeps {
  config: ApiConfig;
  db: Db;
  redis: Redis;
  /** Defaults to a BullMQ producer on `config.REDIS_URL`. Tests can pass their own. */
  queue?: ScanQueue;
  /** Defaults to system DNS. Tests inject a fake so no real lookups happen. */
  resolver?: HostResolver;
}

export const API_PREFIX = '/api/v1';

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, db, redis } = deps;
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      ...(config.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  const queue =
    deps.queue ??
    new BullScanQueue(config.REDIS_URL, config.QUEUE_PREFIX, (error) =>
      app.log.error({ err: error }, 'scan queue error'),
    );

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('scanQueue', queue);

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });
  if (!deps.queue) app.addHook('onClose', async () => queue.close());

  registerErrorHandling(app);
  await app.register(cookie);
  await app.register(authPlugin);

  // Limits are per API key or signed-in user, and per IP for anonymous callers. Counters live in
  // Redis so several API replicas share them. Runs after auth so the actor is known.
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    hook: 'preHandler',
    redis,
    nameSpace: `${config.QUEUE_PREFIX}:ratelimit:`,
    skipOnError: true,
    keyGenerator: (request) =>
      request.actor ? `${request.actor.kind}:${request.actor.id}` : `ip:${request.ip}`,
    errorResponseBuilder: (_request, context) =>
      new ApiError(
        'rate_limited',
        `Too many requests. Wait ${Math.ceil(context.ttl / 1000)} seconds before trying again.`,
        { limit: context.max, retryAfterSeconds: Math.ceil(context.ttl / 1000) },
      ),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'QA Hub API',
        version: '1.0.0',
        description: [
          'Validate live websites after launch. Start a scan, poll or stream its progress, and read the report.',
          '',
          'Authenticate with `Authorization: Bearer <api key>`. Create keys in Settings. The dashboard uses a session cookie instead.',
          '',
          'Every error has the shape `{ "error": { "code", "message", "details"? } }`. Every response carries an `X-Request-Id` header. Quote it when asking for support.',
        ].join('\n'),
      },
      servers: [{ url: config.PUBLIC_URL }],
      tags: [
        { name: 'Scans', description: 'Start, inspect and cancel scans.' },
        { name: 'Issues', description: 'Findings of a scan.' },
        { name: 'Allowed domains', description: 'Hostnames that may be scanned. Admin only.' },
        { name: 'API keys', description: 'Credentials for integrations. Admin only.' },
        { name: 'Settings', description: 'Scan defaults.' },
        { name: 'Auth', description: 'Dashboard sign in.' },
        { name: 'System', description: 'Health probes.' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'An API key: `qah_...`.' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'qa_session' },
        },
      },
      security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  await app.register(
    async (v1) => {
      await v1.register(healthRoutes);
      await v1.register(authRoutes);
      await v1.register(apiKeyRoutes);
      await v1.register(allowedDomainRoutes);
      await v1.register(settingsRoutes);
      await v1.register(scanRoutes, { queue, resolver: deps.resolver });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
