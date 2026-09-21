import { contentAtoms, learningEvents, operations } from '@sce/db';
import { completeJson, type LlmAdapter } from '@sce/adapters';
import { classifyV1 } from '@sce/prompts';
import { canonicalizeText, newId, permanent, transient, type Result } from '@sce/utils';
import type { ContentAtom, LearningEvent, LearningEventClassification } from '@sce/schemas';
import type { ServiceContext } from './context.js';
import { normalizeNote } from './normalize.js';
import { findDuplicate, NEAR_DUPLICATE_THRESHOLD } from './dedupe.js';

/**
 * Turns a captured note into a structured, classified, deduplicated learning record, and creates
 * the Content Atom shell when it qualifies.
 *
 * Idempotency: every step is derived from stored state, status transitions are monotonic, and the
 * atom has a one-per-event unique constraint - so running this repeatedly converges instead of
 * duplicating. Failure never masquerades as success: a classification failure marks the event
 * `failed` with an `error_events` row rather than inventing a classification.
 */
export interface ProcessOptions {
  llm: LlmAdapter;
  /** Re-run classification even when the event already has one. */
  force?: boolean;
  nearDuplicateThreshold?: number;
}

export interface ProcessResult {
  event: LearningEvent;
  classification: LearningEventClassification | null;
  duplicate_of: string | null;
  duplicate_score: number;
  atom: ContentAtom | null;
  atom_created: boolean;
  /** True when nothing changed because the event was already processed. */
  unchanged: boolean;
}

export const processLearningEvent = async (
  ctx: ServiceContext,
  learningEventId: string,
  options: ProcessOptions,
): Promise<Result<ProcessResult>> => {
  const event = await learningEvents.findLearningEvent(ctx.db, learningEventId);
  if (!event) {
    return {
      ok: false,
      error: permanent('E_EVENT_NOT_FOUND', `no learning event ${learningEventId}`),
    };
  }

  const correlationId = event.correlation_id;
  const log = ctx.logger.child({
    correlation_id: correlationId,
    workflow: 'learning_process_v1',
    learning_event_id: event.id,
  });

  // Already processed and not forced: return the stored result rather than re-spending a model call.
  if (!options.force && (event.status === 'atomized' || event.status === 'duplicate')) {
    const existingAtom = await contentAtoms.findAtomByLearningEvent(ctx.db, event.id);
    return {
      ok: true,
      value: {
        event,
        classification: event.classification,
        duplicate_of: event.duplicate_of,
        duplicate_score: event.duplicate_of ? 1 : 0,
        atom: existingAtom,
        atom_created: false,
        unchanged: true,
      },
    };
  }

  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'learning_process_v1',
    correlationId,
    subjectId: event.id,
    input: { status: event.status, force: options.force === true },
  });

  const failRun = async (
    step: string,
    code: string,
    message: string,
    kind: 'transient' | 'permanent',
    details?: Record<string, unknown>,
  ) => {
    await operations.recordError(ctx.db, {
      workflow: 'learning_process_v1',
      step,
      kind,
      code,
      message,
      correlationId,
      subjectId: event.id,
      details: details ?? null,
    });
    await operations.finishWorkflowRun(ctx.db, runId, 'failed', { step, code });
  };

  // ---------------------------------------------------------------- normalize
  const normalized = normalizeNote(event.raw_text, event.title);
  await learningEvents.advanceStatus(ctx.db, event.id, 'normalized', {
    normalized_text: normalized.text,
    title: normalized.title,
  });

  // ---------------------------------------------------------------- deduplicate
  const candidates = await contentAtoms.recentNormalizedEvents(ctx.db, { excludeId: event.id });
  const verdict = findDuplicate(
    normalized.canonical,
    candidates.map((c) => ({ id: c.id, canonical: canonicalizeText(c.canonical) })),
    options.nearDuplicateThreshold ?? NEAR_DUPLICATE_THRESHOLD,
  );

  if (verdict.duplicate && verdict.of) {
    const advanced = await learningEvents.advanceStatus(ctx.db, event.id, 'duplicate', {
      duplicate_of: verdict.of,
    });
    log.info(
      { duplicate_of: verdict.of, score: verdict.score, reason: verdict.reason },
      'learning event is a duplicate; keeping the reference and stopping here',
    );
    await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
      outcome: 'duplicate',
      duplicate_of: verdict.of,
      score: verdict.score,
    });
    return {
      ok: true,
      value: {
        event: advanced?.event ?? event,
        classification: event.classification,
        duplicate_of: verdict.of,
        duplicate_score: verdict.score,
        atom: null,
        atom_created: false,
        unchanged: false,
      },
    };
  }

  // ---------------------------------------------------------------- classify
  const prompt = classifyV1.build({ text: normalized.text, title: normalized.title });
  const classification = await completeJson(
    options.llm,
    {
      purpose: classifyV1.version,
      system: prompt.system,
      user: prompt.user,
      correlationId,
      temperature: 0,
    },
    classifyV1.outputSchema,
  );

  if (!classification.ok) {
    // A failed classification is recorded as a failure - never as an empty or guessed one.
    await learningEvents.advanceStatus(ctx.db, event.id, 'failed');
    await failRun(
      'classify',
      classification.error.code,
      classification.error.message,
      classification.error.kind,
      classification.error.details,
    );
    log.warn({ code: classification.error.code }, 'classification failed; event marked failed');
    return { ok: false, error: classification.error };
  }

  const classified = await learningEvents.advanceStatus(ctx.db, event.id, 'classified', {
    classification: classification.value.value,
  });

  // ---------------------------------------------------------------- atom shell
  const values = classification.value.value;
  const atomResult = await contentAtoms.upsertContentAtom(ctx.db, {
    id: newId('contentAtom'),
    learning_event_id: event.id,
    status: 'draft',
    title: normalized.title,
    kind: values.kind,
    primary_topic: values.primary_topic,
    secondary_topics: values.secondary_topics,
    entities: values.entities,
    body: {
      // The shell records what the note already states; enrichment and transformation fill the rest.
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
    confidence: values.confidence,
    generator_version: classifyV1.version,
  });

  const atomized = await learningEvents.advanceStatus(ctx.db, event.id, 'atomized');

  log.info(
    {
      content_atom_id: atomResult.atom.id,
      atom_created: atomResult.inserted,
      primary_topic: values.primary_topic,
      content_worthy: values.content_worthy,
    },
    'learning event processed',
  );

  await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
    outcome: 'atomized',
    content_atom_id: atomResult.atom.id,
    atom_created: atomResult.inserted,
  });

  return {
    ok: true,
    value: {
      event: atomized?.event ?? classified?.event ?? event,
      classification: values,
      duplicate_of: null,
      duplicate_score: verdict.score,
      atom: atomResult.atom,
      atom_created: atomResult.inserted,
      unchanged: false,
    },
  };
};

/** Used by the worker/n8n path: process every event still waiting for classification. */
export const processPendingLearningEvents = async (
  ctx: ServiceContext,
  options: ProcessOptions & { limit?: number },
): Promise<Array<Result<ProcessResult>>> => {
  const pending = await learningEvents.listLearningEvents(ctx.db, {
    status: 'received',
    limit: options.limit ?? 20,
  });
  const results: Array<Result<ProcessResult>> = [];
  for (const event of pending) {
    try {
      results.push(await processLearningEvent(ctx, event.id, options));
    } catch (error) {
      results.push({
        ok: false,
        error: transient(
          'E_PROCESS_FAILED',
          'processing threw unexpectedly',
          { id: event.id },
          error,
        ),
      });
    }
  }
  return results;
};
