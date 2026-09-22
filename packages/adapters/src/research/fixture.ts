import type { ResearchAdapter, ResearchHit } from './types.js';

/**
 * Offline research provider backed by a small, hand-curated corpus of canonical references.
 *
 * Why it exists: the `mock` provider is deliberately *synthetic* (reserved example.com hosts,
 * `synthetic: true`), so evidence built from it can never clear the quality gate. That is correct
 * behaviour, but it also means the complete learning-to-analytics path cannot be demonstrated on a
 * laptop with no search engine. This provider closes that gap without pretending to search:
 *
 *   - it performs **no network calls** and claims no external API contract;
 *   - every entry is a stable, well-known documentation or standards landing page, recorded here
 *     as *curated fixture data* rather than as a fetched search result;
 *   - it is refused when `NODE_ENV=production` (see `packages/utils/src/env.ts`), so it can seed a
 *     demo or an end-to-end test but can never stand in for real research in production.
 *
 * An operator who wants these links treated as genuine evidence must confirm them first; the
 * provider name is stored on every `source_documents` row, so fixture-sourced evidence stays
 * identifiable in the database forever.
 */
interface FixtureEntry {
  /** Matched case-insensitively against the query text. */
  match: RegExp;
  hits: ResearchHit[];
}

const hit = (title: string, url: string, snippet: string): ResearchHit => ({
  title,
  url,
  snippet,
  engine: 'fixture',
});

const CORPUS: FixtureEntry[] = [
  {
    match: /token|oauth|jwt|refresh|rotation|auth/i,
    hits: [
      hit(
        'RFC 6749 - The OAuth 2.0 Authorization Framework',
        'https://www.rfc-editor.org/rfc/rfc6749',
        'Defines the OAuth 2.0 authorization framework, including refresh tokens and the ' +
          'authorization server obligations around issuing and invalidating them.',
      ),
      hit(
        'RFC 6819 - OAuth 2.0 Threat Model and Security Considerations',
        'https://www.rfc-editor.org/rfc/rfc6819',
        'Catalogues OAuth 2.0 threats, among them refresh-token replay, and describes rotation ' +
          'plus the detection of a replayed token as a mitigation.',
      ),
      hit(
        'MDN - HTTP authentication',
        'https://developer.mozilla.org/en-US/docs/Web/HTTP/Authentication',
        'Explains the HTTP authentication framework, credential transport and the headers used ' +
          'to carry bearer credentials.',
      ),
    ],
  },
  {
    match: /postgres|sql|index|transaction|lock|skip locked|mvcc/i,
    hits: [
      hit(
        'PostgreSQL - SELECT',
        'https://www.postgresql.org/docs/current/sql-select.html',
        'Reference for SELECT, including the locking clauses FOR UPDATE, NOWAIT and SKIP LOCKED ' +
          'that make a plain table usable as a work queue.',
      ),
      hit(
        'PostgreSQL - Explicit Locking',
        'https://www.postgresql.org/docs/current/explicit-locking.html',
        'Describes table- and row-level lock modes and how concurrent transactions interact when ' +
          'they contend for the same rows.',
      ),
      hit(
        'PostgreSQL - Concurrency Control',
        'https://www.postgresql.org/docs/current/mvcc.html',
        'Covers multiversion concurrency control, isolation levels and the guarantees each level ' +
          'provides to concurrent readers and writers.',
      ),
    ],
  },
  {
    match: /redis|cache|queue|lock|expiry/i,
    hits: [
      hit(
        'Redis - Documentation',
        'https://redis.io/docs/latest/',
        'Entry point for the Redis documentation: data types, expiration, persistence and the ' +
          'command reference.',
      ),
      hit(
        'Redis - Commands',
        'https://redis.io/docs/latest/commands/',
        'The full Redis command reference, including the atomic primitives used to build locks ' +
          'and deduplication keys.',
      ),
    ],
  },
  {
    match: /http|idempoten|retry|duplicate|webhook|status code/i,
    hits: [
      hit(
        'RFC 9110 - HTTP Semantics',
        'https://www.rfc-editor.org/rfc/rfc9110',
        'Defines HTTP semantics, including which methods are safe and idempotent and what a ' +
          'client may assume when it retries a request.',
      ),
      hit(
        'MDN - Idempotent',
        'https://developer.mozilla.org/en-US/docs/Glossary/Idempotent',
        'Defines idempotency for HTTP methods: an identical request repeated has the same effect ' +
          'on server state as a single request.',
      ),
    ],
  },
  {
    match: /node|javascript|typescript|event loop/i,
    hits: [
      hit(
        'Node.js - Documentation',
        'https://nodejs.org/docs/latest/api/',
        'The Node.js API reference for the current release line.',
      ),
      hit(
        'MDN - JavaScript reference',
        'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference',
        'The JavaScript language reference: syntax, built-in objects and semantics.',
      ),
    ],
  },
];

/** Always available, so a query that matches no topic still returns usable general references. */
const FALLBACK: ResearchHit[] = [
  hit(
    'MDN Web Docs',
    'https://developer.mozilla.org/en-US/docs/Web',
    'Reference documentation for web platform technologies.',
  ),
];

export const createFixtureResearchAdapter = (): ResearchAdapter => ({
  name: 'fixture',
  // Not synthetic: these are curated references, not generated placeholders. They are still
  // fixture data - see the module comment - and carry the provider name `fixture` in the database.
  synthetic: false,

  async search(query) {
    const matched = CORPUS.filter((entry) => entry.match.test(query.query)).flatMap((e) => e.hits);
    const chosen = matched.length > 0 ? matched : FALLBACK;

    // Deterministic: same query in, same ordered slice out.
    const seen = new Set<string>();
    const unique = chosen.filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true)));
    return { ok: true, value: unique.slice(0, Math.max(1, query.maxResults)) };
  },
});
