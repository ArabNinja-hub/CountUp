import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    maxWorkers: 1,
    server: {
      // @countup/shared ships TypeScript source; Vite must transform it rather than
      // letting Node try to require a .ts file out of node_modules.
      deps: { inline: ['@countup/shared'] },
    },
  },
});
