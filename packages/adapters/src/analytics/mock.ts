import { createHash } from 'node:crypto';
import type { AnalyticsAdapter, MetricsQuery, MetricsResult } from './types.js';
import { EMPTY_METRICS, PLATFORM_METRICS, restrictToPlatform } from './types.js';
import type { Result } from '@sce/utils';

/**
 * Deterministic offline metrics.
 *
 * Same publication and window always produce the same numbers, so reports are reproducible and
 * fixtures mean something. It reports only what the platform can actually expose, and deliberately
 * leaves one supported metric null per platform - the pipeline must handle "unknown" as a normal
 * state, not as an edge case that never occurs in development.
 */
const pseudoValue = (seed: string, min: number, max: number): number => {
  const digest = createHash('sha256').update(seed).digest();
  const value = digest.readUInt32BE(0) / 0xffffffff;
  return Math.round(min + value * (max - min));
};

const WINDOW_SCALE: Record<string, number> = { '24h': 1, '7d': 3.2, '30d': 6.5, lifetime: 8 };

export const createMockAnalyticsAdapter = (): AnalyticsAdapter => ({
  name: 'mock',
  simulated: true,

  async fetch(query: MetricsQuery): Promise<Result<MetricsResult>> {
    const scale = WINDOW_SCALE[query.window] ?? 1;
    const seed = `${query.externalId}:${query.window}:${query.collectedFor}`;
    const impressions = Math.round(pseudoValue(seed, 120, 4200) * scale);

    const metrics = { ...EMPTY_METRICS };
    // The last supported metric is left unknown on purpose: providers rarely expose everything.
    const supported = PLATFORM_METRICS[query.platform].slice(0, -1);

    for (const key of supported) {
      switch (key) {
        case 'impressions':
          metrics.impressions = impressions;
          break;
        case 'reach':
          metrics.reach = Math.round(impressions * 0.82);
          break;
        case 'reactions':
          metrics.reactions = pseudoValue(
            `${seed}:reactions`,
            0,
            Math.max(1, Math.round(impressions * 0.06)),
          );
          break;
        case 'comments':
          metrics.comments = pseudoValue(
            `${seed}:comments`,
            0,
            Math.max(1, Math.round(impressions * 0.01)),
          );
          break;
        case 'shares':
          metrics.shares = pseudoValue(
            `${seed}:shares`,
            0,
            Math.max(1, Math.round(impressions * 0.015)),
          );
          break;
        case 'saves':
          metrics.saves = pseudoValue(
            `${seed}:saves`,
            0,
            Math.max(1, Math.round(impressions * 0.02)),
          );
          break;
        case 'clicks':
          metrics.clicks = pseudoValue(
            `${seed}:clicks`,
            0,
            Math.max(1, Math.round(impressions * 0.03)),
          );
          break;
        case 'video_views':
          metrics.video_views = Math.round(impressions * 0.4);
          break;
        default:
          break;
      }
    }

    return {
      ok: true,
      value: {
        metrics: restrictToPlatform(query.platform, metrics),
        raw: { provider: 'mock', seed, note: 'synthetic metrics - not real performance data' },
      },
    };
  },
});
