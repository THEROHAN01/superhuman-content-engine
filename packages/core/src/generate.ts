import { contentAtoms, contentIdeas, contentItems, operations, sourceDocuments } from '@sce/db';
import { completeJson, type LlmAdapter } from '@sce/adapters';
import { GENERATORS } from '@sce/prompts';
import { newId, permanent, type Result } from '@sce/utils';
import {
  FORMAT_PLATFORM,
  type ContentDraft,
  type ContentFormat,
  type ContentItem,
} from '@sce/schemas';
import type { ServiceContext } from './context.js';
import { renderBody, validateDraft, type DraftIssue } from './draft-validation.js';

/**
 * Platform generation.
 *
 * Each draft is a new, immutable version: regeneration supersedes rather than overwrites, and the
 * prompt id, prompt version and model that produced it are stored alongside. A draft that breaks a
 * platform's hard limits is never stored as usable content - it fails with the specific violations.
 */
export interface GenerateOptions {
  llm: LlmAdapter;
  /** Formats to produce; defaults to the formats the idea itself proposed. */
  formats?: ContentFormat[];
  /** Produce a new version even when a draft already exists for that format. */
  regenerate?: boolean;
}

export interface GeneratedItem {
  item: ContentItem;
  warnings: DraftIssue[];
  superseded_id: string | null;
}

export interface GenerationFailure {
  format: ContentFormat;
  code: string;
  message: string;
  errors?: DraftIssue[];
}

export interface GenerateResult {
  items: GeneratedItem[];
  failures: GenerationFailure[];
  skipped: ContentFormat[];
}

export const generateContentItems = async (
  ctx: ServiceContext,
  ideaId: string,
  options: GenerateOptions,
): Promise<Result<GenerateResult>> => {
  const idea = await contentIdeas.findIdea(ctx.db, ideaId);
  if (!idea)
    return { ok: false, error: permanent('E_IDEA_NOT_FOUND', `no content idea ${ideaId}`) };

  const atom = await contentAtoms.findAtom(ctx.db, idea.content_atom_id);
  if (!atom || atom.status !== 'ready') {
    return {
      ok: false,
      error: permanent('E_ATOM_NOT_READY', `idea ${idea.id} has no ready atom`, {
        atom_status: atom?.status ?? 'missing',
      }),
    };
  }

  const formats = (options.formats ?? (idea.formats as ContentFormat[])).filter(
    (format): format is ContentFormat => format in GENERATORS,
  );
  if (formats.length === 0) {
    return {
      ok: false,
      error: permanent('E_NO_FORMATS', `idea ${idea.id} proposes no known formats`),
    };
  }

  const sources = await sourceDocuments.listSourcesForAtom(ctx.db, atom.id);
  const correlationId = `cor_generate_${idea.id}`;
  const log = ctx.logger.child({ workflow: 'content_generate_v1', content_idea_id: idea.id });
  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'content_generate_v1',
    correlationId,
    subjectId: idea.id,
    input: { formats, regenerate: options.regenerate === true },
  });

  const existing = await contentItems.listItemsForIdea(ctx.db, idea.id);
  const result: GenerateResult = { items: [], failures: [], skipped: [] };

  for (const format of formats) {
    const live = existing.find((item) => item.format === format && item.status !== 'superseded');
    if (live && options.regenerate !== true) {
      result.skipped.push(format);
      continue;
    }

    const prompt = GENERATORS[format];
    const built = prompt.build({
      idea: {
        angle: idea.angle,
        title: idea.title,
        hook: idea.hook,
        audience: idea.audience,
        rationale: idea.rationale,
      },
      atom: {
        title: atom.title,
        topic: atom.primary_topic,
        problem: atom.body.problem,
        core_insight: atom.body.core_insight,
        first_principles: atom.body.first_principles,
        example: atom.body.example,
        implementation_details: atom.body.implementation_details,
        failure_mode: atom.body.failure_mode,
        mental_model: atom.body.mental_model,
        personal_observation: atom.body.personal_observation,
      },
      sources: sources.map((s) => ({ id: s.id, title: s.title, url: s.canonical_url })),
      evidenceStatus: atom.evidence_status,
    });

    const completion = await completeJson(
      options.llm,
      {
        purpose: prompt.version,
        system: built.system,
        user: built.user,
        correlationId,
        temperature: 0.5,
      },
      prompt.outputSchema,
    );

    if (!completion.ok) {
      result.failures.push({
        format,
        code: completion.error.code,
        message: completion.error.message,
      });
      await operations.recordError(ctx.db, {
        workflow: 'content_generate_v1',
        step: `generate:${format}`,
        kind: completion.error.kind,
        code: completion.error.code,
        message: completion.error.message,
        correlationId,
        subjectId: idea.id,
      });
      continue;
    }

    const generated = completion.value.value;
    const draft: ContentDraft = {
      hook: generated.hook,
      units: generated.units.map((unit, index) => ({
        index,
        text: unit.text,
        note: unit.note ?? null,
      })),
      body: renderBody(format, generated.units),
      hashtags: generated.hashtags ?? [],
      call_to_action: generated.call_to_action ?? null,
      // Attribution travels with the draft, so publishing cannot lose the evidence trail.
      source_attributions: sources.slice(0, 3).map((s) => ({
        source_id: s.id,
        url: s.canonical_url,
        title: s.title.slice(0, 300),
      })),
    };

    const validation = validateDraft(format, draft);
    if (!validation.valid) {
      result.failures.push({
        format,
        code: 'E_DRAFT_INVALID',
        message: `draft violates ${format} limits`,
        errors: validation.errors,
      });
      await operations.recordError(ctx.db, {
        workflow: 'content_generate_v1',
        step: `validate:${format}`,
        kind: 'permanent',
        code: 'E_DRAFT_INVALID',
        message: validation.errors.map((e) => e.detail).join('; '),
        correlationId,
        subjectId: idea.id,
        details: { format, errors: validation.errors },
      });
      continue;
    }

    const { item, supersededId } = await contentItems.insertContentItemVersion(ctx.db, {
      id: newId('contentItem'),
      content_idea_id: idea.id,
      content_atom_id: atom.id,
      learning_event_id: atom.learning_event_id,
      platform: FORMAT_PLATFORM[format],
      format,
      draft,
      prompt_id: prompt.id,
      prompt_version: prompt.version,
      model: completion.value.model,
      correlation_id: correlationId,
    });

    result.items.push({ item, warnings: validation.warnings, superseded_id: supersededId });
  }

  if (result.items.length > 0) {
    await contentIdeas.setIdeaStatus(ctx.db, idea.id, 'used');
  }

  log.info(
    {
      generated: result.items.length,
      failed: result.failures.length,
      skipped: result.skipped.length,
    },
    'content generation complete',
  );
  await operations.finishWorkflowRun(
    ctx.db,
    runId,
    result.items.length > 0 || result.skipped.length > 0 ? 'succeeded' : 'failed',
    {
      generated: result.items.length,
      failed: result.failures.length,
      skipped: result.skipped.length,
    },
  );

  return { ok: true, value: result };
};

export const getContentItem = async (ctx: ServiceContext, id: string) =>
  contentItems.findContentItem(ctx.db, id);

export const listItemsForIdea = async (ctx: ServiceContext, ideaId: string) =>
  contentItems.listItemsForIdea(ctx.db, ideaId);
