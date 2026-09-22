import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'Math.random() breaks determinism/idempotency. Use @sce/utils newId() or a seeded source.',
        },
      ],
    },
  },
  {
    files: [
      '**/*.test.ts',
      'tests/**/*.ts',
      'packages/db/src/cli.ts',
      'infra/**/*.ts',
      'apps/*/src/cli.ts',
      // The bot's CLI commands report to a human on stdout; everything else logs through pino.
      'apps/bot/src/main.ts',
      'apps/workers/src/main.ts',
    ],
    rules: { 'no-console': 'off' },
  },
);
