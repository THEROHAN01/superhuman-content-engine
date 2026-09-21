import type { Env } from '@sce/utils';
import { transient } from '@sce/utils';
import type { ResearchAdapter } from './types.js';
import { createMockResearchAdapter } from './mock.js';
import { createSearxngAdapter } from './searxng.js';

export * from './types.js';
export * from './source-type.js';
export { createMockResearchAdapter } from './mock.js';
export { createSearxngAdapter } from './searxng.js';

/** Research turned off entirely: succeeds with no results, which is not the same as failing. */
export const createDisabledResearchAdapter = (): ResearchAdapter => ({
  name: 'disabled',
  synthetic: false,
  async search() {
    return { ok: true, value: [] };
  },
});

export const createFailingResearchAdapter = (): ResearchAdapter => ({
  name: 'failing',
  synthetic: false,
  async search() {
    return {
      ok: false,
      error: transient('E_RESEARCH_UNREACHABLE', 'research provider is configured to fail'),
    };
  },
});

export const createResearchAdapter = (
  env: Env,
  overrides: { fetchImpl?: typeof fetch } = {},
): ResearchAdapter => {
  switch (env.RESEARCH_PROVIDER) {
    case 'searxng':
      return createSearxngAdapter({
        baseUrl: env.SEARXNG_BASE_URL!,
        timeoutMs: env.RESEARCH_TIMEOUT_MS,
        ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      });
    case 'disabled':
      return createDisabledResearchAdapter();
    case 'failing':
      return createFailingResearchAdapter();
    case 'mock':
    default:
      return createMockResearchAdapter();
  }
};
