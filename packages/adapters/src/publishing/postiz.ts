import { permanent, transient, type Result } from '@sce/utils';
import type { PublishPayload, PublishReceipt, PublishingAdapter } from './types.js';

/**
 * Postiz publishing adapter.
 *
 * ASSUMED CONTRACT - see docs/external-apis.md. The endpoint and payload shape below follow
 * Postiz's public API as documented at the time of writing, but they have not been exercised
 * against a live instance from this environment. Verify against your own instance before enabling
 * live publishing; the request shape is isolated here precisely so that verification touches one
 * file.
 *
 *   POST {baseUrl}/public/v1/posts     Authorization: <api key>
 *   DELETE {baseUrl}/public/v1/posts/{id}
 */
export interface PostizOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /** Provider-side integration ids per platform, from configuration. */
  integrations?: Partial<Record<string, string>>;
  fetchImpl?: typeof fetch;
}

interface PostizPostResponse {
  id?: string;
  postId?: string;
  url?: string;
  state?: string;
  error?: string;
  message?: string;
}

const classify = (status: number, body: string): ReturnType<typeof transient> => {
  const details = { status, preview: body.slice(0, 200) };
  return status === 429 || status >= 500
    ? transient('E_PUBLISH_HTTP', `postiz returned ${status}`, details)
    : permanent('E_PUBLISH_HTTP', `postiz returned ${status}`, details);
};

export const createPostizAdapter = (options: PostizOptions): PublishingAdapter => ({
  name: 'postiz',
  simulated: false,

  async schedule(payload: PublishPayload): Promise<Result<PublishReceipt>> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const integrationId = options.integrations?.[payload.platform];

    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/public/v1/posts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Postiz authenticates with the raw API key in the Authorization header.
          authorization: options.apiKey,
          // Sent so a retry is deduplicated provider-side as well as by our own unique index.
          'idempotency-key': payload.idempotencyKey,
        },
        signal: AbortSignal.timeout(options.timeoutMs),
        body: JSON.stringify({
          type: 'schedule',
          date: payload.scheduledAt,
          shortLink: false,
          posts: [
            {
              ...(integrationId ? { integration: { id: integrationId } } : {}),
              value: (payload.units.length > 0 ? payload.units : [payload.body]).map((content) => ({
                content,
              })),
            },
          ],
          ...(payload.options ?? {}),
        }),
      });
    } catch (error) {
      return {
        ok: false,
        error: transient(
          'E_PUBLISH_UNREACHABLE',
          'postiz request failed',
          { timeoutMs: options.timeoutMs },
          error,
        ),
      };
    }

    const text = await response.text();
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const failure = classify(response.status, text);
      if (Number.isFinite(retryAfter) && retryAfter > 0 && failure.kind === 'transient') {
        failure.details = { ...failure.details, retryAfterMs: retryAfter * 1000 };
      }
      return { ok: false, error: failure };
    }

    let payloadBody: PostizPostResponse | PostizPostResponse[];
    try {
      payloadBody = JSON.parse(text) as PostizPostResponse | PostizPostResponse[];
    } catch (error) {
      return {
        ok: false,
        error: permanent('E_PUBLISH_BAD_RESPONSE', 'postiz returned a non-JSON body', {}, error),
      };
    }

    const first = Array.isArray(payloadBody) ? payloadBody[0] : payloadBody;
    const externalId = first?.id ?? first?.postId;
    if (!externalId) {
      // Without a provider id we cannot tell a retry from a duplicate, so this is a hard failure.
      return {
        ok: false,
        error: permanent('E_PUBLISH_NO_ID', 'postiz accepted the post but returned no id', {
          preview: text.slice(0, 200),
        }),
      };
    }

    return {
      ok: true,
      value: {
        externalId: String(externalId),
        externalUrl: first?.url ?? null,
        status: 'scheduled',
        metadata: { provider: 'postiz', state: first?.state ?? null },
      },
    };
  },

  async cancel(externalId: string): Promise<Result<void>> {
    const fetchImpl = options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(
        `${options.baseUrl.replace(/\/$/, '')}/public/v1/posts/${encodeURIComponent(externalId)}`,
        {
          method: 'DELETE',
          headers: { authorization: options.apiKey },
          signal: AbortSignal.timeout(options.timeoutMs),
        },
      );
    } catch (error) {
      return {
        ok: false,
        error: transient('E_PUBLISH_UNREACHABLE', 'postiz cancel failed', {}, error),
      };
    }

    if (!response.ok && response.status !== 404) {
      return { ok: false, error: classify(response.status, await response.text()) };
    }
    return { ok: true, value: undefined };
  },
});
