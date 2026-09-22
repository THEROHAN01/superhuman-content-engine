import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@sce/utils';
import type { PublishingAdapter } from '@sce/adapters';
import {
  cancelPublication,
  listPublicationsForItem,
  markPublished,
  schedulePublication,
  type ServiceContext,
} from '@sce/core';
import { requireCaptureAuth } from '../plugins/auth.js';

/**
 * Publishing routes.
 *
 * Every one of these is safe to call twice: scheduling the same item into the same slot returns
 * the existing publication without touching the provider, and cancelling or marking published is
 * idempotent.
 */
const scheduleBody = z.object({
  scheduled_at: z.string().datetime({ offset: true }),
});

export const publishRoutes = (
  app: FastifyInstance,
  ctx: ServiceContext,
  deps: { publisher: PublishingAdapter },
): void => {
  const auth = requireCaptureAuth(ctx.env);

  app.post<{ Params: { id: string }; Body: { scheduled_at?: string } }>(
    '/content-items/:id/schedule',
    { preHandler: auth },
    async (request, reply) => {
      const parsed = scheduleBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw AppError.permanent(
          'E_INVALID_SCHEDULE',
          'scheduled_at must be an ISO-8601 timestamp',
          422,
          {
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        );
      }

      const result = await schedulePublication(ctx, request.params.id, {
        publisher: deps.publisher,
        scheduledAt: parsed.data.scheduled_at,
      });

      if (!result.ok) {
        const status =
          result.error.code === 'E_ITEM_NOT_FOUND'
            ? 404
            : result.error.kind === 'permanent'
              ? 422
              : 503;
        throw new AppError(result.error, status);
      }

      const { publication, created, dry_run } = result.value;
      return reply.code(created ? 201 : 200).send({
        publication_id: publication.id,
        content_item_id: publication.content_item_id,
        status: publication.status,
        created,
        dry_run,
        provider: publication.provider,
        external_id: publication.external_id,
        external_url: publication.external_url,
        scheduled_at: publication.scheduled_at,
        attempts: publication.attempts,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/publications/:id/cancel',
    { preHandler: auth },
    async (request, reply) => {
      const result = await cancelPublication(ctx, request.params.id, { publisher: deps.publisher });
      if (!result.ok) {
        const status =
          result.error.code === 'E_PUBLICATION_NOT_FOUND'
            ? 404
            : result.error.kind === 'permanent'
              ? 422
              : 503;
        throw new AppError(result.error, status);
      }
      return reply.code(200).send({
        publication_id: result.value.publication.id,
        status: result.value.publication.status,
        cancelled: result.value.cancelled,
      });
    },
  );

  /** Confirms a scheduled slot has gone out. Called by the worker, or by an operator. */
  app.post<{ Params: { id: string } }>(
    '/publications/:id/mark-published',
    { preHandler: auth },
    async (request, reply) => {
      const result = await markPublished(ctx, request.params.id);
      if (!result.ok) {
        const status =
          result.error.code === 'E_PUBLICATION_NOT_FOUND'
            ? 404
            : result.error.kind === 'permanent'
              ? 422
              : 503;
        throw new AppError(result.error, status);
      }
      return reply.code(200).send({
        publication_id: result.value.id,
        status: result.value.status,
        published_at: result.value.published_at,
        dry_run: result.value.dry_run,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/content-items/:id/publications',
    { preHandler: auth },
    async (request) => {
      const rows = await listPublicationsForItem(ctx, request.params.id);
      return { publications: rows, count: rows.length };
    },
  );
};
