import type { Env } from '@sce/utils';
import type { LlmAdapter } from './types.js';
import { createMockLlmAdapter, type MockHandler } from './mock.js';
import { createOllamaAdapter } from './ollama.js';
import { createFailingLlmAdapter } from './failing.js';

export * from './types.js';
export * from './json.js';
export { createMockLlmAdapter, defaultMockHandlers, type MockHandler } from './mock.js';
export { createOllamaAdapter } from './ollama.js';
export { createFailingLlmAdapter } from './failing.js';
export * from './mock-knowledge.js';

/** Provider selection is configuration, never a code branch at the call site. */
export const createLlmAdapter = (
  env: Env,
  overrides: { mockHandlers?: Record<string, MockHandler>; fetchImpl?: typeof fetch } = {},
): LlmAdapter => {
  switch (env.LLM_PROVIDER) {
    case 'ollama':
      return createOllamaAdapter({
        baseUrl: env.OLLAMA_BASE_URL,
        model: env.OLLAMA_MODEL,
        timeoutMs: env.OLLAMA_TIMEOUT_MS,
        ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      });
    case 'failing':
      return createFailingLlmAdapter();
    case 'mock':
    default:
      return createMockLlmAdapter(
        overrides.mockHandlers ? { handlers: overrides.mockHandlers } : {},
      );
  }
};
