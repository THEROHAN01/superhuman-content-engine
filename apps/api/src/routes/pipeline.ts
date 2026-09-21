import type { FastifyInstance } from 'fastify';
import { AppError } from '@sce/utils';
import type { LlmAdapter } from '@sce/adapters';
import { processLearningEvent, processPendingLearningEvents, type ServiceContext } from '@sce/core';
import { requireCaptureAuth } from '../plugins/auth.js';

/**
 * Pipeline routes: normalization, classification, deduplication and atom-shell creation.
 *
 * Kept separate from capture so a slow model can never block the capture path, and so n8n can
 * schedule processing independently of intake.
 */
export const pipelineRoutes = (
  app: FastifyInstance,
  ctx: ServiceContext,
  deps: { llm: LlmAdapter },
): void => {
  const auth = requireCaptureAuth(ctx.env);

  app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
    '/learning-events/:id/process',
    { preHandler: auth },
    async (request, reply) => {
      const result = await processLearningEvent(ctx, request.params.id, {
        llm: deps.llm,
        force: request.body?.force === true,
      });

      if (!result.ok) {
        const status =
          result.error.code === 'E_EVENT_NOT_FOUND'
            ? 404
            : result.error.kind === 'permanent'
              ? 422
              : 503;
        throw new AppError(result.error, status);
      }

      const value = result.value;
      return reply.code(200).send({
        id: value.event.id,
        status: value.event.status,
        unchanged: value.unchanged,
        duplicate_of: value.duplicate_of,
        duplicate_score: Number(value.duplicate_score.toFixed(3)),
        classification: value.classification,
        content_atom_id: value.atom?.id ?? null,
        atom_created: value.atom_created,
        correlation_id: value.event.correlation_id,
      });
    },
  );

  app.post<{ Body: { limit?: number } }>(
    '/pipeline/process-pending',
    { preHandler: auth },
    async (request) => {
      const results = await processPendingLearningEvents(ctx, {
        llm: deps.llm,
        limit: request.body?.limit,
      });
      return {
        processed: results.length,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        failures: results
          .filter((r): r is Extract<typeof r, { ok: false }> => !r.ok)
          .map((r) => ({ code: r.error.code, message: r.error.message })),
      };
    },
  );
};
