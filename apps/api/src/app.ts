import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { ServiceContext } from '@sce/core';
import { correlationPlugin } from './plugins/correlation.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { captureRoutes } from './routes/capture.js';
import { internalRoutes } from './routes/internal.js';

/**
 * Builds the HTTP surface. The context is injected so tests can run the real routes against a
 * real database with a fixed clock, and so no module-level singletons exist.
 */
export const buildApp = async (ctx: ServiceContext): Promise<FastifyInstance> => {
  const app = Fastify({
    // Fastify 5 takes a pre-built pino instance as `loggerInstance` (`logger` is config only).
    // Widening to FastifyBaseLogger keeps the instance type default, so plugins typed against
    // plain FastifyInstance stay compatible.
    loggerInstance: ctx.logger as FastifyBaseLogger,
    bodyLimit: ctx.env.API_BODY_LIMIT_BYTES,
    trustProxy: false,
  });

  correlationPlugin(app);
  errorHandlerPlugin(app);

  await app.register(rateLimit, {
    max: ctx.env.API_RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    // Health probes must never be rate limited away.
    allowList: (request) => request.url.startsWith('/health/'),
    keyGenerator: (request) => request.ip,
  });

  healthRoutes(app, ctx);
  captureRoutes(app, ctx);
  internalRoutes(app, ctx);

  return app;
};
