import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sce/utils': r('./packages/utils/src/index.ts'),
      '@sce/schemas': r('./packages/schemas/src/index.ts'),
      '@sce/db': r('./packages/db/src/index.ts'),
      '@sce/prompts': r('./packages/prompts/src/index.ts'),
      '@sce/adapters': r('./packages/adapters/src/index.ts'),
      '@sce/core': r('./packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    sequence: { concurrent: false },
  },
});
