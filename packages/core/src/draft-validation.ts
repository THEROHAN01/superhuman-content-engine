import { constraintsFor, type ContentDraft, type ContentFormat } from '@sce/schemas';
import { findBannedPhrases } from '@sce/prompts';

/**
 * Draft validation.
 *
 * Two classes of rule, deliberately separated:
 *   - **errors** are platform facts (character limits, unit counts). A draft that breaks one
 *     cannot be published, so generation rejects it.
 *   - **warnings** are style floors and voice rules. They do not block generation; they are
 *     carried into the quality gate, which is where editorial judgement belongs.
 */
export interface DraftIssue {
  code: string;
  detail: string;
  unit?: number;
}

export interface DraftValidation {
  valid: boolean;
  errors: DraftIssue[];
  warnings: DraftIssue[];
}

export const validateDraft = (format: ContentFormat, draft: ContentDraft): DraftValidation => {
  const constraints = constraintsFor(format);
  const errors: DraftIssue[] = [];
  const warnings: DraftIssue[] = [];

  if (draft.units.length < constraints.minUnits) {
    errors.push({
      code: 'TOO_FEW_UNITS',
      detail: `${format} needs at least ${constraints.minUnits} units, got ${draft.units.length}`,
    });
  }
  if (draft.units.length > constraints.maxUnits) {
    errors.push({
      code: 'TOO_MANY_UNITS',
      detail: `${format} allows at most ${constraints.maxUnits} units, got ${draft.units.length}`,
    });
  }

  draft.units.forEach((unit, index) => {
    if (unit.text.length > constraints.maxChars) {
      errors.push({
        code: 'UNIT_TOO_LONG',
        detail: `unit ${index} is ${unit.text.length} characters, limit is ${constraints.maxChars}`,
        unit: index,
      });
    }
    if (unit.text.trim().length === 0) {
      errors.push({ code: 'EMPTY_UNIT', detail: `unit ${index} is empty`, unit: index });
    }
  });

  if (draft.hook.length > constraints.maxHookChars) {
    warnings.push({
      code: 'HOOK_TOO_LONG',
      detail: `hook is ${draft.hook.length} characters, style limit is ${constraints.maxHookChars}`,
    });
  }

  const totalLength = draft.units.reduce((sum, unit) => sum + unit.text.length, 0);
  if (totalLength < constraints.minChars) {
    warnings.push({
      code: 'TOO_SHORT',
      detail: `${totalLength} characters total; below the ${constraints.minChars} floor for ${format}`,
    });
  }

  // A multi-unit draft that repeats itself wastes the reader's attention; the gate decides how
  // badly, so this is a warning rather than a hard platform error.
  const seen = new Map<string, number>();
  draft.units.forEach((unit, index) => {
    const key = unit.text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (key.length === 0) return;
    const first = seen.get(key);
    if (first !== undefined) {
      warnings.push({
        code: 'DUPLICATE_UNIT',
        detail: `unit ${index} repeats unit ${first}`,
        unit: index,
      });
    } else {
      seen.set(key, index);
    }
  });

  const banned = findBannedPhrases([draft.hook, draft.body, draft.call_to_action ?? ''].join('\n'));
  for (const phrase of banned) {
    warnings.push({ code: 'BANNED_PHRASE', detail: `contains "${phrase}"` });
  }

  // X posts read as spam with hashtags; other platforms tolerate a few.
  if (format === 'x_post' || format === 'x_thread') {
    if (draft.hashtags.length > 0) {
      warnings.push({ code: 'HASHTAGS_ON_X', detail: 'hashtags rarely help on X' });
    }
  } else if (draft.hashtags.length > 3) {
    warnings.push({ code: 'TOO_MANY_HASHTAGS', detail: `${draft.hashtags.length} hashtags` });
  }

  return { valid: errors.length === 0, errors, warnings };
};

/** Renders units into the publishable body, per format. Publishing never re-renders. */
export const renderBody = (format: ContentFormat, units: ContentDraft['units']): string => {
  const texts = units.map((unit) => unit.text.trim());
  switch (format) {
    case 'x_thread':
      // Numbering is added at render time so the model does not have to count.
      return texts.map((text, index) => `${index + 1}/ ${text}`).join('\n\n');
    case 'carousel':
      return texts.map((text, index) => `Slide ${index + 1}: ${text}`).join('\n\n');
    case 'reel_script':
      return texts.join('\n\n');
    default:
      return texts.join('\n\n');
  }
};
