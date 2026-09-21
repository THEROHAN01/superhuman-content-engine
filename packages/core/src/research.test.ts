import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentAtoms,
  createTestDb,
  hasTestDatabase,
  learningEvents,
  operations,
  sourceDocuments,
  type TestDb,
} from '@sce/db';
import {
  createFailingResearchAdapter,
  createMockResearchAdapter,
  createDisabledResearchAdapter,
  type ResearchAdapter,
  type ResearchHit,
} from '@sce/adapters';
import {
  contentHash,
  createLogger,
  fixedClock,
  newCorrelationId,
  newId,
  parseEnv,
} from '@sce/utils';
import type { ServiceContext } from './context.js';
import { buildQueries, isResearchRequired, rankHits, researchContentAtom } from './research.js';
import type { ContentAtom } from '@sce/schemas';

const describeDb = hasTestDatabase() ? describe : describe.skip;

/** A provider that returns scripted hits, to test ranking and storage without a network. */
const scripted = (hits: ResearchHit[], options: { synthetic?: boolean } = {}): ResearchAdapter => ({
  name: options.synthetic ? 'mock' : 'scripted',
  synthetic: options.synthetic ?? false,
  async search() {
    return { ok: true, value: hits };
  },
});

const REAL_HITS: ResearchHit[] = [
  {
    title: 'The OAuth 2.0 Authorization Framework',
    url: 'https://www.rfc-editor.org/rfc/rfc6749#section-1.5',
    snippet: 'Refresh tokens are credentials used to obtain access tokens. '.repeat(8),
  },
  {
    title: 'Refresh tokens - official docs',
    url: 'https://docs.example-provider.dev/docs/refresh-tokens?utm_source=newsletter',
    snippet: 'Rotation invalidates the previous refresh token. '.repeat(10),
  },
  {
    title: 'Same doc, different link',
    url: 'http://www.docs.example-provider.dev/docs/refresh-tokens/',
    snippet: 'duplicate of the previous result',
  },
  {
    title: 'A random blog',
    url: 'https://someone.medium.com/tokens-explained-abc',
    snippet: 'short',
  },
  { title: 'Broken link', url: 'not-a-url', snippet: 'should be dropped' },
];

describe('research planning', () => {
  const atom = {
    id: 'ca_1',
    kind: 'core_engineering',
    title: 'Refresh token rotation detects theft',
    primary_topic: 'security',
    entities: ['JWT', 'OAuth'],
  } as unknown as ContentAtom;

  it('keeps queries short enough for a search engine', () => {
    const wordy = {
      ...atom,
      title:
        'Refresh-token rotation matters because a stolen long-lived token is indistinguishable from a legitimate one and...',
    } as ContentAtom;
    for (const query of buildQueries(wordy)) {
      expect(query.split(' ').length).toBeLessThanOrEqual(14);
      expect(query).not.toContain('...');
    }
  });

  it('builds deterministic, distinct queries', () => {
    const first = buildQueries(atom);
    expect(buildQueries(atom)).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first.length).toBeGreaterThan(1);
    expect(first.join(' ')).toContain('JWT');
  });

  it('requires research for technical learnings and for anything naming a technology', () => {
    expect(isResearchRequired(atom)).toBe(true);
    expect(
      isResearchRequired({ kind: 'project_work', entities: [] } as unknown as ContentAtom),
    ).toBe(false);
    expect(
      isResearchRequired({ kind: 'project_work', entities: ['Redis'] } as unknown as ContentAtom),
    ).toBe(true);
  });
});

describe('rankHits', () => {
  it('drops malformed urls, deduplicates by canonical url and prefers stronger sources', () => {
    const ranked = rankHits(REAL_HITS, 5);
    const urls = ranked.map((h) => h.canonical);

    expect(urls).not.toContain('not-a-url');
    expect(urls.filter((u) => u.includes('example-provider.dev'))).toHaveLength(1);
    // Ordering follows SOURCE_TYPE_RANK: official docs outrank an RFC, which outranks a blog.
    expect(ranked.map((h) => h.sourceType)).toEqual(['official_docs', 'rfc', 'engineering_blog']);
  });

  it('caps the number of sources', () => {
    expect(rankHits(REAL_HITS, 2)).toHaveLength(2);
  });

  it('scores official documentation above a thin blog post', () => {
    const ranked = rankHits(REAL_HITS, 5);
    expect(ranked[0]!.relevance).toBeGreaterThan(ranked[ranked.length - 1]!.relevance);
  });
});

