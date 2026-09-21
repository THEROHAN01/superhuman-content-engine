import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { operations } from '@sce/db';
import { AppError, safeEqual } from '@sce/utils';
import type { LlmAdapter, TelegramAdapter } from '@sce/adapters';
import {
  decodeCallbackData,
  recordDecision,
  sendForApproval,
  type ServiceContext,
} from '@sce/core';
import { requireCaptureAuth } from '../plugins/auth.js';

/**
 * Telegram transport.
 *
 * Every inbound update is authenticated with the secret token header, recorded as a webhook
 * delivery before it is processed (so a redelivery is visible), and answered even when the
 * decision turns out to be a duplicate - an unanswered callback query spins in the Telegram
 * client.
 */
const telegramUpdate = z.object({
  update_id: z.number(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({
        id: z.number(),
        username: z.string().optional(),
        first_name: z.string().optional(),
      }),
      message: z.object({ message_id: z.number(), chat: z.object({ id: z.number() }) }).optional(),
      data: z.string().optional(),
    })
    .optional(),
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({ id: z.number() }),
      from: z.object({ id: z.number(), username: z.string().optional() }).optional(),
      text: z.string().optional(),
    })
    .optional(),
});

/** From the operator's point of view these all mean the same thing: the card no longer applies. */
const STALE_CARD_CODES = new Set([
  'E_UNKNOWN_ACTION',
  'E_STALE_ACTION',
  'E_ITEM_NOT_FOUND',
  'E_ITEM_NOT_PENDING',
]);

export interface TelegramDeps {
  telegram: TelegramAdapter;
  llm: LlmAdapter;
}

