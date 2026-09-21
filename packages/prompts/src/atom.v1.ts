import { contentAtomBody, CONTENT_ANGLES } from '@sce/schemas';
import { note, type PromptDefinition } from './types.js';

export interface AtomBuildInput {
  title: string;
  text: string;
  topic: string;
  kind: string;
  entities: string[];
  sources: Array<{
    id: string;
    title: string;
    url: string;
    source_type: string;
    excerpt: string | null;
  }>;
}

/**
 * Content Atom v1.
 *
 * Turns one learning note into the canonical object every format is later derived from. The model
 * is told explicitly what it may not do: invent facts, invent sources, or invent personal
 * experience. Anything it cannot support from the note or the supplied sources must be left null
 * and listed as an unsupported claim - a visible gap is worth far more than a confident fiction.
 */
export const atomV1: PromptDefinition<AtomBuildInput, typeof contentAtomBody> = {
  id: 'atom',
  version: 'atom.v1',
  description: 'Builds the canonical Content Atom body from a learning note and its evidence.',
  outputSchema: contentAtomBody,

  build(input) {
    const system = `You structure one engineering learning into a reusable knowledge object.

Hard rules:
- Use ONLY the note and the supplied sources. Never add facts from your own knowledge.
- Never invent a source, a URL, a number, or a personal experience.
- "personal_observation" may only contain something the note itself states in the first person.
  If the note contains none, set it to null.
- Any field you cannot support from the note or the sources must be null - not a guess, not a
  generic filler sentence.
- "claims" lists the factual statements your output makes. For each, set status to "supported"
  when a supplied source backs it, "needs_review" when it comes only from the note, and
  "unsupported" when neither backs it. Reference sources by their given id only.
- "angle_candidates" may only use: ${CONTENT_ANGLES.join(', ')}.
- Reply with a single JSON object and nothing else.`;

    const sources =
      input.sources.length > 0
        ? input.sources
            .map(
              (s, i) =>
                `[${i + 1}] id=${s.id} type=${s.source_type}\n    title: ${s.title}\n    url: ${s.url}` +
                (s.excerpt ? `\n    excerpt: ${s.excerpt.slice(0, 600)}` : ''),
            )
            .join('\n')
        : '(no sources were retrieved - every claim from the note is at best needs_review)';

    const user = `Build the Content Atom for this learning.

Title: ${input.title}
Topic: ${input.topic}
Kind: ${input.kind}
Entities mentioned: ${input.entities.length > 0 ? input.entities.join(', ') : '(none)'}

${note(input.text)}

Sources:
${sources}

Return JSON with keys: problem, core_insight, first_principles, example, implementation_details,
failure_mode, mental_model, personal_observation, claims, angle_candidates.`;

    return { system, user };
  },
};
