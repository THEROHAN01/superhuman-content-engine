import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@sce/utils';
import type { AnalyticsAdapter } from '@sce/adapters';
import {
  collectAnalytics,
  collectDuePublications,
  deriveMetrics,
  listAnalyticsForItem,
  listAnalyticsForPublication,
  type ServiceContext,
} from '@sce/core';
import { METRIC_WINDOWS } from '@sce/schemas';
import { requireCaptureAuth } from '../plugins/auth.js';

/**
 * Analytics routes. Collection is idempotent per (publication, window, day): calling again
 * refreshes the numbers for that day rather than adding a row.
 */
const collectBody = z.object({
  window: z.enum(METRIC_WINDOWS).default('24h'),
  collected_for: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const analyticsRoutes = (
  app: FastifyInstance,
  ctx: ServiceContext,
  deps: { analytics: AnalyticsAdapter },
): void => {
  const auth = requireCaptureAuth(ctx.env);

  app.post<{ Params: { id: string }; Body: { window?: string; collected_for?: string } }>(
    '/publications/:id/collect-analytics',
    { preHandler: auth },
    async (request, reply) => {
      const parsed = collectBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw AppError.permanent('E_INVALID_COLLECTION', 'invalid collection request', 422, {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }

      const result = await collectAnalytics(ctx, request.params.id, {
        analytics: deps.analytics,
        window: parsed.data.window,
        ...(parsed.data.collected_for ? { collectedFor: parsed.data.collected_for } : {}),
      });

      if (!result.ok) {
        const status =
          result.error.code === 'E_PUBLICATION_NOT_FOUND'
            ? 404
            : result.error.kind === 'permanent'
              ? 422
              : 503;
        throw new AppError(result.error, status);
      }

      const event = result.value.event;
      return reply.code(result.value.inserted ? 201 : 200).send({
        analytics_event_id: event.id,
        publication_id: event.publication_id,
        window: event.metric_window,
        collected_for: event.collected_for,
        inserted: result.value.inserted,
        simulated: result.value.simulated,
        metrics: event.metrics,
        derived: deriveMetrics(event.metrics),
      });
    },
  );

  app.post<{ Body: { window?: string; collected_for?: string } }>(
    '/analytics/collect',
    { preHandler: auth },
    async (request) => {
      const parsed = collectBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw AppError.permanent('E_INVALID_COLLECTION', 'invalid collection request', 422);
      }

      return collectDuePublications(ctx, {
        analytics: deps.analytics,
        window: parsed.data.window,
        ...(parsed.data.collected_for ? { collectedFor: parsed.data.collected_for } : {}),
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/publications/:id/analytics',
    { preHandler: auth },
    async (request) => {
      const events = await listAnalyticsForPublication(ctx, request.params.id);
      return {
        count: events.length,
        events: events.map((event) => ({ ...event, derived: deriveMetrics(event.metrics) })),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/content-items/:id/analytics',
    { preHandler: auth },
    async (request) => {
      const events = await listAnalyticsForItem(ctx, request.params.id);
      return {
        count: events.length,
        events: events.map((event) => ({ ...event, derived: deriveMetrics(event.metrics) })),
      };
    },
  );
};
