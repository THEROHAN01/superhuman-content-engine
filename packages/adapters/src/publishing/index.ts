import type { Env } from '@sce/utils';
import { transient } from '@sce/utils';
import type { PublishingAdapter } from './types.js';
import { createMockPublishingAdapter } from './mock.js';
import { createPostizAdapter } from './postiz.js';

export * from './types.js';
export { createMockPublishingAdapter, type MockPublishingAdapter } from './mock.js';
export { createPostizAdapter } from './postiz.js';

export const createFailingPublishingAdapter = (): PublishingAdapter => ({
  name: 'failing',
  simulated: true,
  async schedule() {
    return {
      ok: false,
      error: transient('E_PUBLISH_UNREACHABLE', 'publishing provider is configured to fail'),
    };
  },
  async cancel() {
    return {
      ok: false,
      error: transient('E_PUBLISH_UNREACHABLE', 'publishing provider is configured to fail'),
    };
  },
});

export const createPublishingAdapter = (
  env: Env,
  overrides: { fetchImpl?: typeof fetch } = {},
): PublishingAdapter => {
  switch (env.PUBLISHING_PROVIDER) {
    case 'postiz':
      return createPostizAdapter({
        baseUrl: env.POSTIZ_BASE_URL!,
        apiKey: env.POSTIZ_API_KEY!,
        timeoutMs: env.POSTIZ_TIMEOUT_MS,
        ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      });
    case 'failing':
      return createFailingPublishingAdapter();
    case 'mock':
    default:
      return createMockPublishingAdapter();
  }
};
