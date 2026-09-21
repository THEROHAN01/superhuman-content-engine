import { contentAtoms, contentIdeas, operations } from '@sce/db';
import { completeJson, type LlmAdapter } from '@sce/adapters';
import { ideationV1 } from '@sce/prompts';
import { canonicalizeText, contentHash, newId, permanent, type Result } from '@sce/utils';
import type { ContentIdea, ContentIdeaDraft } from '@sce/schemas';
import type { ServiceContext } from './context.js';
import { similarity } from './dedupe.js';

/**
 * Ideation.
 *
 * Two forces are in tension: an atom should yield several genuinely different angles, and
 * reprocessing an atom must not grow the idea list without bound. Both are handled by the same
 * mechanism - a deterministic dedupe hash over the canonicalized title+hook, backed by a unique
 * constraint, plus near-duplicate filtering against ideas the atom already has.
 */

/** Ideas closer than this to an existing idea add nothing and are rejected with a reason. */
export const IDEA_SIMILARITY_THRESHOLD = 0.45;

/** Cap on stored ideas per atom, so repeated runs cannot accumulate indefinitely. */
export const MAX_IDEAS_PER_ATOM = 8;

export const ideaDedupeHash = (draft: Pick<ContentIdeaDraft, 'title' | 'hook' | 'angle'>): string =>
  contentHash(`${draft.angle}|${draft.title}|${draft.hook}`);

export interface IdeationOptions {
  llm: LlmAdapter;
  /** Generate again even when the atom already has ideas. */
  force?: boolean;
  maxIdeas?: number;
}

export interface RejectedIdea {
  title: string;
  reason: string;
  similar_to?: string;
  score?: number;
}

export interface IdeationResult {
  ideas: ContentIdea[];
  created: ContentIdea[];
  rejected: RejectedIdea[];
  unchanged: boolean;
}

