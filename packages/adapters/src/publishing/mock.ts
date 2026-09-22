import { permanent, type Result } from '@sce/utils';
import type { PublishPayload, PublishReceipt, PublishingAdapter } from './types.js';

/**
 * In-memory publisher.
 *
 * It is idempotent in the same way a well-behaved provider should be: scheduling the same
 * idempotency key twice returns the first receipt rather than creating a second post. That makes
 * the duplicate-publication tests meaningful without a real provider.
 */
export interface MockPublishingAdapter extends PublishingAdapter {
  readonly posts: Map<string, PublishPayload & { externalId: string; cancelled: boolean }>;
  reset(): void;
}

export const createMockPublishingAdapter = (): MockPublishingAdapter => {
  const posts = new Map<string, PublishPayload & { externalId: string; cancelled: boolean }>();
  let counter = 0;

  return {
    name: 'mock',
    simulated: true,
    posts,
    reset() {
      posts.clear();
      counter = 0;
    },

    async schedule(payload: PublishPayload): Promise<Result<PublishReceipt>> {
      const existing = [...posts.values()].find(
        (post) => post.idempotencyKey === payload.idempotencyKey,
      );
      if (existing) {
        return {
          ok: true,
          value: {
            externalId: existing.externalId,
            externalUrl: `https://mock.invalid/posts/${existing.externalId}`,
            status: 'scheduled',
            metadata: { duplicate: true, provider: 'mock' },
          },
        };
      }

      counter += 1;
      const externalId = `mock-post-${counter}`;
      posts.set(externalId, { ...payload, externalId, cancelled: false });

      return {
        ok: true,
        value: {
          externalId,
          // .invalid is reserved by RFC 2606: a mock URL can never resolve to a real post.
          externalUrl: `https://mock.invalid/posts/${externalId}`,
          status: 'scheduled',
          metadata: { provider: 'mock', platform: payload.platform, units: payload.units.length },
        },
      };
    },

    async cancel(externalId: string): Promise<Result<void>> {
      const post = posts.get(externalId);
      if (!post) {
        return { ok: false, error: permanent('E_PUBLISH_NOT_FOUND', `no mock post ${externalId}`) };
      }
      post.cancelled = true;
      return { ok: true, value: undefined };
    },
  };
};
