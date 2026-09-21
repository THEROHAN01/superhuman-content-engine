import { z } from 'zod';
import { CONTENT_ANGLES, CONTENT_FORMATS, contentIdeaDraft, PLATFORMS } from '@sce/schemas';
import { note, type PromptDefinition } from './types.js';

export const ideationOutput = z.object({
  ideas: z.array(contentIdeaDraft).min(1).max(8),
});

export interface IdeationInput {
  title: string;
  topic: string;
  kind: string;
  entities: string[];
  body: {
    problem: string;
    core_insight: string;
    first_principles: string;
    example: string | null;
    failure_mode: string | null;
    mental_model: string | null;
    personal_observation: string | null;
  };
  evidenceStatus: string;
  /** Titles of ideas that already exist for this atom, so the model does not repeat them. */
  existingTitles: string[];
}

/**
 * Ideation v1.
 *
 * Generates distinct content opportunities from one atom. The model is pushed towards *different
 * angles on the same truth* rather than rephrasings: each idea must name a different angle and
 * state what it adds that the others do not.
 */
export const ideationV1: PromptDefinition<IdeationInput, typeof ideationOutput> = {
  id: 'ideation',
  version: 'ideation.v1',
  description: 'Generates distinct content angles from a canonical content atom.',
  outputSchema: ideationOutput,

  build(input) {
    const system = `You turn one engineering insight into distinct content opportunities.

Rules:
- Every idea must come from the supplied atom. Never introduce facts that are not in it.
- Each idea uses a different "angle" from: ${CONTENT_ANGLES.join(', ')}.
- Ideas must differ in substance, not wording. If two ideas would teach the same thing, return one.
- "rationale" states what this idea gives a reader that the other ideas do not.
- "platforms" from: ${PLATFORMS.join(', ')}. "formats" from: ${CONTENT_FORMATS.join(', ')}.
- "hook" is the opening line a reader would actually stop for. No clickbait, no "thread" labels.
- "evidence_required" is true when the idea makes a factual claim that needs a source.
- Only propose an angle the atom can actually support: no failure_mode idea without a failure
  mode, no project_story without a personal observation.
- Return between 2 and 5 ideas. Fewer good ideas beats more weak ones.
- Reply with a single JSON object: {"ideas": [...]}.`;

    const sections = [
      `Problem: ${input.body.problem}`,
      `Core insight: ${input.body.core_insight}`,
      `First principles: ${input.body.first_principles}`,
      input.body.example ? `Example: ${input.body.example}` : null,
      input.body.failure_mode ? `Failure mode: ${input.body.failure_mode}` : null,
      input.body.mental_model ? `Mental model: ${input.body.mental_model}` : null,
      input.body.personal_observation
        ? `Personal observation: ${input.body.personal_observation}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    const user = `Propose content ideas for this atom.

Title: ${input.title}
Topic: ${input.topic}
Kind: ${input.kind}
Entities: ${input.entities.length > 0 ? input.entities.join(', ') : '(none)'}
Evidence status: ${input.evidenceStatus}
${input.existingTitles.length > 0 ? `\nAlready proposed (do not repeat):\n${input.existingTitles.map((t) => `- ${t}`).join('\n')}` : ''}

${note(sections)}

Return JSON: {"ideas": [{angle, title, rationale, audience, platforms, formats, hook, evidence_required}]}.`;

    return { system, user };
  },
};
