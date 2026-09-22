import type { FastifyInstance } from 'fastify';
import { checkSystemHealth, sweepStuckWork, type ServiceContext } from '@sce/core';
import { requireCaptureAuth } from '../plugins/auth.js';

/**
 * Two probes with different meanings:
 *   /health/live  - the process is up (never touches dependencies)
 *   /health/ready - dependencies this process needs are actually usable
 */
export const healthRoutes = (app: FastifyInstance, ctx: ServiceContext): void => {
  const auth = requireCaptureAuth(ctx.env);
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

  /**
   * Full system health: dependencies plus whether work is actually moving. Green dependencies with
   * content stuck in approval for a week is the failure this endpoint exists to catch.
   */
  app.get('/health/system', { preHandler: auth }, async (_request, reply) => {
    const health = await checkSystemHealth(ctx);
    const code = health.status === 'unhealthy' ? 503 : 200;
    return reply.code(code).send(health);
  });

  /** Recovery sweep: releases abandoned work and dead-letters what has exhausted its budget. */
  app.post('/system/sweep', { preHandler: auth }, async () => sweepStuckWork(ctx));
};
