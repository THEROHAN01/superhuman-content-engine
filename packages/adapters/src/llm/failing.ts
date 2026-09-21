import { permanent, transient } from '@sce/utils';
import type { LlmAdapter } from './types.js';

/**
 * Always fails. Selected with `LLM_PROVIDER=failing` to exercise error paths in tests and in
 * failure drills, so "what happens when the model is down" is answered by evidence.
 */
export const createFailingLlmAdapter = (
  kind: 'transient' | 'permanent' = 'transient',
): LlmAdapter => ({
  name: 'failing',
  model: 'failing',
  async complete(request) {
    const failure =
      kind === 'transient'
        ? transient('E_LLM_UNREACHABLE', 'llm provider is configured to fail', {
            purpose: request.purpose,
          })
        : permanent('E_LLM_REFUSED', 'llm provider is configured to fail permanently', {
            purpose: request.purpose,
          });
    return { ok: false, error: failure };
  },
});