export const telegramRoutes = (
  app: FastifyInstance,
  ctx: ServiceContext,
  deps: TelegramDeps,
): void => {
  const auth = requireCaptureAuth(ctx.env);

  app.post('/webhooks/telegram', async (request, reply) => {
    // 1. Authenticate. Telegram echoes the secret we registered with setWebhook.
    const configured = ctx.env.TELEGRAM_WEBHOOK_SECRET;
    if (configured) {
      const header = request.headers['x-telegram-bot-api-secret-token'];
      const provided = Array.isArray(header) ? header[0] : header;
      if (typeof provided !== 'string' || !safeEqual(provided, configured)) {
        return reply.code(401).send({
          error: { code: 'E_UNAUTHORIZED', message: 'invalid telegram secret token' },
          correlation_id: request.correlationId,
        });
      }
    }

    const parsed = telegramUpdate.safeParse(request.body);
    if (!parsed.success) {
      // Malformed updates are acknowledged with 200 so Telegram stops retrying, but recorded.
      await operations.recordError(ctx.db, {
        workflow: 'telegram_webhook_v1',
        step: 'parse',
        kind: 'permanent',
        code: 'E_INVALID_UPDATE',
        message: 'telegram update failed validation',
        correlationId: request.correlationId,
      });
      return reply.code(200).send({ ok: true, ignored: 'invalid update' });
    }

    const update = parsed.data;

    // 2. Record the delivery. A redelivered update_id is recognised rather than reprocessed.
    const delivery = await operations.recordWebhookDelivery(ctx.db, {
      provider: 'telegram',
      deliveryId: String(update.update_id),
      eventType: update.callback_query ? 'callback_query' : 'message',
      correlationId: request.correlationId,
    });

    if (!update.callback_query?.data) {
      await operations.markWebhookProcessed(ctx.db, delivery.id, 'ignored: not a decision');
      return reply.code(200).send({ ok: true, ignored: 'no callback data' });
    }

    const callback = update.callback_query;
    const decoded = decodeCallbackData(callback.data!);
    if (!decoded) {
      await deps.telegram.acknowledge({
        callbackQueryId: callback.id,
        text: 'This button is not recognised.',
      });
      await operations.markWebhookProcessed(ctx.db, delivery.id, 'ignored: unrecognised button');
      return reply.code(200).send({ ok: true, ignored: 'unrecognised callback data' });
    }

    const decidedBy =
      callback.from.username ?? callback.from.first_name ?? String(callback.from.id);

    // 3. Apply the decision. The action id is deterministic, so a duplicate press is a no-op.
    const result = await recordDecision(
      ctx,
      {
        actionId: decoded.actionId,
        action: decoded.action,
        decidedBy,
        channel: 'telegram',
        externalCallbackId: callback.id,
        // The item reference comes from the button payload itself - the only thing Telegram
        // returns - so the webhook needs no side channel to know what was decided.
        itemId: decoded.itemId,
      },
      { llm: deps.llm },
    );

    if (!result.ok) {
      await deps.telegram.acknowledge({
        callbackQueryId: callback.id,
        text: STALE_CARD_CODES.has(result.error.code)
          ? 'That card is out of date - the content has moved on.'
          : 'Could not apply that decision.',
      });
      await operations.markWebhookProcessed(ctx.db, delivery.id, `failed: ${result.error.code}`);
      return reply.code(200).send({ ok: true, error: result.error.code });
    }

    const { approval, item, applied } = result.value;
    await deps.telegram.acknowledge({
      callbackQueryId: callback.id,
      text: applied ? `Recorded: ${approval.action}` : `Already recorded: ${approval.action}`,
    });

    // 4. Replace the card so the chat shows the outcome and the buttons cannot be pressed again.
    if (applied && callback.message) {
      await deps.telegram.edit({
        chatId: String(callback.message.chat.id),
        messageId: String(callback.message.message_id),
        text: `Decision: <b>${approval.action}</b> by ${decidedBy}\nContent <code>${item.id}</code> is now <b>${item.status}</b>.`,
        removeButtons: true,
      });
    }

    await operations.markWebhookProcessed(
      ctx.db,
      delivery.id,
      `${approval.action}:${applied ? 'applied' : 'duplicate'}`,
    );
    return reply.code(200).send({
      ok: true,
      action: approval.action,
      applied,
      content_item_id: item.id,
      status: item.status,
    });
  });

  /** Sends the approval card for a gated item. */
  app.post<{ Params: { id: string }; Body: { chat_id?: string } }>(
    '/content-items/:id/request-approval',
    { preHandler: auth },
    async (request, reply) => {
      const chatId = request.body?.chat_id ?? ctx.env.TELEGRAM_CHAT_ID;
      if (!chatId) {
        throw AppError.permanent('E_NO_CHAT', 'TELEGRAM_CHAT_ID is not configured', 422);
      }

      const result = await sendForApproval(ctx, request.params.id, {
        telegram: deps.telegram,
        chatId,
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

      return reply.code(200).send({
        content_item_id: result.value.item.id,
        status: result.value.item.status,
        message_id: result.value.messageId,
        unchanged: result.value.unchanged,
      });
    },
  );

  /**
   * Applies a decision without Telegram - used by the CLI, by tests, and as the recovery path when
   * the bot is unavailable. Takes the same deterministic action id as the button.
   */
  app.post<{
    Params: { id: string };
    Body: { action?: string; decided_by?: string; note?: string; action_id?: string };
  }>('/content-items/:id/decide', { preHandler: auth }, async (request, reply) => {
    const body = request.body ?? {};
    const decoded = z
      .object({
        action: z.enum(['approve', 'reject', 'regenerate', 'request_change', 'schedule_review']),
        decided_by: z.string().min(1).max(120).default('operator'),
        note: z.string().max(2000).optional(),
        action_id: z.string().length(32).optional(),
      })
      .safeParse(body);

    if (!decoded.success) {
      throw AppError.permanent('E_INVALID_DECISION', 'decision payload is invalid', 422, {
        issues: decoded.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const { getContentItem } = await import('@sce/core');
    const item = await getContentItem(ctx, request.params.id);
    if (!item) {
      return reply.code(404).send({
        error: { code: 'E_NOT_FOUND', message: `no content item ${request.params.id}` },
        correlation_id: request.correlationId,
      });
    }

    const { actionId } = await import('@sce/core');
    const result = await recordDecision(
      ctx,
      {
        actionId: decoded.data.action_id ?? actionId(item.id, item.version, decoded.data.action),
        action: decoded.data.action,
        decidedBy: decoded.data.decided_by,
        channel: 'api',
        note: decoded.data.note ?? null,
        itemId: item.id,
      },
      { llm: deps.llm },
    );

    if (!result.ok) {
      throw new AppError(result.error, result.error.kind === 'permanent' ? 422 : 503);
    }

    return reply.code(200).send({
      content_item_id: result.value.item.id,
      status: result.value.item.status,
      action: result.value.approval.action,
      applied: result.value.applied,
      regenerated_item_id: result.value.regenerated_item_id ?? null,
    });
  });
};
