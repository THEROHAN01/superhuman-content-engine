import { createTelegramAdapterFor } from '@sce/adapters';
import { deliverWeeklyReport, generateWeeklyReport, type ServiceContext } from '@sce/core';

/**
 * Weekly intelligence job.
 *
 * Generation and delivery are separate steps on purpose: if Telegram is down, the report still
 * exists and is marked `failed` for delivery only, so a retry sends the same report rather than
 * recomputing a different one.
 */
export const weeklyReportJob = async (
  ctx: ServiceContext,
  payload: Record<string, unknown>,
): Promise<unknown> => {
  const at = typeof payload['at'] === 'string' ? new Date(payload['at']) : undefined;
  const generated = await generateWeeklyReport(ctx, at ? { at } : {});
  if (!generated.ok) throw new Error(`${generated.error.code}: ${generated.error.message}`);

  const report = generated.value.report;
  const chatId = ctx.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    return {
      report_id: report.id,
      period: report.period_key,
      delivered: false,
      reason: 'no chat configured',
    };
  }

  const delivered = await deliverWeeklyReport(ctx, report.id, {
    telegram: createTelegramAdapterFor(ctx.env),
    chatId,
  });
  if (!delivered.ok) throw new Error(`${delivered.error.code}: ${delivered.error.message}`);

  return { report_id: report.id, period: report.period_key, delivered: true };
};
