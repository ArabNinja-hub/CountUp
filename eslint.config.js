import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ESLint setup for a React + TypeScript app (flat config, ESLint 9).
 *
 * Rules are the recommended sets from each plugin — nothing exotic — plus
 * `eslint-config-prettier` last so formatting is Prettier's job only.
 */
export default tseslint.config(
  {
    // Build output and generated files are not source.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'server.js'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Components are exported alongside helpers in the same file in a few places.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Underscore-prefixed names are intentionally unused (e.g. destructuring placeholders).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Test files run in Node and may use loose typing for fixtures.
    files: ['**/*.test.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['*.config.{js,ts}', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier
);
