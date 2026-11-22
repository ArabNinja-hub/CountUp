import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig, loadEnv } from 'vite';
import { BASE_PATH } from './base-path.ts';
import { writeOfflineWorker } from './scripts/offline-shell.ts';
import { writeCloudflareHeadersFile } from './scripts/security-headers.ts';

/**
 * Emits Cloudflare Pages security headers (`dist/_headers`, pinning `connect-src`
 * to the exact `VITE_SUPABASE_URL` host when set), the GitHub Pages `404.html`
 * fallback (only when hosted under a subpath like `/CountUp/` so Cloudflare Pages
 * root builds keep native HTTP 200 SPA routing via `_redirects`), and the
 * content-addressed static offline worker (`dist/sw.js`).
 */
function spaFallback(supabaseUrl?: string): Plugin {
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
      await writeCloudflareHeadersFile(outDir, supabaseUrl);
      if (BASE_PATH !== '/') {
        await copyFile(path.join(outDir, 'index.html'), path.join(outDir, '404.html'));
      }
      await writeOfflineWorker(outDir, workerTemplate);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? env.VITE_SUPABASE_URL;

  return {
    base: BASE_PATH,
    plugins: [react(), tailwindcss(), spaFallback(supabaseUrl)],
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
