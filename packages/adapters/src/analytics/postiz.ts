import { permanent, transient, type Result } from '@sce/utils';
import type { AnalyticsAdapter, MetricsQuery, MetricsResult } from './types.js';
import { EMPTY_METRICS, restrictToPlatform } from './types.js';

/**
 * Postiz analytics adapter.
 *
 * ASSUMED CONTRACT - see docs/external-apis.md. Postiz aggregates per-platform metrics, but the
 * exact response shape depends on the instance and the connected integrations, so the mapping
 * below is written defensively: anything not recognised stays `null` rather than being guessed at,
 * and the raw payload is preserved so a mapping can be corrected retrospectively.
 *
 *   GET {baseUrl}/public/v1/posts/{id}   Authorization: <api key>
 */
export interface PostizAnalyticsOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Reads a numeric metric under any of several plausible keys; absence stays absence. */
const readNumber = (source: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
};

export const createPostizAnalyticsAdapter = (
  options: PostizAnalyticsOptions,
): AnalyticsAdapter => ({
  name: 'postiz',
  simulated: false,

  async fetch(query: MetricsQuery): Promise<Result<MetricsResult>> {
    const fetchImpl = options.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await fetchImpl(
        `${options.baseUrl.replace(/\/$/, '')}/public/v1/posts/${encodeURIComponent(query.externalId)}`,
        {
          headers: { authorization: options.apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(options.timeoutMs),
        },
      );
    } catch (error) {
      return {
        ok: false,
        error: transient('E_ANALYTICS_UNREACHABLE', 'postiz analytics request failed', {}, error),
      };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const details = { status: response.status, preview: body.slice(0, 200) };
      return {
        ok: false,
        error:
          response.status === 429 || response.status >= 500
            ? transient('E_ANALYTICS_HTTP', `postiz returned ${response.status}`, details)
            : permanent('E_ANALYTICS_HTTP', `postiz returned ${response.status}`, details),
      };
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      return {
        ok: false,
        error: permanent('E_ANALYTICS_BAD_RESPONSE', 'postiz returned a non-JSON body', {}, error),
      };
    }

    const stats =
      (payload['statistics'] as Record<string, unknown>) ??
      (payload['analytics'] as Record<string, unknown>) ??
      payload;

    const metrics = {
      ...EMPTY_METRICS,
      impressions: readNumber(stats, ['impressions', 'views', 'impression_count']),
      reach: readNumber(stats, ['reach', 'unique_views']),
      reactions: readNumber(stats, ['likes', 'reactions', 'favorite_count']),
      comments: readNumber(stats, ['comments', 'replies', 'reply_count']),
      shares: readNumber(stats, ['shares', 'reposts', 'retweet_count']),
      saves: readNumber(stats, ['saves', 'bookmarks', 'bookmark_count']),
      clicks: readNumber(stats, ['clicks', 'link_clicks', 'url_link_clicks']),
      profile_actions: readNumber(stats, ['profile_clicks', 'profile_visits']),
      video_views: readNumber(stats, ['video_views', 'plays']),
    };

    return {
      ok: true,
      value: { metrics: restrictToPlatform(query.platform, metrics), raw: payload },
    };
  },
});
