import type { FastifyInstance } from 'fastify';
import type { ServiceContext } from '@sce/core';

/**
 * Two probes with different meanings:
 *   /health/live  - the process is up (never touches dependencies)
 *   /health/ready - dependencies this process needs are actually usable
 */
export const healthRoutes = (app: FastifyInstance, ctx: ServiceContext): void => {
  app.get('/health/live', async () => ({ status: 'ok', uptime_s: Math.round(process.uptime()) }));

  app.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      const started = Date.now();
      await ctx.db.query('SELECT 1');
      checks['database'] = { ok: true, detail: `${Date.now() - started}ms` };
    } catch (error) {
      checks['database'] = {
        ok: false,
        detail: error instanceof Error ? error.message : 'unreachable',
      };
    }

    const ready = Object.values(checks).every((c) => c.ok);
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      checks,
      config: {
        publish_mode: ctx.env.PUBLISH_MODE,
        llm_provider: ctx.env.LLM_PROVIDER,
        publishing_provider: ctx.env.PUBLISHING_PROVIDER,
        telegram_provider: ctx.env.TELEGRAM_PROVIDER,
        research_provider: ctx.env.RESEARCH_PROVIDER,
      },
    });
  });
};
