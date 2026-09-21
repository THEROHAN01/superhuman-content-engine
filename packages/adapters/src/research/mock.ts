import type { ResearchAdapter, ResearchHit } from './types.js';

/**
 * Deterministic offline research provider.
 *
 * Its results are **synthetic**: the hosts are reserved example domains, and `synthetic: true`
 * tells the enrichment service to mark the resulting evidence `needs_review` rather than
 * `supported`. Inventing plausible real URLs here would be exactly the failure mode this system
 * exists to prevent.
 */
const TOPIC_HINTS: Array<[RegExp, string]> = [
  [/token|jwt|oauth|auth|rotation/i, 'auth'],
  [/postgres|sql|index|transaction|lock/i, 'postgres'],
  [/redis|cache|queue/i, 'redis'],
  [/http|tcp|socket|keep-?alive/i, 'networking'],
  [/idempoten|retry|duplicate|exactly-once/i, 'reliability'],
];

const slug = (query: string): string =>
  query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'general';

export const createMockResearchAdapter = (
  options: { resultsPerQuery?: number } = {},
): ResearchAdapter => ({
  name: 'mock',
  synthetic: true,

  async search(query) {
    const topic = TOPIC_HINTS.find(([pattern]) => pattern.test(query.query))?.[1] ?? 'general';
    const count = Math.min(options.resultsPerQuery ?? 2, query.maxResults);

    const hits: ResearchHit[] = Array.from({ length: count }, (_, index) => ({
      // example.com / example.org are reserved by RFC 2606 and can never be a real source.
      url: `https://docs.example.com/${topic}/${slug(query.query)}${index === 0 ? '' : `-${index}`}`,
      title: `[synthetic] ${query.query} - reference ${index + 1}`,
      snippet:
        `Synthetic research result produced by the mock provider for "${query.query}". ` +
        'It carries no evidentiary weight and is marked as needing review.',
      engine: 'mock',
    }));

    return { ok: true, value: hits };
  },
});
