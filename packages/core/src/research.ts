import { contentAtoms, operations, sourceDocuments } from '@sce/db';
import type { ResearchAdapter, ResearchHit } from '@sce/adapters';
import { inferSourceType } from '@sce/adapters';
import {
  canonicalizeUrl,
  newId,
  permanent,
  tryCanonicalizeUrl,
  withRetry,
  type Result,
} from '@sce/utils';
import type { ContentAtom, EvidenceStatus, SourceDocument, SourceType } from '@sce/schemas';
import { SOURCE_TYPE_RANK } from '@sce/schemas';
import type { ServiceContext } from './context.js';

/**
 * Evidence enrichment.
 *
 * Three rules shape this module:
 *   1. A failed search is never evidence. It sets `research_failed`, not "no sources found".
 *   2. A synthetic (mock) source is never `supported` evidence - at best `needs_review`.
 *   3. URLs are never invented: every stored source comes from a provider response and is
 *      canonicalized, so a fabricated or malformed link cannot enter the corpus.
 */

/** Which learning kinds carry factual claims that need external support. */
const RESEARCH_REQUIRED_KINDS = new Set(['core_engineering', 'book_research', 'dsa']);

export const isResearchRequired = (atom: Pick<ContentAtom, 'kind' | 'entities'>): boolean =>
  RESEARCH_REQUIRED_KINDS.has(atom.kind) || atom.entities.length > 0;

/**
 * Builds search queries from what the atom already states - deterministic, so the same atom
 * always searches the same way and results are comparable across runs.
 */
export const buildQueries = (atom: ContentAtom, limit = 3): string[] => {
  const topic = atom.primary_topic.replace(/_/g, ' ');
  const entities = atom.entities.slice(0, 3);
  // A derived title can be a whole sentence (and may end in a truncation ellipsis). Search engines
  // do better with a short subject, so keep the leading keywords only.
  const subject = atom.title
    .replace(/\.{3}$/, '')
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ');

  const queries = [
    entities.length > 0
      ? `${entities.join(' ')} ${subject} documentation`
      : `${subject} documentation`,
    `${subject} ${topic} explanation`,
    entities.length > 0
      ? `${entities[0]} ${topic} official docs`
      : `${topic} specification ${subject}`,
  ];

  return [...new Set(queries.map((q) => q.trim()).filter((q) => q.length > 8))].slice(0, limit);
};

export interface ResearchOutcome {
  atom: ContentAtom;
  sources: SourceDocument[];
  added: number;
  evidence_status: EvidenceStatus;
  queries: string[];
  /** True when every stored source came from a synthetic provider. */
  synthetic_only: boolean;
}

