import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import { BASE_PATH } from './base-path.ts';
import { writeOfflineWorker } from './scripts/offline-shell.ts';

/**
 * GitHub Pages has no SPA rewrite: any path it cannot resolve falls back to
 * `404.html`. Emitting a copy of the app shell there means a deep link or a stale
 * bookmark still boots the app instead of dead-ending on GitHub's 404 page.
 */
function spaFallback(): Plugin {
  let outDir = '';
  let workerTemplate = '';
  return {
    name: 'countup:app-shell',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      workerTemplate = path.resolve(config.root, 'src/offline-worker.js');
    },
    async closeBundle() {
      await copyFile(path.join(outDir, 'index.html'), path.join(outDir, '404.html'));
      await writeOfflineWorker(outDir, workerTemplate);
    },
  };
}

export default defineConfig(() => {
  return {
    // GitHub Pages deployment - repository is at https://github.com/ArabNinja-hub/CountUp
    // Kept in sync with the Express server via base-path.ts (see notes there).
    base: BASE_PATH,
    plugins: [react(), tailwindcss(), spaFallback()],
    resolve: {
      alias: {
        '@': import.meta.dirname,
      },
    },
    server: {
      // Accept proxied preview hosts (e.g. *.e2b.app) so the live preview works.
      allowedHosts: true,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    build: {
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('firebase') || id.includes('@firebase')) return 'firebase';
            if (id.includes('react') || id.includes('scheduler')) return 'react-vendor';
            return 'vendor';
          },
        },
      },
    },
  };
});
