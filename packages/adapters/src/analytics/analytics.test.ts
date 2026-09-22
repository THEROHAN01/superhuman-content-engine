import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '@sce/utils';
import {
  createAnalyticsAdapter,
  createFailingAnalyticsAdapter,
  createMockAnalyticsAdapter,
  createPostizAnalyticsAdapter,
  EMPTY_METRICS,
  PLATFORM_METRICS,
  restrictToPlatform,
} from './index.js';

const query = {
  publicationId: 'pb_1',
  externalId: 'post-1',
  platform: 'x' as const,
  window: '24h' as const,
  collectedFor: '2026-09-23',
};

describe('metric shape', () => {
  it('starts from all-unknown', () => {
    expect(Object.values(EMPTY_METRICS).every((value) => value === null)).toBe(true);
  });

  it('drops metrics a platform cannot report instead of keeping an invented value', () => {
    const restricted = restrictToPlatform('x', {
      ...EMPTY_METRICS,
      impressions: 10,
      saves: 99,
      reach: 5,
    });
    expect(restricted.impressions).toBe(10);
    expect(restricted.saves).toBeNull();
    expect(restricted.reach).toBeNull();
  });

  it('declares a metric set for every platform', () => {
    for (const [platform, metrics] of Object.entries(PLATFORM_METRICS)) {
      expect(metrics.length, platform).toBeGreaterThan(2);
    }
  });
});

describe('mock analytics adapter', () => {
  it('is deterministic for the same publication, window and day', async () => {
    const adapter = createMockAnalyticsAdapter();
    const first = await adapter.fetch(query);
    const second = await adapter.fetch(query);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.metrics).toEqual(first.value.metrics);
  });

  it('produces different numbers for different windows', async () => {
    const adapter = createMockAnalyticsAdapter();
    const day = await adapter.fetch(query);
    const month = await adapter.fetch({ ...query, window: '30d' });
    expect(day.ok && month.ok).toBe(true);
    if (!day.ok || !month.ok) return;
    expect(month.value.metrics.impressions!).toBeGreaterThan(day.value.metrics.impressions!);
  });

  it('leaves at least one metric unknown so the pipeline must handle nulls', async () => {
    const adapter = createMockAnalyticsAdapter();
    const result = await adapter.fetch(query);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.values(result.value.metrics).some((value) => value === null)).toBe(true);
  });

  it('marks itself simulated and labels its payload as synthetic', async () => {
    const adapter = createMockAnalyticsAdapter();
    expect(adapter.simulated).toBe(true);
    const result = await adapter.fetch(query);
    expect(result.ok && JSON.stringify(result.value.raw)).toContain('synthetic');
  });
});

describe('postiz analytics adapter', () => {
  const base = { baseUrl: 'https://postiz.test', apiKey: 'secret', timeoutMs: 1000 };

  it('maps known metric names and leaves the rest unknown', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://postiz.test/public/v1/posts/post-1');
      return new Response(
        JSON.stringify({
          statistics: { impressions: 1200, likes: 34, replies: 5, retweet_count: 7 },
        }),
        { status: 200 },
      );
    });

    const result = await createPostizAnalyticsAdapter({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).fetch(query);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metrics.impressions).toBe(1200);
    expect(result.value.metrics.reactions).toBe(34);
    expect(result.value.metrics.comments).toBe(5);
    expect(result.value.metrics.shares).toBe(7);
    // Not reported by this response, and not invented.
    expect(result.value.metrics.clicks).toBeNull();
  });

  it('keeps the raw payload for traceability', async () => {
    const result = await createPostizAnalyticsAdapter({
      ...base,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ statistics: { impressions: 1 } }), {
          status: 200,
        })) as unknown as typeof fetch,
    }).fetch(query);
    expect(result.ok && result.value.raw).toMatchObject({ statistics: { impressions: 1 } });
  });

  it('treats a response with no recognisable metrics as all-unknown rather than zero', async () => {
    const result = await createPostizAnalyticsAdapter({
      ...base,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ state: 'PUBLISHED' }), {
          status: 200,
        })) as unknown as typeof fetch,
    }).fetch(query);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.values(result.value.metrics).every((value) => value === null)).toBe(true);
  });

  it('classifies 429 and 5xx as transient, 4xx as permanent', async () => {
    const withStatus = (status: number) =>
      createPostizAnalyticsAdapter({
        ...base,
        fetchImpl: (async () => new Response('err', { status })) as unknown as typeof fetch,
      }).fetch(query);

    const limited = await withStatus(429);
    if (!limited.ok) expect(limited.error.kind).toBe('transient');
    const server = await withStatus(502);
    if (!server.ok) expect(server.error.kind).toBe('transient');
    const missing = await withStatus(404);
    if (!missing.ok) expect(missing.error.kind).toBe('permanent');
  });

  it('never leaks the api key in an error', async () => {
    const result = await createPostizAnalyticsAdapter({
      ...base,
      fetchImpl: (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch,
    }).fetch(query);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('secret');
  });
});

describe('provider selection', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/sce' };

  it('follows the publishing provider', () => {
    expect(createAnalyticsAdapter(parseEnv(base as NodeJS.ProcessEnv)).name).toBe('mock');

    const postiz = parseEnv({
      ...base,
      PUBLISHING_PROVIDER: 'postiz',
      POSTIZ_BASE_URL: 'https://postiz.test',
      POSTIZ_API_KEY: 'k',
    } as NodeJS.ProcessEnv);
    expect(createAnalyticsAdapter(postiz).name).toBe('postiz');
    expect(createAnalyticsAdapter(postiz).simulated).toBe(false);
  });

  it('fails on demand for drills', async () => {
    expect((await createFailingAnalyticsAdapter().fetch(query)).ok).toBe(false);
  });
});
