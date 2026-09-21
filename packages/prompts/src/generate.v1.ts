import { z } from 'zod';
import { contentDraft, constraintsFor, type ContentFormat } from '@sce/schemas';
import { BRAND_VOICE } from './brand-voice.js';
import { BANNED_PHRASE_RULE } from './banned-phrases.js';
import { renderExamples } from './examples.js';
import { note, type PromptDefinition } from './types.js';

/**
 * Platform generators.
 *
 * One builder, five prompts - because the *voice* and the *evidence rules* must be identical
 * across formats while the structure must not be. Each format supplies its own structural
 * instruction, and the platform limits come from `PLATFORM_CONSTRAINTS` rather than from prompt
 * text, so validation and generation can never disagree.
 */
export const generationOutput = contentDraft.pick({
  hook: true,
  units: true,
  hashtags: true,
  call_to_action: true,
});

export interface GenerationInput {
  idea: {
    angle: string;
    title: string;
    hook: string;
    audience: string;
    rationale: string;
  };
  atom: {
    title: string;
    topic: string;
    problem: string;
    core_insight: string;
    first_principles: string;
    example: string | null;
    implementation_details: string | null;
    failure_mode: string | null;
    mental_model: string | null;
    personal_observation: string | null;
  };
  sources: Array<{ id: string; title: string; url: string }>;
  evidenceStatus: string;
}

const FORMAT_INSTRUCTIONS: Record<ContentFormat, string> = {
  x_post: `Write ONE post for X.
- A single unit. Line breaks are allowed inside it.
- Lead with the mechanism or the failure, not with a promise of value.
- No thread labels, no numbering, no "read on".`,

  x_thread: `Write a thread for X.
- Each unit is one post. The first unit must stand alone if nobody reads the rest.
- Each subsequent unit must add information, not restate the previous one.
- The last unit states the practical consequence. No "follow me" ending.`,

  linkedin_post: `Write ONE post for LinkedIn.
- A single unit with paragraph breaks.
- More context than X: state the situation, the mechanism, and the transferable principle.
- Professional but not corporate. No emoji rows, no "Agree?" ending.`,

  reel_script: `Write a spoken script for a short vertical video.
- Each unit is one beat, prefixed with its timing like [0-3s].
- Write for the ear: short sentences, no nested clauses, no bullet syntax.
- Use the note in the "note" field of each unit for what is shown on screen.`,

  carousel: `Write a carousel.
- Each unit is one slide. One idea per slide, readable on its own.
- Slide 1 states the problem. The last slide states the resolution or the principle.
- Keep slide text short; put visual direction in the "note" field of each unit.`,
};

const buildPrompt = (
  format: ContentFormat,
): PromptDefinition<GenerationInput, typeof generationOutput> => {
  const constraints = constraintsFor(format);

  return {
    id: format,
    version: `${format.replace(/_/g, '-')}.v1`,
    description: `Generates a ${format} draft from an approved content idea.`,
    outputSchema: generationOutput,

    build(input) {
      const system = `${BRAND_VOICE}

${FORMAT_INSTRUCTIONS[format]}

Hard limits (the output is rejected if it breaks them):
- units: between ${constraints.minUnits} and ${constraints.maxUnits}
- characters per unit: at most ${constraints.maxChars}
- hook: at most ${constraints.maxHookChars} characters

Evidence rules:
- Use only what the atom and the listed sources state. Never add a fact, a number, a benchmark or
  a quote that is not there.
- Never claim personal experience unless the atom's personal observation states it.
- If the evidence status is not "supported", do not present claims as settled fact; write them as
  what you observed or understood.

${BANNED_PHRASE_RULE}

Reply with a single JSON object: {"hook", "units":[{"index","text","note"}], "hashtags", "call_to_action"}.
Set "call_to_action" to null unless it genuinely helps the reader. Keep hashtags to at most 3, or
none for X.`;

      const examples = renderExamples(format);
      const sources =
        input.sources.length > 0
          ? input.sources.map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`).join('\n')
          : '(no sources - do not imply external validation)';

      const user = `Write the ${format} for this idea.

Idea angle: ${input.idea.angle}
Idea title: ${input.idea.title}
Suggested hook: ${input.idea.hook}
Audience: ${input.idea.audience}
Why this idea: ${input.idea.rationale}
Evidence status: ${input.evidenceStatus}

${note(
  [
    `Problem: ${input.atom.problem}`,
    `Core insight: ${input.atom.core_insight}`,
    `First principles: ${input.atom.first_principles}`,
    input.atom.example ? `Example: ${input.atom.example}` : null,
    input.atom.implementation_details
      ? `Implementation: ${input.atom.implementation_details}`
      : null,
    input.atom.failure_mode ? `Failure mode: ${input.atom.failure_mode}` : null,
    input.atom.mental_model ? `Mental model: ${input.atom.mental_model}` : null,
    input.atom.personal_observation
      ? `Personal observation: ${input.atom.personal_observation}`
      : null,
  ]
    .filter(Boolean)
    .join('\n'),
)}

Sources:
${sources}
${examples ? `\n${examples}\n` : ''}
Return the JSON object only.`;

      return { system, user };
    },
  };
};

export const xPostV1 = buildPrompt('x_post');
export const xThreadV1 = buildPrompt('x_thread');
export const linkedinPostV1 = buildPrompt('linkedin_post');
export const reelScriptV1 = buildPrompt('reel_script');
export const carouselV1 = buildPrompt('carousel');

export const GENERATORS: Record<
  ContentFormat,
  PromptDefinition<GenerationInput, typeof generationOutput>
> = {
  x_post: xPostV1,
  x_thread: xThreadV1,
  linkedin_post: linkedinPostV1,
  reel_script: reelScriptV1,
  carousel: carouselV1,
};

/** Hook-first generation: used when the format's opening line carries most of the weight. */
export const hookV1: PromptDefinition<
  GenerationInput & { format: ContentFormat },
  z.ZodObject<{ hooks: z.ZodArray<z.ZodString> }>
> = {
  id: 'hook',
  version: 'hook.v1',
  description: 'Generates candidate opening lines before the body is written.',
  outputSchema: z.object({ hooks: z.array(z.string().min(10).max(400)).min(1).max(5) }),

  build(input) {
    const constraints = constraintsFor(input.format);
    return {
      system: `${BRAND_VOICE}

Write opening lines only. A good opening states the surprising mechanism, the failure, or the
concrete situation. It never promises value ("here is why this matters") and never announces
format ("a thread").

At most ${constraints.maxHookChars} characters each.

${BANNED_PHRASE_RULE}

Reply with {"hooks": ["..."]}.`,
      user: `Write 3 candidate opening lines for a ${input.format} about:

${note(`${input.atom.core_insight}\n${input.atom.first_principles}`)}

Angle: ${input.idea.angle}. Audience: ${input.idea.audience}.`,
    };
  },
};
