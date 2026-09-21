import { permanent, transient, type Result } from '@sce/utils';
import type { ResearchAdapter, ResearchHit, ResearchQuery } from './types.js';

/**
 * SearxNG provider, using the instance's JSON API:
 *   GET {base}/search?q=...&format=json  ->  { results: [{ title, url, content, engine }] }
 *
 * Self-hosted instances must enable the `json` format explicitly; a 403 usually means it is not
 * enabled. See docs/external-apis.md - this contract is marked assumed until confirmed against a
 * live instance.
 */
export interface SearxngOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface SearxngResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    engine?: string;
    publishedDate?: string;
  }>;
}

export const createSearxngAdapter = (options: SearxngOptions): ResearchAdapter => ({
  name: 'searxng',
  synthetic: false,

  async search(query: ResearchQuery): Promise<Result<ResearchHit[]>> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const url = new URL('/search', options.baseUrl);
    url.searchParams.set('q', query.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '0');

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        error: transient(
          'E_RESEARCH_UNREACHABLE',
          'search request failed',
          {
            provider: 'searxng',
            timeoutMs: options.timeoutMs,
          },
          error,
        ),
      };
    }

    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const details: Record<string, unknown> = { status: response.status, provider: 'searxng' };
      if (Number.isFinite(retryAfter) && retryAfter > 0)
        details['retryAfterMs'] = retryAfter * 1000;

      return {
        ok: false,
        error:
          response.status >= 500 || response.status === 429
            ? transient('E_RESEARCH_HTTP', `search returned ${response.status}`, details)
            : permanent('E_RESEARCH_HTTP', `search returned ${response.status}`, details),
      };
    }

    let payload: SearxngResponse;
    try {
      payload = (await response.json()) as SearxngResponse;
    } catch (error) {
      return {
        ok: false,
        error: permanent(
          'E_RESEARCH_BAD_RESPONSE',
          'search returned a non-JSON body',
          {
            provider: 'searxng',
          },
          error,
        ),
      };
    }

    const hits: ResearchHit[] = (payload.results ?? [])
      .filter(
        (
          r,
        ): r is {
          title: string;
          url: string;
          content?: string;
          engine?: string;
          publishedDate?: string;
        } => typeof r.url === 'string' && typeof r.title === 'string',
      )
      .slice(0, query.maxResults)
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: (r.content ?? '').slice(0, 2000),
        ...(r.engine ? { engine: r.engine } : {}),
        ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
      }));

    return { ok: true, value: hits };
  },
});
