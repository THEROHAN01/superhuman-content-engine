import { permanent, type Result } from '@sce/utils';
import type { LlmAdapter, LlmRequest, LlmResponse } from './types.js';
import {
  causalSentence,
  extractField,
  extractNote,
  extractSourceIds,
  firstPersonSentence,
  inferContentWorthiness,
  inferEntities,
  inferKind,
  inferTopics,
  mistakeSentence,
  sentences,
} from './mock-knowledge.js';

/**
 * Deterministic offline provider. Same input -> same output, always, which is what makes the
 * pipeline testable without a model and keeps fixtures meaningful.
 *
 * Each purpose has an explicit handler. An unknown purpose fails loudly rather than returning
 * something plausible - a silent stub would let an untested code path look healthy.
 */
export type MockHandler = (request: LlmRequest) => unknown;

export const defaultMockHandlers: Record<string, MockHandler> = {
  'classify.v1': (request) => {
    const note = extractNote(request.user);
    const { primary, secondary } = inferTopics(note);
    const worthiness = inferContentWorthiness(note);
    return {
      kind: inferKind(note),
      primary_topic: primary,
      secondary_topics: secondary,
      entities: inferEntities(note),
      content_worthy: worthiness.worthy,
      content_worthiness_reason: worthiness.reason,
      confidence: worthiness.worthy ? 0.72 : 0.55,
    };
  },

  'atom.v1': (request) => {
    const noteText = extractNote(request.user);
    const title = extractField(request.user, 'Title') ?? sentences(noteText)[0] ?? noteText;
    const parts = sentences(noteText);
    const why = causalSentence(noteText);
    const mistake = mistakeSentence(noteText);
    const personal = firstPersonSentence(noteText);
    const sourceIds = extractSourceIds(request.user);

    // The mock extracts structure from the note; it never adds knowledge of its own, which is
    // exactly the constraint the real prompt places on a model.
    const coreInsight = parts[0] ?? noteText;
    const firstPrinciples = why ?? (parts.slice(1).join(' ') || coreInsight);

    return {
      problem: title.endsWith('?') ? title : `Why does this matter: ${title}?`,
      core_insight: coreInsight,
      first_principles: firstPrinciples,
      example: parts.length > 2 ? (parts[2] ?? null) : null,
      implementation_details: null,
      failure_mode: mistake,
      mental_model: null,
      personal_observation: personal,
      claims: [
        {
          claim: coreInsight.slice(0, 500),
          // Supported only when a source was actually supplied; otherwise it stays reviewable.
          status: sourceIds.length > 0 ? 'supported' : 'needs_review',
          source_ids: sourceIds.slice(0, 3),
        },
      ],
      angle_candidates: mistake ? ['failure_mode', 'insight'] : ['insight', 'mental_model'],
    };
  },
};

export interface MockLlmOptions {
  handlers?: Record<string, MockHandler>;
  model?: string;
}

export const createMockLlmAdapter = (options: MockLlmOptions = {}): LlmAdapter => {
  const handlers = { ...defaultMockHandlers, ...options.handlers };
  const model = options.model ?? 'mock-deterministic-v1';

  return {
    name: 'mock',
    model,
    async complete(request: LlmRequest): Promise<Result<LlmResponse>> {
      const handler = handlers[request.purpose];
      if (!handler) {
        return {
          ok: false,
          error: permanent('E_LLM_NO_MOCK', `no mock handler for purpose '${request.purpose}'`, {
            purpose: request.purpose,
            known: Object.keys(handlers),
          }),
        };
      }
      return {
        ok: true,
        value: {
          text: JSON.stringify(handler(request)),
          model,
          provider: 'mock',
          durationMs: 0,
        },
      };
    },
  };
};
