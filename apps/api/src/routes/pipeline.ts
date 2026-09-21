import type { FastifyInstance } from 'fastify';
import { AppError } from '@sce/utils';
import type { LlmAdapter, ResearchAdapter } from '@sce/adapters';
import {
  buildContentAtom,
  getContentAtom,
  processLearningEvent,
  processPendingLearningEvents,
  researchContentAtom,
  type ServiceContext,
} from '@sce/core';
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
  deps: { llm: LlmAdapter; research: ResearchAdapter },
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

  /**
   * Attaches research evidence to an atom. Safe to re-run: sources deduplicate by canonical URL,
   * and a provider outage sets `research_failed` rather than recording an empty, successful search.
   */
  app.post<{ Params: { id: string } }>(
    '/content-atoms/:id/research',
    { preHandler: auth },
    async (request, reply) => {
      const result = await researchContentAtom(ctx, request.params.id, { research: deps.research });
      if (!result.ok) {
        throw new AppError(result.error, result.error.code === 'E_ATOM_NOT_FOUND' ? 404 : 503);
      }

      const value = result.value;
      return reply.code(200).send({
        content_atom_id: value.atom.id,
        status: value.atom.status,
        evidence_status: value.evidence_status,
        sources_added: value.added,
        sources_total: value.sources.length,
        synthetic_only: value.synthetic_only,
        queries: value.queries,
        sources: value.sources.map((s) => ({
          id: s.id,
          title: s.title,
          url: s.canonical_url,
          source_type: s.source_type,
          provider: s.provider,
          relevance: s.relevance,
        })),
      });
    },
  );

  /**
   * Builds the canonical atom body. A model failure, a fabricated citation, or an incomplete body
   * leaves the atom in `failed` with the reason recorded - it is never stored as ready.
   */
  app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
    '/content-atoms/:id/build',
    { preHandler: auth },
    async (request, reply) => {
      const result = await buildContentAtom(ctx, request.params.id, {
        llm: deps.llm,
        force: request.body?.force === true,
      });

      if (!result.ok) {
        const status =
          result.error.code === 'E_ATOM_NOT_FOUND'
            ? 404
            : result.error.kind === 'permanent'
              ? 422
              : 503;
        throw new AppError(result.error, status);
      }

      const value = result.value;
      return reply.code(200).send({
        content_atom_id: value.atom.id,
        learning_event_id: value.atom.learning_event_id,
        status: value.atom.status,
        unchanged: value.unchanged,
        evidence_status: value.evidence_status,
        unsupported_claims: value.unsupported_claims,
        atom: value.atom,
      });
    },
  );

  /** Reads an atom with its evidence - the provenance view. */
  app.get<{ Params: { id: string } }>(
    '/content-atoms/:id',
    { preHandler: auth },
    async (request, reply) => {
      const atom = await getContentAtom(ctx, request.params.id);
      if (!atom) {
        return reply.code(404).send({
          error: { code: 'E_NOT_FOUND', message: `no content atom ${request.params.id}` },
          correlation_id: request.correlationId,
        });
      }
      return atom;
    },
  );
};
