import { defineConfig } from 'tsup';

/** Apps are bundled so workspace packages resolve at runtime without path-alias loaders. */
export default defineConfig({
  entry: {
    'api/server': 'apps/api/src/server.ts',
    'workers/main': 'apps/workers/src/main.ts',
    'db/cli': 'packages/db/src/cli.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  skipNodeModulesBundle: true,
});
