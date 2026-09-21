import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { ServiceContext } from '@sce/core';
import {
  createLlmAdapter,
  createResearchAdapter,
  createTelegramAdapterFor,
  type LlmAdapter,
  type ResearchAdapter,
  type TelegramAdapter,
} from '@sce/adapters';
import { correlationPlugin } from './plugins/correlation.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { captureRoutes } from './routes/capture.js';
import { pipelineRoutes } from './routes/pipeline.js';
import { telegramRoutes } from './routes/telegram.js';
import { internalRoutes } from './routes/internal.js';

/**
 * Builds the HTTP surface. The context is injected so tests can run the real routes against a
 * real database with a fixed clock, and so no module-level singletons exist.
 */
export interface AppDeps {
  /** Injected so tests can drive the pipeline with a failing or scripted provider. */
  llm?: LlmAdapter;
  research?: ResearchAdapter;
  telegram?: TelegramAdapter;
}

export const buildApp = async (
  ctx: ServiceContext,
  deps: AppDeps = {},
): Promise<FastifyInstance> => {
  const llm = deps.llm ?? createLlmAdapter(ctx.env);
  const research = deps.research ?? createResearchAdapter(ctx.env);
  const telegram = deps.telegram ?? createTelegramAdapterFor(ctx.env);
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
  pipelineRoutes(app, ctx, { llm, research });
  telegramRoutes(app, ctx, { telegram, llm });
  internalRoutes(app, ctx);

  return app;
};
