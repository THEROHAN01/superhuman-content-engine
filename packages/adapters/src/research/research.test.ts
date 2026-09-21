import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '@sce/utils';
import {
  createDisabledResearchAdapter,
  createFailingResearchAdapter,
  createMockResearchAdapter,
  createResearchAdapter,
  createSearxngAdapter,
  inferSourceType,
} from './index.js';

describe('inferSourceType', () => {
  it.each([
    ['https://www.postgresql.org/docs/16/sql-createindex.html', 'official_docs'],
    ['https://docs.redis.io/latest/commands/setnx/', 'official_docs'],
    ['https://www.rfc-editor.org/rfc/rfc6749', 'rfc'],
    ['https://arxiv.org/abs/2301.00001', 'paper'],
    [
      'https://github.com/postgres/postgres/blob/master/src/backend/executor/nodeLockRows.c',
      'source_code',
    ],
    ['https://netflixtechblog.com/some-post-123', 'engineering_blog'],
    ['https://medium.com/@someone/a-post', 'engineering_blog'],
    ['https://www.youtube.com/watch?v=abc', 'video'],
    ['https://random-site.example/post', 'other'],
  ])('%s -> %s', (url, expected) => {
    expect(inferSourceType(url)).toBe(expected);
  });

  it('never guesses for an unparseable url', () => {
    expect(inferSourceType('not a url')).toBe('other');
  });
});

describe('mock research adapter', () => {
  it('is deterministic and marks itself synthetic', async () => {
    const adapter = createMockResearchAdapter();
    expect(adapter.synthetic).toBe(true);

    const first = await adapter.search({ query: 'refresh token rotation', maxResults: 3 });
    const second = await adapter.search({ query: 'refresh token rotation', maxResults: 3 });
    expect(first).toEqual(second);
  });

  it('only returns reserved example domains, never a plausible real source', async () => {
    const result = await createMockResearchAdapter().search({
      query: 'postgres index',
      maxResults: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const hit of result.value) {
      expect(new URL(hit.url).hostname.endsWith('example.com')).toBe(true);
      expect(hit.title).toContain('[synthetic]');
    }
  });

  it('respects maxResults', async () => {
    const result = await createMockResearchAdapter({ resultsPerQuery: 5 }).search({
      query: 'redis',
      maxResults: 1,
    });
    expect(result.ok && result.value).toHaveLength(1);
  });
});

describe('disabled and failing providers are different things', () => {
  it('disabled succeeds with no results', async () => {
    const result = await createDisabledResearchAdapter().search({ query: 'x', maxResults: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('failing returns a transient failure', async () => {
    const result = await createFailingResearchAdapter().search({ query: 'x', maxResults: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('transient');
  });
});

describe('searxng adapter', () => {
  const base = { baseUrl: 'https://search.test', timeoutMs: 1000 };

  it('requests the JSON API and maps results', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/search');
      expect(parsed.searchParams.get('format')).toBe('json');
      expect(parsed.searchParams.get('q')).toBe('refresh token rotation');
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'OAuth 2.0',
              url: 'https://www.rfc-editor.org/rfc/rfc6749',
              content: 'spec text',
              engine: 'duckduckgo',
            },
            { title: 'no url' },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await createSearxngAdapter({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).search({
      query: 'refresh token rotation',
      maxResults: 5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1); // the malformed row is dropped, not patched
    expect(result.value[0]).toMatchObject({ title: 'OAuth 2.0', engine: 'duckduckgo' });
  });

  it('treats 5xx and 429 as transient, and surfaces Retry-After', async () => {
    const make = (status: number, headers: Record<string, string> = {}) =>
      createSearxngAdapter({
        ...base,
        fetchImpl: (async () => new Response('', { status, headers })) as unknown as typeof fetch,
      }).search({ query: 'q', maxResults: 1 });

    const server = await make(503);
    expect(server.ok).toBe(false);
    if (!server.ok) expect(server.error.kind).toBe('transient');

    const limited = await make(429, { 'retry-after': '7' });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.details?.['retryAfterMs']).toBe(7000);
  });

  it('treats 403 (JSON API disabled) as permanent', async () => {
    const result = await createSearxngAdapter({
      ...base,
      fetchImpl: (async () =>
        new Response('forbidden', { status: 403 })) as unknown as typeof fetch,
    }).search({ query: 'q', maxResults: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('permanent');
  });

  it('treats a timeout as transient', async () => {
    const result = await createSearxngAdapter({
      ...base,
      fetchImpl: (async () => {
        throw new DOMException('aborted', 'TimeoutError');
      }) as unknown as typeof fetch,
    }).search({ query: 'q', maxResults: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_RESEARCH_UNREACHABLE');
  });
});

describe('provider selection', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/sce' };

  it('defaults to mock', () => {
    expect(createResearchAdapter(parseEnv(base as NodeJS.ProcessEnv)).name).toBe('mock');
  });

  it('honours the configured provider', () => {
    const env = parseEnv({
      ...base,
      RESEARCH_PROVIDER: 'searxng',
      SEARXNG_BASE_URL: 'https://search.test',
    } as NodeJS.ProcessEnv);
    expect(createResearchAdapter(env).name).toBe('searxng');
    expect(createResearchAdapter(env).synthetic).toBe(false);
  });
});
