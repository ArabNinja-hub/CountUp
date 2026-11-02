import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Live PostgreSQL suite. Requires TEST_DATABASE_URL (an admin URL for an isolated,
 * disposable PostgreSQL server). It NEVER falls back to PGlite: if the variable is
 * missing, createLiveDatabase() throws and the suite fails loudly.
 */
export default defineConfig({
  root,
  test: {
    environment: 'node',
    include: ['test/live/**/*.test.ts', 'test/auth/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    server: {
      deps: { inline: ['@countup/shared'] },
    },
  },
});
