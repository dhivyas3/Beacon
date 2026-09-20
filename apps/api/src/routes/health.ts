import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const HealthSchema = z.object({ status: z.literal('ok') }).meta({ id: 'Health' });

const ReadySchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.object({
      database: z.enum(['ok', 'error']),
      redis: z.enum(['ok', 'error']),
    }),
  })
  .meta({ id: 'Ready' });

async function settle(probe: () => Promise<unknown>): Promise<'ok' | 'error'> {
  try {
    await probe();
    return 'ok';
  } catch {
    return 'error';
  }
}

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['System'],
        summary: 'Liveness probe',
        description: 'Returns 200 while the process is running. Does not touch dependencies.',
        security: [],
        response: { 200: HealthSchema },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/ready',
    {
      schema: {
        tags: ['System'],
        summary: 'Readiness probe',
        description: 'Returns 200 when the database and Redis are reachable, otherwise 503.',
        security: [],
        response: { 200: ReadySchema, 503: ReadySchema },
      },
    },
    async (_request, reply) => {
      const [database, redis] = await Promise.all([
        settle(() => app.db.$queryRaw`SELECT 1`),
        settle(() => app.redis.ping()),
      ]);
      const ready = database === 'ok' && redis === 'ok';
      return reply.code(ready ? 200 : 503).send({
        status: ready ? ('ready' as const) : ('not_ready' as const),
        checks: { database, redis },
      });
    },
  );
};
