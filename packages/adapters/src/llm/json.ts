import type { z } from 'zod';
import { permanent, type Result } from '@sce/utils';
import type { LlmAdapter, LlmJsonResult, LlmRequest } from './types.js';

/** Extracts the first JSON object from a completion, tolerating fenced or prefixed output. */
export const extractJson = (text: string): unknown => {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost braces - models often prepend a sentence.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new SyntaxError('completion contained no JSON object');
  }
};

/**
 * Completion + parse + schema validation in one step. A malformed or off-schema answer is a
 * permanent failure carrying the offending issues, so callers can store the failure rather than
 * silently accepting junk.
 */
export const completeJson = async <S extends z.ZodTypeAny>(
  llm: LlmAdapter,
  request: LlmRequest,
  schema: S,
): Promise<LlmJsonResult<z.infer<S>>> => {
  const completion = await llm.complete({ ...request, json: true });
  if (!completion.ok) return completion as Result<never, typeof completion.error>;

  let parsed: unknown;
  try {
    parsed = extractJson(completion.value.text);
  } catch (error) {
    return {
      ok: false,
      error: permanent(
        'E_LLM_NOT_JSON',
        `${request.purpose}: model did not return JSON`,
        {
          purpose: request.purpose,
          model: completion.value.model,
          preview: completion.value.text.slice(0, 200),
        },
        error,
      ),
    };
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      error: permanent(
        'E_LLM_SCHEMA',
        `${request.purpose}: model output failed schema validation`,
        {
          purpose: request.purpose,
          model: completion.value.model,
          issues: validated.error.issues.slice(0, 10).map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      ),
    };
  }

  return {
    ok: true,
    value: {
      value: validated.data,
      model: completion.value.model,
      provider: completion.value.provider,
    },
  };
};