export const generateIdeas = async (
  ctx: ServiceContext,
  atomId: string,
  options: IdeationOptions,
): Promise<Result<IdeationResult>> => {
  const atom = await contentAtoms.findAtom(ctx.db, atomId);
  if (!atom)
    return { ok: false, error: permanent('E_ATOM_NOT_FOUND', `no content atom ${atomId}`) };

  if (atom.status !== 'ready') {
    return {
      ok: false,
      error: permanent(
        'E_ATOM_NOT_READY',
        `atom ${atom.id} is ${atom.status}; build it before generating ideas`,
        { status: atom.status },
      ),
    };
  }

  const existing = await contentIdeas.listIdeasForAtom(ctx.db, atom.id);
  if (existing.length > 0 && options.force !== true) {
    return { ok: true, value: { ideas: existing, created: [], rejected: [], unchanged: true } };
  }

  const correlationId = `cor_ideation_${atom.id}`;
  const log = ctx.logger.child({ workflow: 'content_ideate_v1', content_atom_id: atom.id });
  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'content_ideate_v1',
    correlationId,
    subjectId: atom.id,
    input: { existing: existing.length, force: options.force === true },
  });

  const prompt = ideationV1.build({
    title: atom.title,
    topic: atom.primary_topic,
    kind: atom.kind,
    entities: atom.entities,
    body: {
      problem: atom.body.problem,
      core_insight: atom.body.core_insight,
      first_principles: atom.body.first_principles,
      example: atom.body.example,
      failure_mode: atom.body.failure_mode,
      mental_model: atom.body.mental_model,
      personal_observation: atom.body.personal_observation,
    },
    evidenceStatus: atom.evidence_status,
    existingTitles: existing.map((idea) => idea.title),
  });

  const completion = await completeJson(
    options.llm,
    {
      purpose: ideationV1.version,
      system: prompt.system,
      user: prompt.user,
      correlationId,
      temperature: 0.4,
    },
    ideationV1.outputSchema,
  );

  if (!completion.ok) {
    await operations.recordError(ctx.db, {
      workflow: 'content_ideate_v1',
      step: 'generate',
      kind: completion.error.kind,
      code: completion.error.code,
      message: completion.error.message,
      correlationId,
      subjectId: atom.id,
    });
    await operations.finishWorkflowRun(ctx.db, runId, 'failed', { code: completion.error.code });
    log.warn({ code: completion.error.code }, 'ideation failed');
    return { ok: false, error: completion.error };
  }

  const maxIdeas = options.maxIdeas ?? MAX_IDEAS_PER_ATOM;
  const created: ContentIdea[] = [];
  const rejected: RejectedIdea[] = [];
  // Compare against stored ideas and ones accepted within this run, so a model that repeats
  // itself inside one response is caught too.
  const accepted: Array<{ id: string; canonical: string }> = existing.map((idea) => ({
    id: idea.id,
    canonical: canonicalizeText(`${idea.title} ${idea.hook}`),
  }));

  for (const draft of completion.value.value.ideas) {
    if (existing.length + created.length >= maxIdeas) {
      rejected.push({
        title: draft.title,
        reason: `atom already has the maximum of ${maxIdeas} ideas`,
      });
      continue;
    }

    // An angle the atom cannot support is a fabrication risk, not an idea.
    if (draft.angle === 'failure_mode' && !atom.body.failure_mode) {
      rejected.push({ title: draft.title, reason: 'atom has no failure mode to write about' });
      continue;
    }
    if (draft.angle === 'project_story' && !atom.body.personal_observation) {
      rejected.push({
        title: draft.title,
        reason: 'atom has no personal observation to tell a story from',
      });
      continue;
    }

    const canonical = canonicalizeText(`${draft.title} ${draft.hook}`);
    const nearest = accepted
      .map((candidate) => ({ id: candidate.id, score: similarity(canonical, candidate.canonical) }))
      .sort((a, b) => b.score - a.score)[0];

    if (nearest && nearest.score >= IDEA_SIMILARITY_THRESHOLD) {
      rejected.push({
        title: draft.title,
        reason: 'adds no new information compared with an existing idea',
        similar_to: nearest.id,
        score: Number(nearest.score.toFixed(3)),
      });
      continue;
    }

    const { idea, inserted } = await contentIdeas.insertContentIdea(ctx.db, {
      id: newId('contentIdea'),
      content_atom_id: atom.id,
      learning_event_id: atom.learning_event_id,
      status: 'proposed',
      angle: draft.angle,
      title: draft.title,
      rationale: draft.rationale,
      audience: draft.audience,
      platforms: draft.platforms,
      formats: draft.formats,
      hook: draft.hook,
      evidence_required: draft.evidence_required,
      dedupe_hash: ideaDedupeHash(draft),
      rejection_reason: null,
      // Ideas with evidence behind them and a supporting atom section rank higher.
      score: scoreIdea(draft, atom.evidence_status),
      prompt_version: ideationV1.version,
    });

    if (inserted) {
      created.push(idea);
      accepted.push({ id: idea.id, canonical });
    } else {
      rejected.push({
        title: draft.title,
        reason: 'identical idea already exists',
        similar_to: idea.id,
      });
    }
  }

  const all = await contentIdeas.listIdeasForAtom(ctx.db, atom.id);
  log.info(
    { created: created.length, rejected: rejected.length, total: all.length },
    'ideation complete',
  );
  await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
    created: created.length,
    rejected: rejected.length,
    total: all.length,
  });

  return { ok: true, value: { ideas: all, created, rejected, unchanged: false } };
};

/** Deterministic priority score; higher means route to the content queue first. */
export const scoreIdea = (draft: ContentIdeaDraft, evidenceStatus: string): number => {
  let score = 0.5;
  if (!draft.evidence_required) score += 0.1;
  if (
    draft.evidence_required &&
    (evidenceStatus === 'supported' || evidenceStatus === 'not_required')
  ) {
    score += 0.2;
  }
  if (
    draft.evidence_required &&
    (evidenceStatus === 'unsupported' || evidenceStatus === 'research_failed')
  ) {
    score -= 0.25;
  }
  if (draft.angle === 'failure_mode' || draft.angle === 'project_story') score += 0.1;
  if (draft.hook.length >= 40) score += 0.05;
  return Number(Math.max(0, Math.min(1, score)).toFixed(3));
};

/** Promotes the strongest proposed ideas into the content queue. */
export const queueBestIdeas = async (
  ctx: ServiceContext,
  atomId: string,
  limit = 2,
): Promise<ContentIdea[]> => {
  const ideas = await contentIdeas.listIdeasForAtom(ctx.db, atomId);
  const queued: ContentIdea[] = [];
  for (const idea of ideas.filter((i) => i.status === 'proposed').slice(0, limit)) {
    const updated = await contentIdeas.setIdeaStatus(ctx.db, idea.id, 'queued');
    if (updated) queued.push(updated);
  }
  return queued;
};
