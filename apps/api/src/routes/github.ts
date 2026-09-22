import type { FastifyInstance } from 'fastify';
import { operations } from '@sce/db';
import { verifyGithubSignature } from '@sce/adapters';
import { AppError } from '@sce/utils';
import { forceGithubOpportunity, ingestGithubEvent, type ServiceContext } from '@sce/core';
import { requireCaptureAuth } from '../plugins/auth.js';

/**
 * GitHub webhook.
 *
 * Signature verification runs against the **raw** body (see `rawBodyPlugin`), before the payload
 * is trusted for anything. Deliveries are recorded before processing so a redelivery is visible,
 * and the event's own id deduplicates across deliveries.
 */
export const githubRoutes = (app: FastifyInstance, ctx: ServiceContext): void => {
  const auth = requireCaptureAuth(ctx.env);

  app.post('/webhooks/github', async (request, reply) => {
    const secret = ctx.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      // Refusing is safer than accepting unauthenticated events that create content.
      throw AppError.permanent(
        'E_WEBHOOK_DISABLED',
        'GITHUB_WEBHOOK_SECRET is not configured',
        503,
      );
    }

    const signature = request.headers['x-hub-signature-256'];
    const check = verifyGithubSignature(
      request.rawBody ?? Buffer.alloc(0),
      Array.isArray(signature) ? signature[0] : signature,
      secret,
    );
    if (!check.valid) {
      request.log.warn(
        { reason: check.reason },
        'rejected github webhook with an invalid signature',
      );
      return reply.code(401).send({
        error: { code: 'E_BAD_SIGNATURE', message: `signature ${check.reason}` },
        correlation_id: request.correlationId,
      });
    }

    const eventType = String(request.headers['x-github-event'] ?? '');
    const deliveryId = String(request.headers['x-github-delivery'] ?? '');
    if (!eventType || !deliveryId) {
      return reply.code(400).send({
        error: {
          code: 'E_MISSING_HEADERS',
          message: 'x-github-event and x-github-delivery are required',
        },
        correlation_id: request.correlationId,
      });
    }

    const delivery = await operations.recordWebhookDelivery(ctx.db, {
      provider: 'github',
      deliveryId,
      eventType,
      correlationId: request.correlationId,
    });

    if (!delivery.isNew) {
      // GitHub redelivers on timeouts; reprocessing would be harmless thanks to the external-id
      // constraint, but saying so explicitly makes the behavior observable.
      return reply
        .code(200)
        .send({ ok: true, status: 'duplicate_delivery', delivery_id: deliveryId });
    }

    const result = await ingestGithubEvent(
      ctx,
      { eventType, payload: request.body },
      { correlationId: request.correlationId },
    );

    if (!result.ok) {
      await operations.markWebhookProcessed(ctx.db, delivery.id, `failed: ${result.error.code}`);
      throw new AppError(result.error, 422);
    }

    await operations.markWebhookProcessed(ctx.db, delivery.id, result.value.status);
    return reply.code(result.value.status === 'captured' ? 201 : 200).send({
      ok: true,
      status: result.value.status,
      reason: result.value.reason,
      score: result.value.score,
      learning_event_id: result.value.learning_event?.id ?? null,
      repository: result.value.event?.repository ?? null,
      url: result.value.event?.url ?? null,
    });
  });

  /**
   * Manual override: replay an event the filter rejected, or one that never arrived.
   * Authenticated like the rest of the operator surface, not by GitHub signature.
   */
  app.post<{ Body: { event_type?: string; payload?: unknown } }>(
    '/github/opportunities/force',
    { preHandler: auth },
    async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body.event_type !== 'string' || body.payload === undefined) {
        throw AppError.permanent('E_INVALID_REQUEST', 'event_type and payload are required', 422);
      }

      const result = await forceGithubOpportunity(ctx, {
        eventType: body.event_type,
        payload: body.payload,
      });
      if (!result.ok) throw new AppError(result.error, 422);

      return reply.code(200).send({
        status: result.value.status,
        reason: result.value.reason,
        learning_event_id: result.value.learning_event?.id ?? null,
      });
    },
  );
};
