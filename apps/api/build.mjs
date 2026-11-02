import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const apiRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Production API bundle + the offline administrator bootstrap/recovery CLI.
 * Native/runtime packages stay external and are installed by `npm ci`; the
 * TypeScript-only `@countup/shared` workspace is bundled in. `tsc` remains a
 * separate typecheck (noEmit) — this step only emits runnable JS.
 */
const targets = [
  ['src/server.ts', 'dist/server.mjs'],
  ['src/admin/admin-cli.ts', 'dist/admin-cli.mjs'],
];

for (const [entry, out] of targets) {
  await build({
    entryPoints: [path.join(apiRoot, entry)],
    outfile: path.join(apiRoot, out),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    logLevel: 'info',
    external: ['pg', 'express', 'zod', 'cookie', '@node-rs/argon2'],
  });
}
