import { contentAtoms, contentIdeas, contentItems, operations, sourceDocuments } from '@sce/db';
import { findBannedPhrases } from '@sce/prompts';
import { canonicalizeText, permanent, tryCanonicalizeUrl, type Result } from '@sce/utils';
import type {
  ContentAtom,
  ContentDraft,
  ContentIdea,
  ContentItem,
  GateVerdict,
  QualityGateResult,
  SourceDocument,
} from '@sce/schemas';
import type { ServiceContext } from './context.js';
import { validateDraft } from './draft-validation.js';
import { similarity } from './dedupe.js';

/**
 * The quality gate.
 *
 * Deliberately deterministic: the same draft always produces the same verdict, so results are
 * reproducible, explainable to the human approving them, and testable against fixtures. It never
 * edits the draft - a gate that quietly rewrites claims would destroy the provenance the rest of
 * the system exists to maintain.
 *
 * Bump GATE_VERSION whenever a check changes; the version is stored with every result so old
 * verdicts stay interpretable.
 */
export const GATE_VERSION = 'gate.v1';

/** Reason severities: `block` forces REJECT, `warn` accumulates towards NEEDS_REVIEW. */
export type ReasonSeverity = 'info' | 'warn' | 'block';

export interface GateReason {
  code: string;
  severity: ReasonSeverity;
  detail: string;
}

/** More than this many warnings means a human should look before it goes near a queue. */
export const NEEDS_REVIEW_WARNING_THRESHOLD = 2;

/** Drafts this similar to existing content are repetition, not a new post. */
export const REPETITION_THRESHOLD = 0.5;

interface GateInput {
  item: ContentItem;
  idea: ContentIdea;
  atom: ContentAtom;
  sources: SourceDocument[];
  /** Live drafts for other ideas, used for the repetition check. */
  otherDrafts: Array<{ id: string; text: string }>;
}

const FIRST_PERSON_EXPERIENCE =
  /\b(i (shipped|built|debugged|fixed|ran|measured|deployed|lost|spent|broke|migrated)|we (shipped|built|ran|measured|deployed|migrated)|in production i|my team)\b/i;

const MECHANISM_MARKERS =
  /\b(because|since|so that|which means|the reason|due to|as a result|therefore|otherwise|unless)\b/i;

const HYPE_MARKERS =
  /\b(insane|crazy|massive|huge|unbelievable|shocking|blew my mind|literally the best)\b/i;