export interface ResearchOptions {
  research: ResearchAdapter;
  maxSources?: number;
  /** Retry budget for transient search failures. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface RankedHit extends ResearchHit {
  canonical: string;
  sourceType: SourceType;
  relevance: number;
}

/** Ranks by evidence quality first, then by snippet substance. Deterministic. */
export const rankHits = (hits: ResearchHit[], maxSources: number): RankedHit[] => {
  const seen = new Set<string>();
  const ranked: RankedHit[] = [];

  for (const hit of hits) {
    const canonical = tryCanonicalizeUrl(hit.url);
    if (!canonical) continue; // a malformed URL is dropped, never "fixed"
    if (seen.has(canonical.canonical)) continue;
    seen.add(canonical.canonical);

    const sourceType = inferSourceType(canonical.canonical);
    const rank = SOURCE_TYPE_RANK[sourceType];
    const substance = Math.min(hit.snippet.length, 600) / 600;
    ranked.push({
      ...hit,
      canonical: canonical.canonical,
      sourceType,
      // 0..1 where official docs with a substantial snippet score highest.
      relevance: Number((((9 - rank) / 8) * 0.8 + substance * 0.2).toFixed(3)),
    });
  }

  return ranked
    .sort(
      (a, b) =>
        SOURCE_TYPE_RANK[a.sourceType] - SOURCE_TYPE_RANK[b.sourceType] ||
        b.relevance - a.relevance,
    )
    .slice(0, maxSources);
};

export const researchContentAtom = async (
  ctx: ServiceContext,
  atomId: string,
  options: ResearchOptions,
): Promise<Result<ResearchOutcome>> => {
  const atom = await contentAtoms.findAtom(ctx.db, atomId);
  if (!atom) {
    return { ok: false, error: permanent('E_ATOM_NOT_FOUND', `no content atom ${atomId}`) };
  }

  const correlationId = `cor_research_${atom.id}`;
  const log = ctx.logger.child({ workflow: 'atom_research_v1', content_atom_id: atom.id });
  const maxSources = options.maxSources ?? ctx.env.RESEARCH_MAX_SOURCES;

  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'atom_research_v1',
    correlationId,
    subjectId: atom.id,
    input: { provider: options.research.name, topic: atom.primary_topic },
  });

  if (!isResearchRequired(atom)) {
    const updated = await contentAtoms.updateAtom(ctx.db, atom.id, {
      evidence_status: 'not_required',
    });
    await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', { outcome: 'not_required' });
    return {
      ok: true,
      value: {
        atom: updated ?? atom,
        sources: await sourceDocuments.listSourcesForAtom(ctx.db, atom.id),
        added: 0,
        evidence_status: 'not_required',
        queries: [],
        synthetic_only: false,
      },
    };
  }

  const queries = buildQueries(atom);
  const hits: ResearchHit[] = [];
  let failed = false;
  let lastError: { code: string; message: string } | null = null;

  for (const query of queries) {
    const attempt = await withRetry(
      () => options.research.search({ query, maxResults: maxSources, correlationId }),
      {
        attempts: options.attempts ?? 2,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        onRetry: ({ attempt: n, failure }) =>
          log.warn({ attempt: n, code: failure.code, query }, 'research retry'),
      },
    );

    if (attempt.ok) {
      hits.push(...attempt.value);
      continue;
    }

    failed = true;
    lastError = { code: attempt.error.code, message: attempt.error.message };
    await operations.recordError(ctx.db, {
      workflow: 'atom_research_v1',
      step: 'search',
      kind: attempt.error.kind,
      code: attempt.error.code,
      message: attempt.error.message,
      correlationId,
      subjectId: atom.id,
      details: { query },
    });
  }

  // A failed search must never be recorded as "researched and found nothing".
  if (failed && hits.length === 0) {
    const updated = await contentAtoms.updateAtom(ctx.db, atom.id, {
      evidence_status: 'research_failed',
      error: lastError
        ? `${lastError.code}: ${lastError.message}`.slice(0, 2000)
        : 'research failed',
    });
    await operations.finishWorkflowRun(ctx.db, runId, 'failed', { outcome: 'research_failed' });
    log.warn({ queries }, 'research failed; evidence status is research_failed');
    return {
      ok: true,
      value: {
        atom: updated ?? atom,
        sources: await sourceDocuments.listSourcesForAtom(ctx.db, atom.id),
        added: 0,
        evidence_status: 'research_failed',
        queries,
        synthetic_only: false,
      },
    };
  }

  const ranked = rankHits(hits, maxSources);
  let added = 0;
  for (const hit of ranked) {
    const { source, inserted } = await sourceDocuments.insertSourceDocument(ctx.db, {
      id: newId('sourceDocument'),
      learning_event_id: atom.learning_event_id,
      content_atom_id: atom.id,
      title: hit.title.slice(0, 500),
      url: canonicalizeUrl(hit.url).canonical,
      canonical_url: hit.canonical,
      source_type: hit.sourceType,
      excerpt: hit.snippet ? hit.snippet.slice(0, 4000) : null,
      summary: null,
      provider: options.research.name,
      relevance: hit.relevance,
    });
    if (inserted) added++;
    void source;
  }

  const stored = await sourceDocuments.listSourcesForAtom(ctx.db, atom.id);
  const syntheticOnly = stored.length > 0 && stored.every((s) => s.provider === 'mock');

  // Evidence status is deliberately conservative: only real, high-quality sources count as
  // supporting; synthetic or thin evidence stays reviewable.
  const strongSources = stored.filter(
    (s) =>
      s.provider !== 'mock' && SOURCE_TYPE_RANK[s.source_type] <= SOURCE_TYPE_RANK.engineering_blog,
  );
  const evidenceStatus: EvidenceStatus =
    stored.length === 0
      ? 'unsupported'
      : syntheticOnly
        ? 'needs_review'
        : strongSources.length >= 2
          ? 'supported'
          : strongSources.length === 1
            ? 'partially_supported'
            : 'needs_review';

  const updated = await contentAtoms.updateAtom(ctx.db, atom.id, {
    evidence_status: evidenceStatus,
    status: atom.status === 'draft' ? 'enriched' : atom.status,
  });

  log.info(
    {
      added,
      total: stored.length,
      evidence_status: evidenceStatus,
      provider: options.research.name,
    },
    'atom research complete',
  );
  await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
    added,
    total: stored.length,
    evidence_status: evidenceStatus,
  });

  return {
    ok: true,
    value: {
      atom: updated ?? atom,
      sources: stored,
      added,
      evidence_status: evidenceStatus,
      queries,
      synthetic_only: syntheticOnly,
    },
  };
};
