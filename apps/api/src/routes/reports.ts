import type { FastifyInstance } from 'fastify';
import { AppError } from '@sce/utils';
import type { TelegramAdapter } from '@sce/adapters';
import {
  deliverWeeklyReport,
  findWeeklyReport,
  generateWeeklyReport,
  listWeeklyReports,
  renderWeeklyReport,
  type ServiceContext,
} from '@sce/core';
import { requireCaptureAuth } from '../plugins/auth.js';

/**
 * Weekly intelligence routes. Generation is idempotent per ISO week and generator version:
 * regenerating refreshes the same report rather than creating a near-duplicate.
 */
export const reportRoutes = (
  app: FastifyInstance,
  ctx: ServiceContext,
  deps: { telegram: TelegramAdapter },
): void => {
  const auth = requireCaptureAuth(ctx.env);

  app.post<{ Body: { at?: string; deliver?: boolean; chat_id?: string } }>(
    '/reports/weekly',
    { preHandler: auth },
    async (request, reply) => {
      const at = request.body?.at ? new Date(request.body.at) : undefined;
      if (at && Number.isNaN(at.getTime())) {
        throw AppError.permanent('E_INVALID_DATE', 'at must be an ISO-8601 timestamp', 422);
      }

      const generated = await generateWeeklyReport(ctx, at ? { at } : {});
      if (!generated.ok) throw new AppError(generated.error, 503);

      const report = generated.value.report;
      let delivery: { delivered: boolean; error?: string } = { delivered: false };

      if (request.body?.deliver === true) {
        const chatId = request.body.chat_id ?? ctx.env.TELEGRAM_CHAT_ID;
        if (!chatId) {
          throw AppError.permanent('E_NO_CHAT', 'TELEGRAM_CHAT_ID is not configured', 422);
        }
        const sent = await deliverWeeklyReport(ctx, report.id, { telegram: deps.telegram, chatId });
        delivery = sent.ok
          ? { delivered: true }
          : { delivered: false, error: `${sent.error.code}: ${sent.error.message}` };
      }

      return reply.code(generated.value.inserted ? 201 : 200).send({
        report_id: report.id,
        period_key: report.period_key,
        period_start: report.period_start,
        period_end: report.period_end,
        timezone: report.timezone,
        inserted: generated.value.inserted,
        delivery,
        counts: report.body.counts,
        signals: report.body.signals,
      });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/reports/weekly/:id',
    { preHandler: auth },
    async (request, reply) => {
      const report = await findWeeklyReport(ctx, request.params.id);
      if (!report) {
        return reply.code(404).send({
          error: { code: 'E_NOT_FOUND', message: `no weekly report ${request.params.id}` },
          correlation_id: request.correlationId,
        });
      }

      if (request.query.format === 'text') {
        return reply.type('text/plain; charset=utf-8').send(renderWeeklyReport(report));
      }
      return report;
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    '/reports/weekly',
    { preHandler: auth },
    async (request) => {
      const limit = request.query.limit ? Number(request.query.limit) : 20;
      const reports = await listWeeklyReports(ctx, Number.isFinite(limit) ? limit : 20);
      return {
        count: reports.length,
        reports: reports.map((report) => ({
          id: report.id,
          period_key: report.period_key,
          status: report.status,
          published: report.body.counts.published,
          learning_events: report.body.counts.learning_events,
          created_at: report.created_at,
        })),
      };
    },
  );
};