const urlsIn = (text: string): string[] => text.match(/https?:\/\/[^\s)<>"']+/g) ?? [];

/** Runs every check. Pure: no I/O, no clock, so fixtures are exact. */
export const evaluateDraft = (
  input: GateInput,
): { verdict: GateVerdict; score: number; reasons: GateReason[] } => {
  const { item, idea, atom, sources, otherDrafts } = input;
  const draft: ContentDraft = item.draft;
  const reasons: GateReason[] = [];
  const fullText = [draft.hook, draft.body, draft.call_to_action ?? ''].join('\n');

  // ---------------------------------------------------------------- platform constraints
  const validation = validateDraft(item.format, draft);
  for (const error of validation.errors) {
    reasons.push({ code: `PLATFORM_${error.code}`, severity: 'block', detail: error.detail });
  }
  for (const warning of validation.warnings) {
    reasons.push({
      code: warning.code,
      severity: warning.code === 'BANNED_PHRASE' ? 'warn' : 'warn',
      detail: warning.detail,
    });
  }

  // ---------------------------------------------------------------- evidence
  const needsEvidence = idea.evidence_required;
  if (needsEvidence) {
    if (atom.evidence_status === 'research_failed') {
      reasons.push({
        code: 'EVIDENCE_RESEARCH_FAILED',
        severity: 'block',
        detail: 'this idea requires evidence, but research failed for its atom',
      });
    } else if (atom.evidence_status === 'unsupported') {
      reasons.push({
        code: 'EVIDENCE_MISSING',
        severity: 'block',
        detail: 'this idea requires evidence, but no sources are attached to its atom',
      });
    } else if (
      atom.evidence_status === 'needs_review' ||
      atom.evidence_status === 'partially_supported'
    ) {
      reasons.push({
        code: 'EVIDENCE_WEAK',
        severity: 'warn',
        detail: `evidence status is ${atom.evidence_status}; claims should be stated as observation, not settled fact`,
      });
    }

    if (draft.source_attributions.length === 0 && sources.length > 0) {
      reasons.push({
        code: 'ATTRIBUTION_MISSING',
        severity: 'warn',
        detail: 'sources exist for this atom but the draft carries no attribution',
      });
    }
  }

  if (sources.length > 0 && sources.every((source) => source.provider === 'mock')) {
    reasons.push({
      code: 'SYNTHETIC_EVIDENCE',
      severity: 'block',
      detail: 'every attached source is synthetic (mock provider); it cannot support public claims',
    });
  }

  // ---------------------------------------------------------------- claim support
  const unsupportedClaims = atom.body.claims.filter((claim) => claim.status === 'unsupported');
  const reviewClaims = atom.body.claims.filter((claim) => claim.status === 'needs_review');
  if (unsupportedClaims.length > 0) {
    reasons.push({
      code: 'UNSUPPORTED_CLAIM',
      severity: 'block',
      detail: `${unsupportedClaims.length} atom claim(s) are unsupported: "${unsupportedClaims[0]!.claim.slice(0, 120)}"`,
    });
  }
  if (reviewClaims.length > 0) {
    reasons.push({
      code: 'CLAIM_NEEDS_REVIEW',
      severity: 'warn',
      detail: `${reviewClaims.length} atom claim(s) are unverified`,
    });
  }

  // ---------------------------------------------------------------- source traceability
  const knownUrls = new Set(
    [...sources.map((s) => s.canonical_url), ...draft.source_attributions.map((a) => a.url)]
      .map((url) => tryCanonicalizeUrl(url)?.canonical)
      .filter((url): url is string => url !== undefined),
  );
  for (const url of urlsIn(fullText)) {
    const canonical = tryCanonicalizeUrl(url)?.canonical;
    if (!canonical || !knownUrls.has(canonical)) {
      reasons.push({
        code: 'UNTRACEABLE_URL',
        severity: 'block',
        detail: `draft links to ${url}, which is not one of the atom's retrieved sources`,
      });
    }
  }
  for (const attribution of draft.source_attributions) {
    if (!sources.some((source) => source.id === attribution.source_id)) {
      reasons.push({
        code: 'ATTRIBUTION_UNKNOWN_SOURCE',
        severity: 'block',
        detail: `attribution references ${attribution.source_id}, which is not attached to this atom`,
      });
    }
  }

  // ---------------------------------------------------------------- honesty about experience
  const claimsExperience = FIRST_PERSON_EXPERIENCE.test(fullText);
  if (claimsExperience && !atom.body.personal_observation) {
    reasons.push({
      code: 'FABRICATED_EXPERIENCE',
      severity: 'block',
      detail: 'the draft claims personal experience that the learning note never recorded',
    });
  }

  // ---------------------------------------------------------------- generic / hype language
  const banned = findBannedPhrases(fullText);
  if (banned.length > 1) {
    reasons.push({
      code: 'GENERIC_LANGUAGE',
      severity: 'block',
      detail: `${banned.length} generic phrases: ${banned.slice(0, 3).join(', ')}`,
    });
  }
  if (HYPE_MARKERS.test(fullText)) {
    reasons.push({
      code: 'HYPE',
      severity: 'warn',
      detail: 'hype language weakens a technical claim',
    });
  }
  const exclamations = (fullText.match(/!/g) ?? []).length;
  if (exclamations > 2) {
    reasons.push({
      code: 'EXCESSIVE_PUNCTUATION',
      severity: 'warn',
      detail: `${exclamations} exclamation marks`,
    });
  }

  // ---------------------------------------------------------------- does it teach anything
  if (!MECHANISM_MARKERS.test(fullText)) {
    reasons.push({
      code: 'NO_MECHANISM',
      severity: 'warn',
      detail: 'the draft states what, never why; it explains no mechanism',
    });
  }

  const mentionsEntity = atom.entities.some((entity) =>
    fullText.toLowerCase().includes(entity.toLowerCase()),
  );
  const hasNumbers = /\d/.test(fullText);
  const hasExample = Boolean(atom.body.example) && fullText.length > 200;
  if (!mentionsEntity && !hasNumbers && !hasExample) {
    reasons.push({
      code: 'NOT_SPECIFIC',
      severity: 'warn',
      detail: 'no technology, number or concrete example appears in the draft',
    });
  }

  // ---------------------------------------------------------------- repetition
  const canonical = canonicalizeText(draft.body);
  for (const other of otherDrafts) {
    const score = similarity(canonical, canonicalizeText(other.text));
    if (score >= REPETITION_THRESHOLD) {
      reasons.push({
        code: 'REPEATS_EXISTING_CONTENT',
        severity: 'block',
        detail: `${Math.round(score * 100)}% similar to ${other.id}`,
      });
      break;
    }
  }

  // ---------------------------------------------------------------- verdict
  const blocks = reasons.filter((reason) => reason.severity === 'block');
  const warns = reasons.filter((reason) => reason.severity === 'warn');

  const verdict: GateVerdict =
    blocks.length > 0
      ? 'reject'
      : warns.length >= NEEDS_REVIEW_WARNING_THRESHOLD
        ? 'needs_review'
        : 'pass';

  // Score is a readable summary, not the decision: the verdict comes from the reasons.
  const score = Number(Math.max(0, 1 - blocks.length * 0.4 - warns.length * 0.12).toFixed(3));

  return { verdict, score, reasons };
};

export interface GateOptions {
  /** Re-evaluate even when a stored result for this gate version exists. */
  force?: boolean;
}

export interface GateOutcome {
  item: ContentItem;
  result: QualityGateResult;
  /** True when a stored result from the same gate version was reused. */
  unchanged: boolean;
}

export const runQualityGate = async (
  ctx: ServiceContext,
  itemId: string,
  options: GateOptions = {},
): Promise<Result<GateOutcome>> => {
  const item = await contentItems.findContentItem(ctx.db, itemId);
  if (!item)
    return { ok: false, error: permanent('E_ITEM_NOT_FOUND', `no content item ${itemId}`) };

  // Idempotent by construction: the same draft and the same gate version give the same verdict,
  // so a replay returns the stored result instead of rewriting it.
  if (
    item.quality_gate &&
    item.quality_gate.gate_version === GATE_VERSION &&
    options.force !== true
  ) {
    return { ok: true, value: { item, result: item.quality_gate, unchanged: true } };
  }

  const idea = await contentIdeas.findIdea(ctx.db, item.content_idea_id);
  const atom = await contentAtoms.findAtom(ctx.db, item.content_atom_id);
  if (!idea || !atom) {
    return {
      ok: false,
      error: permanent('E_ITEM_INCOMPLETE', `content item ${itemId} is missing its idea or atom`),
    };
  }

  const sources = await sourceDocuments.listSourcesForAtom(ctx.db, atom.id);
  const siblings = await contentItems.listContentItems(ctx.db, { limit: 200 });
  const otherDrafts = siblings
    .filter(
      (other) =>
        other.id !== item.id &&
        other.content_idea_id !== item.content_idea_id &&
        other.status !== 'superseded' &&
        other.status !== 'rejected',
    )
    .map((other) => ({ id: other.id, text: other.draft.body }));

  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'content_quality_gate_v1',
    correlationId: item.correlation_id,
    subjectId: item.id,
    input: { format: item.format, gate_version: GATE_VERSION },
  });

  const evaluation = evaluateDraft({ item, idea, atom, sources, otherDrafts });
  const result: QualityGateResult = {
    verdict: evaluation.verdict,
    score: evaluation.score,
    gate_version: GATE_VERSION,
    reasons: evaluation.reasons,
    evaluated_at: ctx.clock().toISOString(),
  };

  // The gate records its judgement; it never edits the draft itself.
  const transition = await contentItems.setContentItemStatus(
    ctx.db,
    item.id,
    evaluation.verdict === 'reject' ? 'rejected' : 'gated',
    { quality_gate: result },
  );

  ctx.logger.child({ workflow: 'content_quality_gate_v1', content_item_id: item.id }).info(
    {
      verdict: result.verdict,
      score: result.score,
      blocks: evaluation.reasons.filter((r) => r.severity === 'block').length,
      warns: evaluation.reasons.filter((r) => r.severity === 'warn').length,
    },
    'quality gate evaluated',
  );

  await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
    verdict: result.verdict,
    score: result.score,
  });

  return {
    ok: true,
    value: { item: transition?.item ?? item, result, unchanged: false },
  };
};
