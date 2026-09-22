import type { Env } from '@sce/utils';
import { transient } from '@sce/utils';
import type { AnalyticsAdapter } from './types.js';
import { createMockAnalyticsAdapter } from './mock.js';
import { createPostizAnalyticsAdapter } from './postiz.js';

export * from './types.js';
export { createMockAnalyticsAdapter } from './mock.js';
export { createPostizAnalyticsAdapter } from './postiz.js';

export const createFailingAnalyticsAdapter = (): AnalyticsAdapter => ({
  name: 'failing',
  simulated: true,
  async fetch() {
    return {
      ok: false,
      error: transient('E_ANALYTICS_UNREACHABLE', 'analytics provider is configured to fail'),
    };
  },
});

/**
 * Analytics follows the publishing provider: metrics come from wherever the post was published.
 * A mock publication can only have mock metrics.
 */
export const createAnalyticsAdapter = (
  env: Env,
  overrides: { fetchImpl?: typeof fetch } = {},
): AnalyticsAdapter => {
  switch (env.PUBLISHING_PROVIDER) {
    case 'postiz':
      return createPostizAnalyticsAdapter({
        baseUrl: env.POSTIZ_BASE_URL!,
        apiKey: env.POSTIZ_API_KEY!,
        timeoutMs: env.POSTIZ_TIMEOUT_MS,
        ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      });
    case 'failing':
      return createFailingAnalyticsAdapter();
    case 'mock':
    default:
      return createMockAnalyticsAdapter();
  }
};
