import { randomUUID } from 'node:crypto';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Db } from '@qa-hub/db';
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
import { healthRoutes } from './routes/health.js';

export interface ServerDeps {
  config: ApiConfig;
  db: Db;
  redis: Redis;
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

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'QA Hub API',
        version: '1.0.0',
        description:
          'Validate live websites after launch. Start a scan, poll or stream its progress, and read the report. Authenticate with `Authorization: Bearer <api key>`.',
      },
      servers: [{ url: config.PUBLIC_URL }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'An API key: `qah_...`.' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'qa_session' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  await app.register(healthRoutes, { prefix: API_PREFIX });

  return app;
}