describeDb('research enrichment', () => {
  let db: TestDb;
  let ctx: ServiceContext;

  const makeAtom = async (overrides: Partial<{ kind: string; entities: string[] }> = {}) => {
    const text = `probe note ${newId('learningEvent')} about refresh token rotation and why it matters`;
    const { event } = await learningEvents.insertLearningEvent(db.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: text,
      title: null,
      content_hash: contentHash(text),
      tags: [],
      context: {},
      captured_at: new Date().toISOString(),
      correlation_id: newCorrelationId(),
    });
    const { atom } = await contentAtoms.upsertContentAtom(db.db, {
      id: newId('contentAtom'),
      learning_event_id: event.id,
      status: 'draft',
      title: 'Refresh token rotation detects theft',
      kind: (overrides.kind ?? 'core_engineering') as ContentAtom['kind'],
      primary_topic: 'security',
      secondary_topics: [],
      entities: overrides.entities ?? ['JWT'],
      body: {
        problem: '',
        core_insight: '',
        first_principles: '',
        example: null,
        implementation_details: null,
        failure_mode: null,
        mental_model: null,
        personal_observation: null,
        claims: [],
        angle_candidates: [],
      },
      evidence_status: 'pending',
      confidence: 0.7,
      generator_version: 'classify.v1',
    });
    return atom;
  };

  beforeAll(async () => {
    db = await createTestDb('research');
    ctx = {
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock('2026-09-21T12:00:00.000Z'),
    };
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  it('stores ranked, deduplicated sources and marks the atom supported', async () => {
    const atom = await makeAtom();
    const result = await researchContentAtom(ctx, atom.id, { research: scripted(REAL_HITS) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence_status).toBe('supported');
    expect(result.value.atom.status).toBe('enriched');

    const stored = await sourceDocuments.listSourcesForAtom(db.db, atom.id);
    expect(stored.length).toBeGreaterThanOrEqual(2);
    expect(stored.every((s) => s.canonical_url.startsWith('https://'))).toBe(true);
    expect(stored.some((s) => s.canonical_url.includes('utm_source'))).toBe(false);
    expect(stored.some((s) => s.source_type === 'rfc')).toBe(true);
  });

  it('never stores a fabricated or malformed url', async () => {
    const atom = await makeAtom();
    await researchContentAtom(ctx, atom.id, {
      research: scripted([
        { title: 'bad', url: 'javascript:alert(1)', snippet: 's' },
        { title: 'worse', url: 'https://user:pw@example.com/doc', snippet: 's' },
        {
          title: 'ok',
          url: 'https://www.rfc-editor.org/rfc/rfc9110',
          snippet: 'HTTP semantics '.repeat(20),
        },
      ]),
    });

    const stored = await sourceDocuments.listSourcesForAtom(db.db, atom.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.canonical_url).toBe('https://rfc-editor.org/rfc/rfc9110');
  });

  it('is idempotent: repeated research adds nothing and keeps one row per source', async () => {
    const atom = await makeAtom();
    const first = await researchContentAtom(ctx, atom.id, { research: scripted(REAL_HITS) });
    const second = await researchContentAtom(ctx, atom.id, { research: scripted(REAL_HITS) });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.added).toBeGreaterThan(0);
    expect(second.value.added).toBe(0);
    expect(second.value.sources).toHaveLength(first.value.sources.length);
  });

  it('marks synthetic (mock) evidence as needing review, never as supported', async () => {
    const atom = await makeAtom();
    const result = await researchContentAtom(ctx, atom.id, {
      research: createMockResearchAdapter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.synthetic_only).toBe(true);
    expect(result.value.evidence_status).toBe('needs_review');
    expect(result.value.sources.every((s) => s.provider === 'mock')).toBe(true);
  });

  it('records research_failed when the provider is down - not "no sources found"', async () => {
    const atom = await makeAtom();
    const result = await researchContentAtom(ctx, atom.id, {
      research: createFailingResearchAdapter(),
      attempts: 2,
      sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence_status).toBe('research_failed');
    expect(result.value.sources).toHaveLength(0);

    const stored = await contentAtoms.findAtom(db.db, atom.id);
    expect(stored?.evidence_status).toBe('research_failed');
    expect(stored?.error).toContain('E_RESEARCH_UNREACHABLE');

    const errors = await operations.listErrorEvents(db.db, {});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ workflow: 'atom_research_v1', step: 'search' });

    const runs = await operations.listWorkflowRuns(db.db, { workflow: 'atom_research_v1' });
    expect(runs[0]?.status).toBe('failed');
  });

  it('distinguishes "search disabled" from "search failed"', async () => {
    const atom = await makeAtom();
    const result = await researchContentAtom(ctx, atom.id, {
      research: createDisabledResearchAdapter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence_status).toBe('unsupported');

    const runs = await operations.listWorkflowRuns(db.db, { workflow: 'atom_research_v1' });
    expect(runs[0]?.status).toBe('succeeded');
  });

  it('skips research when the learning carries no factual claims to support', async () => {
    const atom = await makeAtom({ kind: 'project_work', entities: [] });
    const result = await researchContentAtom(ctx, atom.id, { research: scripted(REAL_HITS) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence_status).toBe('not_required');
    expect(result.value.sources).toHaveLength(0);
  });

  it('marks a single strong source as partially supported', async () => {
    const atom = await makeAtom();
    const result = await researchContentAtom(ctx, atom.id, {
      research: scripted([REAL_HITS[0]!]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence_status).toBe('partially_supported');
  });

  it('retries a transient search failure before giving up', async () => {
    const atom = await makeAtom();
    let calls = 0;
    const flaky: ResearchAdapter = {
      name: 'flaky',
      synthetic: false,
      async search() {
        calls++;
        return calls === 1
          ? { ok: false, error: { kind: 'transient', code: 'E_RESEARCH_HTTP', message: '503' } }
          : { ok: true, value: [REAL_HITS[0]!] };
      },
    };

    const result = await researchContentAtom(ctx, atom.id, {
      research: flaky,
      attempts: 3,
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBeGreaterThan(1);
    expect(result.value.sources.length).toBeGreaterThan(0);
  });

  it('fails clearly for an unknown atom', async () => {
    const result = await researchContentAtom(ctx, 'ca_missing', { research: scripted([]) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_ATOM_NOT_FOUND');
  });
});
