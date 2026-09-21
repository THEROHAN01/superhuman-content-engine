import { LEARNING_KINDS, TOPICS, learningEventClassification } from '@sce/schemas';
import { note, type PromptDefinition } from './types.js';

export interface ClassifyInput {
  text: string;
  title?: string | null;
}

/**
 * Classification prompt v1.
 *
 * The model chooses only from the declared taxonomy, and must justify its content-worthiness
 * judgement. It never decides to publish - that judgement is advisory and visible to the human.
 */
export const classifyV1: PromptDefinition<ClassifyInput, typeof learningEventClassification> = {
  id: 'classify',
  version: 'classify.v1',
  description: 'Classifies a learning note into kind, topics, entities and content-worthiness.',
  outputSchema: learningEventClassification,

  build(input) {
    const system = `You classify engineering learning notes for a personal knowledge system.

Rules:
- Choose "kind" from exactly: ${LEARNING_KINDS.join(', ')}.
- Choose "primary_topic" and each "secondary_topics" entry from exactly: ${TOPICS.join(', ')}.
- "entities" lists concrete technologies, protocols or tools named in the note (max 10). Do not
  invent entities that the note does not mention.
- "content_worthy" is your judgement about whether this could become useful public content. It is
  advisory only: a human approves everything before anything is published.
- "content_worthiness_reason" explains that judgement in one sentence.
- "confidence" is your confidence in the classification, between 0 and 1.
- Reply with a single JSON object and nothing else.`;

    const user = `Classify this learning note.${input.title ? `\n\nTitle: ${input.title}` : ''}

${note(input.text)}

Return JSON with keys: kind, primary_topic, secondary_topics, entities, content_worthy,
content_worthiness_reason, confidence.`;

    return { system, user };
  },
};
