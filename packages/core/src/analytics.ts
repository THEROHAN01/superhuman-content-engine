import { analytics, operations, publications } from '@sce/db';
import type { AnalyticsAdapter } from '@sce/adapters';
import { newId, permanent, withRetry, type Result } from '@sce/utils';
import type { AnalyticsEvent, DerivedMetrics, MetricWindow, NormalizedMetrics } from '@sce/schemas';
import type { ServiceContext } from './context.js';

/**
 * Analytics collection.
 *
 * The rule that shapes this module: **unknown is not zero**. A metric the platform does not expose
 * stays `null` all the way through storage and into derived figures, which are only computed when
 * their denominator actually exists. A provider outage is recorded as a failure, never as a
 * collection of zeroes.
 */
export interface CollectOptions {
  analytics: AnalyticsAdapter;
  window?: MetricWindow;
  /** The UTC day these metrics describe; defaults to today. */
  collectedFor?: string;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CollectResult {
  event: AnalyticsEvent;
  /** False when a collection for this publication/window/day already existed and was refreshed. */
  inserted: boolean;
  simulated: boolean;
}

const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

export const collectAnalytics = async (
  ctx: ServiceContext,
  publicationId: string,
  options: CollectOptions,
): Promise<Result<CollectResult>> => {
  const publication = await publications.findPublication(ctx.db, publicationId);
  if (!publication) {
    return {
      ok: false,
      error: permanent('E_PUBLICATION_NOT_FOUND', `no publication ${publicationId}`),
    };
  }

  // Nothing was sent anywhere, so there is nothing to measure. Saying so is better than
  // collecting zeroes for a post that does not exist.
  if (!publication.external_id) {
    return {
      ok: false,
      error: permanent(
        'E_NO_EXTERNAL_ID',
        `publication ${publicationId} has no provider id to measure`,
      ),
    };
  }
  if (publication.status !== 'published' && publication.status !== 'scheduled') {
    return {
      ok: false,
      error: permanent('E_NOT_PUBLISHED', `publication ${publicationId} is ${publication.status}`, {
        status: publication.status,
      }),
    };
  }

  const window = options.window ?? '24h';
  const collectedFor = options.collectedFor ?? utcDay(ctx.clock());
  const correlationId = publication.correlation_id;

  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'analytics_collect_v1',
    correlationId,
    subjectId: publication.id,
    input: { window, collected_for: collectedFor, provider: options.analytics.name },
  });

  const attempt = await withRetry(
    () =>
      options.analytics.fetch({
        publicationId: publication.id,
        externalId: publication.external_id!,
        platform: publication.platform,
        window,
        collectedFor,
        correlationId,
      }),
    {
      attempts: options.attempts ?? 3,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      onRetry: ({ attempt: n, failure }) =>
        ctx.logger.warn(
          { attempt: n, code: failure.code, publication_id: publication.id },
          'analytics retry',
        ),
    },
  );

  if (!attempt.ok) {
    // A failed collection writes an error row and nothing else. It must never look like a
    // collection that found zeroes.
    await operations.recordError(ctx.db, {
      workflow: 'analytics_collect_v1',
      step: 'fetch',
      kind: attempt.error.kind,
      code: attempt.error.code,
      message: attempt.error.message,
      correlationId,
      subjectId: publication.id,
      details: { window, collected_for: collectedFor },
    });
    await operations.finishWorkflowRun(ctx.db, runId, 'failed', { code: attempt.error.code });
    return { ok: false, error: attempt.error };
  }

  const { event, inserted } = await analytics.upsertAnalyticsEvent(ctx.db, {
    id: newId('analyticsEvent'),
    publication_id: publication.id,
    content_item_id: publication.content_item_id,
    learning_event_id: publication.learning_event_id,
    platform: publication.platform,
    metric_window: window,
    collected_for: collectedFor,
    provider: options.analytics.name,
    metrics: attempt.value.metrics,
    raw_payload: attempt.value.raw,
  });

  ctx.logger.info(
    {
      publication_id: publication.id,
      window,
      collected_for: collectedFor,
      inserted,
      known_metrics: Object.values(attempt.value.metrics).filter((v) => v !== null).length,
    },
    'analytics collected',
  );
  await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', { inserted, window });

  return { ok: true, value: { event, inserted, simulated: options.analytics.simulated } };
};

export interface SweepResult {
  attempted: number;
  collected: number;
  failed: Array<{ publication_id: string; code: string }>;
}

/**
 * Collects for every publication that has something to measure. Used by the worker on a schedule
 * and by the end-to-end path; a provider failure on one publication never stops the others.
 */
export const collectDuePublications = async (
  ctx: ServiceContext,
  options: CollectOptions & { limit?: number },
): Promise<SweepResult> => {
  const candidates = [
    ...(await publications.listPublications(ctx.db, {
      status: 'published',
      limit: options.limit ?? 50,
    })),
    ...(await publications.listPublications(ctx.db, {
      status: 'scheduled',
      limit: options.limit ?? 50,
    })),
  ].filter((publication) => publication.external_id !== null);

  const result: SweepResult = { attempted: 0, collected: 0, failed: [] };
  for (const publication of candidates) {
    result.attempted += 1;
    const collected = await collectAnalytics(ctx, publication.id, options);
    if (collected.ok) {
      result.collected += 1;
    } else {
      result.failed.push({ publication_id: publication.id, code: collected.error.code });
    }
  }
  return result;
};

/**
 * Derived metrics.
 *
 * Every ratio is `null` unless its denominator is a real, positive number. A post with unknown
 * impressions has an unknown engagement rate - not a zero, and not an omission that averages to
 * something flattering.
 */
export const deriveMetrics = (metrics: NormalizedMetrics): DerivedMetrics => {
  const denominator = metrics.impressions ?? metrics.reach;
  if (denominator === null || denominator <= 0) {
    return { engagement_rate: null, comment_rate: null, save_rate: null };
  }

  const engagementParts = [metrics.reactions, metrics.comments, metrics.shares].filter(
    (value): value is number => value !== null,
  );

  return {
    engagement_rate:
      engagementParts.length > 0
        ? Number((engagementParts.reduce((sum, value) => sum + value, 0) / denominator).toFixed(5))
        : null,
    comment_rate:
      metrics.comments === null ? null : Number((metrics.comments / denominator).toFixed(5)),
    save_rate: metrics.saves === null ? null : Number((metrics.saves / denominator).toFixed(5)),
  };
};

export const listAnalyticsForItem = async (ctx: ServiceContext, itemId: string) =>
  analytics.listAnalyticsForItem(ctx.db, itemId);

export const listAnalyticsForPublication = async (ctx: ServiceContext, publicationId: string) =>
  analytics.listAnalyticsForPublication(ctx.db, publicationId);
