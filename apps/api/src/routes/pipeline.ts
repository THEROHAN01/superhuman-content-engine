import type { FastifyInstance } from 'fastify';
import { AppError } from '@sce/utils';
import type { LlmAdapter, ResearchAdapter } from '@sce/adapters';
import {
  buildContentAtom,
  generateContentItems,
  generateIdeas,
  getContentAtom,
  processLearningEvent,
  processPendingLearningEvents,
  getContentItem,
  listItemsForIdea,
  queueBestIdeas,
  researchContentAtom,
  type ServiceContext,
} from '@sce/core';
import { CONTENT_FORMATS, type ContentFormat } from '@sce/schemas';
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

  /**
   * Generates content ideas from a ready atom. Re-running is safe: identical and near-duplicate
   * ideas are rejected with a stated reason rather than stored, and an atom is capped at eight.
   */
  app.post<{ Params: { id: string }; Body: { force?: boolean; queue?: number } }>(
    '/content-atoms/:id/ideas',
    { preHandler: auth },
    async (request, reply) => {
      const result = await generateIdeas(ctx, request.params.id, {
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

      const queueCount = request.body?.queue;
      const queued =
        typeof queueCount === 'number' && queueCount > 0
          ? await queueBestIdeas(ctx, request.params.id, queueCount)
          : [];

      // Queueing changes idea status, so report the list as it is *after* that, not the snapshot
      // taken before it.
      const queuedIds = new Set(queued.map((i) => i.id));
      const ideas = result.value.ideas.map((idea) =>
        queuedIds.has(idea.id) ? { ...idea, status: 'queued' as const } : idea,
      );

      return reply.code(200).send({
        content_atom_id: request.params.id,
        unchanged: result.value.unchanged,
        created: result.value.created.length,
        rejected: result.value.rejected,
        queued: queued.map((i) => i.id),
        ideas: ideas.map((idea) => ({
          id: idea.id,
          angle: idea.angle,
          title: idea.title,
          hook: idea.hook,
          status: idea.status,
          score: idea.score,
          formats: idea.formats,
          platforms: idea.platforms,
          evidence_required: idea.evidence_required,
        })),
      });
    },
  );

  /**
   * Generates platform-native drafts for an idea. Regeneration creates a new version and
   * supersedes the previous one; it never overwrites, so approval history stays meaningful.
   */
  app.post<{
    Params: { id: string };
    Body: { formats?: ContentFormat[]; regenerate?: boolean };
  }>('/content-ideas/:id/generate', { preHandler: auth }, async (request, reply) => {
    const formats = request.body?.formats;
    if (formats && formats.some((format) => !CONTENT_FORMATS.includes(format))) {
      throw AppError.permanent(
        'E_INVALID_FORMAT',
        `formats must be from: ${CONTENT_FORMATS.join(', ')}`,
        400,
      );
    }

    const result = await generateContentItems(ctx, request.params.id, {
      llm: deps.llm,
      ...(formats ? { formats } : {}),
      regenerate: request.body?.regenerate === true,
    });

    if (!result.ok) {
      const status =
        result.error.code === 'E_IDEA_NOT_FOUND'
          ? 404
          : result.error.kind === 'permanent'
            ? 422
            : 503;
      throw new AppError(result.error, status);
    }

    return reply.code(200).send({
      content_idea_id: request.params.id,
      generated: result.value.items.map(({ item, warnings, superseded_id }) => ({
        id: item.id,
        format: item.format,
        platform: item.platform,
        version: item.version,
        status: item.status,
        prompt_version: item.prompt_version,
        model: item.model,
        units: item.draft.units.length,
        characters: item.draft.body.length,
        warnings,
        superseded_id,
      })),
      skipped: result.value.skipped,
      failures: result.value.failures,
    });
  });

  app.get<{ Params: { id: string } }>(
    '/content-items/:id',
    { preHandler: auth },
    async (request, reply) => {
      const item = await getContentItem(ctx, request.params.id);
      if (!item) {
        return reply.code(404).send({
          error: { code: 'E_NOT_FOUND', message: `no content item ${request.params.id}` },
          correlation_id: request.correlationId,
        });
      }
      return item;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/content-ideas/:id/items',
    { preHandler: auth },
    async (request) => {
      const items = await listItemsForIdea(ctx, request.params.id);
      return { items, count: items.length };
    },
  );
};
