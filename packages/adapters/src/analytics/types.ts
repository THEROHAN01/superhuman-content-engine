import type { AppFailure, Result } from '@sce/utils';
import type { MetricWindow, NormalizedMetrics, Platform } from '@sce/schemas';

/**
 * The analytics boundary.
 *
 * The contract that matters here is about *absence*: a metric a platform does not expose must come
 * back `null`, never `0`. A zero is a measurement; a null is an admission. Confusing the two
 * silently corrupts every average built on top of them.
 */
export interface MetricsQuery {
  publicationId: string;
  externalId: string;
  platform: Platform;
  window: MetricWindow;
  /** The UTC day the metrics describe (YYYY-MM-DD). */
  collectedFor: string;
  correlationId?: string;
}

export interface MetricsResult {
  metrics: NormalizedMetrics;
  /** Untouched provider payload, kept for traceability. Never used for computation. */
  raw: Record<string, unknown> | null;
}

export interface AnalyticsAdapter {
  readonly name: string;
  /** True when the numbers are synthetic and must not be presented as real performance. */
  readonly simulated: boolean;
  fetch(query: MetricsQuery): Promise<Result<MetricsResult, AppFailure>>;
}

/** Every metric unknown - the honest starting point for any provider mapping. */
export const EMPTY_METRICS: NormalizedMetrics = {
  impressions: null,
  reach: null,
  reactions: null,
  comments: null,
  shares: null,
  saves: null,
  clicks: null,
  profile_actions: null,
  video_views: null,
};

/**
 * Which metrics each platform can actually report. Anything outside this set stays null even if a
 * provider invents a value for it.
 */
export const PLATFORM_METRICS: Record<Platform, Array<keyof NormalizedMetrics>> = {
  x: ['impressions', 'reactions', 'comments', 'shares', 'clicks', 'profile_actions'],
  linkedin: ['impressions', 'reactions', 'comments', 'shares', 'clicks'],
  instagram: ['reach', 'reactions', 'comments', 'shares', 'saves', 'video_views'],
};

/** Drops values the platform cannot report, so an over-eager mapping cannot invent coverage. */
export const restrictToPlatform = (
  platform: Platform,
  metrics: NormalizedMetrics,
): NormalizedMetrics => {
  const allowed = new Set(PLATFORM_METRICS[platform]);
  const result: NormalizedMetrics = { ...EMPTY_METRICS };
  for (const key of Object.keys(metrics) as Array<keyof NormalizedMetrics>) {
    if (allowed.has(key)) result[key] = metrics[key];
  }
  return result;
};
