import { z } from 'zod';
import { METRIC_WINDOWS, PLATFORMS } from './enums.js';
import { idSchema, isoDateTime, timestamps } from './common.js';

/**
 * Normalized metrics. Every field is nullable on purpose: a metric a platform does not expose is
 * unknown, and recording it as 0 would silently corrupt every average built on top of it.
 */
export const normalizedMetrics = z.object({
  impressions: z.number().int().min(0).nullable(),
  reach: z.number().int().min(0).nullable(),
  reactions: z.number().int().min(0).nullable(),
  comments: z.number().int().min(0).nullable(),
  shares: z.number().int().min(0).nullable(),
  saves: z.number().int().min(0).nullable(),
  clicks: z.number().int().min(0).nullable(),
  profile_actions: z.number().int().min(0).nullable(),
  video_views: z.number().int().min(0).nullable(),
});
export type NormalizedMetrics = z.infer<typeof normalizedMetrics>;

export const analyticsEvent = z
  .object({
    id: idSchema('ae'),
    publication_id: idSchema('pb'),
    content_item_id: idSchema('it'),
    learning_event_id: idSchema('le'),
    platform: z.enum(PLATFORMS),
    metric_window: z.enum(METRIC_WINDOWS),
    /** The day the metrics describe (UTC date), separate from when they were fetched. */
    collected_for: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    collected_at: isoDateTime,
    provider: z.string().min(1).max(40),
    metrics: normalizedMetrics,
    /** Untouched provider payload, kept for traceability; never used for computation. */
    raw_payload: z.record(z.unknown()).nullable(),
  })
  .merge(timestamps);
export type AnalyticsEvent = z.infer<typeof analyticsEvent>;

/** Derived metrics are computed only when the denominator exists. */
export const derivedMetrics = z.object({
  engagement_rate: z.number().min(0).nullable(),
  comment_rate: z.number().min(0).nullable(),
  save_rate: z.number().min(0).nullable(),
});
export type DerivedMetrics = z.infer<typeof derivedMetrics>;
