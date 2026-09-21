import { permanent, type Result } from '@sce/utils';
import type { LlmAdapter, LlmRequest, LlmResponse } from './types.js';
import {
  extractNote,
  inferContentWorthiness,
  inferEntities,
  inferKind,
  inferTopics,
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
