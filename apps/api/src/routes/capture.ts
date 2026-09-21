import type { FastifyInstance } from 'fastify';
import { AppError } from '@sce/utils';
import {
  captureLearningEvent,
  getLearningEvent,
  listLearningEvents,
  type ServiceContext,
} from '@sce/core';
import { LEARNING_EVENT_STATUSES, type LearningEventStatus } from '@sce/schemas';
import { requireCaptureAuth } from '../plugins/auth.js';

/**
 * The Learning Inbox.
 *
 * POST /capture is the lowest-friction way to record a learning: one required field. It is safe
 * to call twice - a repeat returns the original event with `duplicate: true` and HTTP 200 rather
 * than creating a second row or erroring.
 */
export const captureRoutes = (app: FastifyInstance, ctx: ServiceContext): void => {
  const auth = requireCaptureAuth(ctx.env);

  app.post('/capture', { preHandler: auth }, async (request, reply) => {
    const body =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};

    const result = await captureLearningEvent(ctx, {
      ...body,
      correlation_id: body['correlation_id'] ?? request.correlationId,
    });

    if (!result.ok) {
      throw new AppError(result.error, result.error.code === 'E_INVALID_CAPTURE' ? 422 : 503);
    }

    const { learning_event: event, duplicate } = result.value;
    return reply.code(duplicate ? 200 : 201).send({
      id: event.id,
      status: event.status,
      duplicate,
      // A human-readable confirmation: this is what a Telegram reply or curl user sees.
      message: duplicate
        ? `Already captured as ${event.id} - nothing new was created.`
        : `Captured ${event.id}: "${(event.title ?? event.raw_text).slice(0, 80)}"`,
      captured_at: event.captured_at,
      correlation_id: result.value.correlation_id,
    });
  });

  app.get<{ Params: { id: string } }>(
    '/learning-events/:id',
    { preHandler: auth },
    async (request, reply) => {
      const event = await getLearningEvent(ctx, request.params.id);
      if (!event) {
        return reply.code(404).send({
          error: { code: 'E_NOT_FOUND', message: `no learning event ${request.params.id}` },
          correlation_id: request.correlationId,
        });
      }
      return event;
    },
  );

  app.get<{ Querystring: { status?: string; limit?: string; since?: string } }>(
    '/learning-events',
    { preHandler: auth },
    async (request) => {
      const { status, limit, since } = request.query;
      if (status && !LEARNING_EVENT_STATUSES.includes(status as LearningEventStatus)) {
        throw AppError.permanent('E_INVALID_STATUS', `unknown status '${status}'`, 400);
      }
      const events = await listLearningEvents(ctx, {
        status: status as LearningEventStatus | undefined,
        limit: limit ? Number(limit) : undefined,
        since,
      });
      return { events, count: events.length };
    },
  );
};
