import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '@sce/utils';
import {
  createFailingPublishingAdapter,
  createMockPublishingAdapter,
  createPostizAdapter,
  createPublishingAdapter,
} from './index.js';

const payload = {
  idempotencyKey: 'a'.repeat(64),
  platform: 'x' as const,
  body: 'A post body.',
  units: ['A post body.'],
  scheduledAt: '2026-09-22T09:00:00.000Z',
};

describe('mock publishing adapter', () => {
  it('returns the first receipt when the same idempotency key is scheduled twice', async () => {
    const adapter = createMockPublishingAdapter();
    const first = await adapter.schedule(payload);
    const second = await adapter.schedule(payload);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.externalId).toBe(first.value.externalId);
    expect(second.value.metadata['duplicate']).toBe(true);
    expect(adapter.posts.size).toBe(1);
  });

  it('marks itself simulated and uses a reserved domain that cannot resolve', async () => {
    const adapter = createMockPublishingAdapter();
    expect(adapter.simulated).toBe(true);
    const result = await adapter.schedule(payload);
    expect(result.ok && new URL(result.value.externalUrl!).hostname.endsWith('.invalid')).toBe(
      true,
    );
  });

  it('cancels a known post and refuses an unknown one', async () => {
    const adapter = createMockPublishingAdapter();
    const scheduled = await adapter.schedule(payload);
    if (!scheduled.ok) return;

    expect((await adapter.cancel(scheduled.value.externalId)).ok).toBe(true);
    const missing = await adapter.cancel('nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('E_PUBLISH_NOT_FOUND');
  });
});

describe('postiz adapter', () => {
  const base = { baseUrl: 'https://postiz.test', apiKey: 'secret-api-key', timeoutMs: 1000 };

  it('posts the schedule request with the api key and an idempotency header', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://postiz.test/public/v1/posts');
      const headers = init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe('secret-api-key');
      expect(headers['idempotency-key']).toBe(payload.idempotencyKey);
      const body = JSON.parse(String(init?.body)) as {
        date: string;
        posts: Array<{ value: Array<{ content: string }> }>;
      };
      expect(body.date).toBe(payload.scheduledAt);
      expect(body.posts[0]!.value[0]!.content).toBe('A post body.');
      return new Response(JSON.stringify({ id: 'postiz-1', url: 'https://x.com/u/status/1' }), {
        status: 200,
      });
    });

    const result = await createPostizAdapter({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).schedule(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.externalId).toBe('postiz-1');
      expect(result.value.externalUrl).toBe('https://x.com/u/status/1');
    }
  });

  it('sends each thread unit as its own content entry', async () => {
    let captured = '';
    await createPostizAdapter({
      ...base,
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        captured = String(init.body);
        return new Response(JSON.stringify({ id: 'p1' }), { status: 200 });
      }) as unknown as typeof fetch,
    }).schedule({ ...payload, units: ['one', 'two', 'three'] });

    const body = JSON.parse(captured) as { posts: Array<{ value: Array<{ content: string }> }> };
    expect(body.posts[0]!.value.map((v) => v.content)).toEqual(['one', 'two', 'three']);
  });

  it('treats a response without an id as a permanent failure', async () => {
    const result = await createPostizAdapter({
      ...base,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ state: 'QUEUE' }), {
          status: 200,
        })) as unknown as typeof fetch,
    }).schedule(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('E_PUBLISH_NO_ID');
      expect(result.error.kind).toBe('permanent');
    }
  });

  it('classifies 429 and 5xx as transient and 4xx as permanent', async () => {
    const withStatus = (status: number, headers: Record<string, string> = {}) =>
      createPostizAdapter({
        ...base,
        fetchImpl: (async () =>
          new Response('error body', { status, headers })) as unknown as typeof fetch,
      }).schedule(payload);

    const limited = await withStatus(429, { 'retry-after': '30' });
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.error.kind).toBe('transient');
      expect(limited.error.details?.['retryAfterMs']).toBe(30_000);
    }

    const server = await withStatus(503);
    if (!server.ok) expect(server.error.kind).toBe('transient');

    const client = await withStatus(422);
    if (!client.ok) expect(client.error.kind).toBe('permanent');
  });

  it('treats a timeout as transient', async () => {
    const result = await createPostizAdapter({
      ...base,
      fetchImpl: (async () => {
        throw new DOMException('aborted', 'TimeoutError');
      }) as unknown as typeof fetch,
    }).schedule(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_PUBLISH_UNREACHABLE');
  });

  it('never leaks the api key into an error', async () => {
    const result = await createPostizAdapter({
      ...base,
      fetchImpl: (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch,
    }).schedule(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain(base.apiKey);
  });

  it('treats cancelling an already-deleted post as success', async () => {
    const result = await createPostizAdapter({
      ...base,
      fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    }).cancel('postiz-1');
    expect(result.ok).toBe(true);
  });
});

describe('provider selection', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/sce' };

  it('defaults to the simulated mock', () => {
    const adapter = createPublishingAdapter(parseEnv(base as NodeJS.ProcessEnv));
    expect(adapter.name).toBe('mock');
    expect(adapter.simulated).toBe(true);
  });

  it('selects postiz when configured, and it is not simulated', () => {
    const env = parseEnv({
      ...base,
      PUBLISHING_PROVIDER: 'postiz',
      POSTIZ_BASE_URL: 'https://postiz.test',
      POSTIZ_API_KEY: 'k',
    } as NodeJS.ProcessEnv);
    const adapter = createPublishingAdapter(env);
    expect(adapter.name).toBe('postiz');
    expect(adapter.simulated).toBe(false);
  });

  it('fails every operation in the failing provider', async () => {
    const adapter = createFailingPublishingAdapter();
    expect((await adapter.schedule(payload)).ok).toBe(false);
    expect((await adapter.cancel('x')).ok).toBe(false);
  });
});
