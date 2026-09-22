import { createAnalyticsAdapter } from '@sce/adapters';
import { collectAnalytics, collectDuePublications, type ServiceContext } from '@sce/core';
import type { MetricWindow } from '@sce/schemas';

/**
 * Analytics collection job.
 *
 * With a publication id it collects for that one post; without, it sweeps everything measurable.
 * Either way a provider failure on one publication is recorded and the sweep continues - a partial
 * collection is far more useful than an aborted one.
 */
export const collectAnalyticsJob = async (
  ctx: ServiceContext,
  payload: Record<string, unknown>,
): Promise<unknown> => {
  const adapter = createAnalyticsAdapter(ctx.env);
  const window = (
    typeof payload['window'] === 'string' ? payload['window'] : '24h'
  ) as MetricWindow;
  const collectedFor =
    typeof payload['collected_for'] === 'string' ? payload['collected_for'] : undefined;

  if (typeof payload['publication_id'] === 'string') {
    const result = await collectAnalytics(ctx, payload['publication_id'], {
      analytics: adapter,
      window,
      ...(collectedFor ? { collectedFor } : {}),
    });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return { publication_id: payload['publication_id'], inserted: result.value.inserted };
  }

  const sweep = await collectDuePublications(ctx, {
    analytics: adapter,
    window,
    ...(collectedFor ? { collectedFor } : {}),
  });

  // A sweep where nothing succeeded but something was attempted is a failure worth retrying.
  if (sweep.attempted > 0 && sweep.collected === 0) {
    throw new Error(`analytics sweep collected nothing from ${sweep.attempted} publication(s)`);
  }
  return sweep;
};
