import { contentAtoms, learningEvents, operations, sourceDocuments } from '@sce/db';
import { completeJson, type LlmAdapter } from '@sce/adapters';
import { atomV1 } from '@sce/prompts';
import { permanent, type Result } from '@sce/utils';
import type { ContentAtom, EvidenceStatus } from '@sce/schemas';
import { readyContentAtom } from '@sce/schemas';
import type { ServiceContext } from './context.js';

/**
 * Builds the canonical Content Atom body.
 *
 * This is the object every later format is derived from, so the failure modes are handled
 * explicitly: a model failure or an off-schema answer leaves the atom in `failed` with the error
 * recorded, and a body that references sources the atom does not have is rejected rather than
 * stored. One learning event always maps to exactly one atom (database constraint).
 */
export interface BuildAtomOptions {
  llm: LlmAdapter;
  /** Rebuild even if the atom is already `ready`. */
  force?: boolean;
}

export interface BuildAtomResult {
  atom: ContentAtom;
  unchanged: boolean;
  evidence_status: EvidenceStatus;
  /** Claims the model could not support with a supplied source. */
  unsupported_claims: number;
}

export const buildContentAtom = async (
  ctx: ServiceContext,
  atomId: string,
  options: BuildAtomOptions,
): Promise<Result<BuildAtomResult>> => {
  const atom = await contentAtoms.findAtom(ctx.db, atomId);
  if (!atom)
    return { ok: false, error: permanent('E_ATOM_NOT_FOUND', `no content atom ${atomId}`) };

  if (atom.status === 'ready' && options.force !== true) {
    return {
      ok: true,
      value: {
        atom,
        unchanged: true,
        evidence_status: atom.evidence_status,
        unsupported_claims: atom.body.claims.filter((c) => c.status !== 'supported').length,
      },
    };
  }

  const event = await learningEvents.findLearningEvent(ctx.db, atom.learning_event_id);
  if (!event) {
    return {
      ok: false,
      error: permanent('E_EVENT_NOT_FOUND', `atom ${atom.id} references a missing learning event`),
    };
  }

  const sources = await sourceDocuments.listSourcesForAtom(ctx.db, atom.id);
  const correlationId = event.correlation_id;
  const log = ctx.logger.child({
    workflow: 'atom_build_v1',
    content_atom_id: atom.id,
    correlation_id: correlationId,
  });

  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'atom_build_v1',
    correlationId,
    subjectId: atom.id,
    input: { sources: sources.length, force: options.force === true },
  });

  const prompt = atomV1.build({
    title: atom.title,
    text: event.normalized_text ?? event.raw_text,
    topic: atom.primary_topic,
    kind: atom.kind,
    entities: atom.entities,
    sources: sources.map((s) => ({
      id: s.id,
      title: s.title,
      url: s.canonical_url,
      source_type: s.source_type,
      excerpt: s.excerpt,
    })),
  });

  const completion = await completeJson(
    options.llm,
    {
      purpose: atomV1.version,
      system: prompt.system,
      user: prompt.user,
      correlationId,
      temperature: 0.2,
    },
    atomV1.outputSchema,
  );

  const failAtom = async (code: string, message: string, kind: 'transient' | 'permanent') => {
    await contentAtoms.updateAtom(ctx.db, atom.id, {
      status: 'failed',
      error: `${code}: ${message}`.slice(0, 2000),
    });
    await operations.recordError(ctx.db, {
      workflow: 'atom_build_v1',
      step: 'build',
      kind,
      code,
      message,
      correlationId,
      subjectId: atom.id,
    });
    await operations.finishWorkflowRun(ctx.db, runId, 'failed', { code });
  };

  if (!completion.ok) {
    await failAtom(completion.error.code, completion.error.message, completion.error.kind);
    log.warn({ code: completion.error.code }, 'atom build failed');
    return { ok: false, error: completion.error };
  }

  const body = completion.value.value;

  // A model may only cite sources this atom actually has. Anything else is a fabricated citation.
  const knownSourceIds = new Set(sources.map((s) => s.id));
  const invalidCitations = body.claims.flatMap((claim) =>
    claim.source_ids.filter((id) => !knownSourceIds.has(id)),
  );
  if (invalidCitations.length > 0) {
    const message = `body cites unknown sources: ${invalidCitations.slice(0, 5).join(', ')}`;
    await failAtom('E_ATOM_INVALID_CITATION', message, 'permanent');
    log.warn({ invalidCitations }, 'atom build rejected: fabricated citations');
    return {
      ok: false,
      error: permanent('E_ATOM_INVALID_CITATION', message, { invalidCitations }),
    };
  }

  // A claim can only be "supported" if it names a source; downgrade anything that claims support
  // without evidence rather than trusting the label.
  const claims = body.claims.map((claim) =>
    claim.status === 'supported' && claim.source_ids.length === 0
      ? { ...claim, status: 'needs_review' as const, note: 'no source cited' }
      : claim,
  );

  const unsupported = claims.filter((c) => c.status !== 'supported').length;

  /**
   * Evidence strength, strongest first. The final status is the *weaker* of what research
   * established and what the claims justify, so building an atom can never upgrade evidence:
   * synthetic sources stay `needs_review` however confidently the model labels its claims.
   */
  const STRENGTH: EvidenceStatus[] = [
    'supported',
    'partially_supported',
    'needs_review',
    'unsupported',
  ];
  const weaker = (a: EvidenceStatus, b: EvidenceStatus): EvidenceStatus =>
    STRENGTH.indexOf(a) >= STRENGTH.indexOf(b) ? a : b;

  const claimStatus: EvidenceStatus =
    claims.length === 0 ? 'unsupported' : unsupported === 0 ? 'supported' : 'needs_review';

  const evidenceStatus: EvidenceStatus =
    // Terminal research outcomes are not opinions the build step gets to revise.
    atom.evidence_status === 'research_failed' || atom.evidence_status === 'not_required'
      ? atom.evidence_status
      : atom.evidence_status === 'pending'
        ? claimStatus
        : weaker(atom.evidence_status, claimStatus);

  const candidate: ContentAtom = {
    ...atom,
    status: 'ready',
    body: { ...body, claims },
    evidence_status: evidenceStatus,
    atomized_at: ctx.clock().toISOString(),
    error: null,
  };

  // The atom must satisfy the stricter "ready" contract before it is stored as ready.
  const validated = readyContentAtom.safeParse(candidate);
  if (!validated.success) {
    const message = validated.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    await failAtom('E_ATOM_INCOMPLETE', message, 'permanent');
    log.warn({ issues: message }, 'atom build rejected: incomplete body');
    return { ok: false, error: permanent('E_ATOM_INCOMPLETE', message) };
  }

  const updated = await contentAtoms.updateAtom(ctx.db, atom.id, {
    status: 'ready',
    body: candidate.body,
    evidence_status: evidenceStatus,
    atomized_at: candidate.atomized_at ?? undefined,
    error: '', // clears any error from a previous failed build
  });

  log.info(
    {
      evidence_status: evidenceStatus,
      claims: claims.length,
      unsupported,
      sources: sources.length,
    },
    'content atom built',
  );
  await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
    evidence_status: evidenceStatus,
    claims: claims.length,
    unsupported,
  });

  return {
    ok: true,
    value: {
      atom: updated ?? candidate,
      unchanged: false,
      evidence_status: evidenceStatus,
      unsupported_claims: unsupported,
    },
  };
};

export interface AtomWithEvidence {
  atom: ContentAtom;
  sources: Awaited<ReturnType<typeof sourceDocuments.listSourcesForAtom>>;
  learning_event_id: string;
}

/** Atom plus its evidence: the provenance view used by the API and the approval card. */
export const getContentAtom = async (
  ctx: ServiceContext,
  atomId: string,
): Promise<AtomWithEvidence | null> => {
  const atom = await contentAtoms.findAtom(ctx.db, atomId);
  if (!atom) return null;
  return {
    atom,
    sources: await sourceDocuments.listSourcesForAtom(ctx.db, atom.id),
    learning_event_id: atom.learning_event_id,
  };
};
