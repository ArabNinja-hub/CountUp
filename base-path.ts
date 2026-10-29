/**
 * Single source of truth for the subpath the app is served from.
 *
 * GitHub Pages hosts a project site at https://<owner>.github.io/<repo>/, so every
 * asset URL has to be prefixed with `/<repo>/`. Vite bakes this into the built HTML
 * (`base` below) and the Express server in server.ts mounts `dist/` at the same
 * path, so `npm run dev`, `npm start`, and Pages all agree.
 *
 * Hardcoding this in only one side is what breaks a deploy: with `base` set but the
 * server mounting at `/`, every asset request falls through to the SPA catch-all and
 * returns index.html, which the browser rejects ("Expected a JavaScript module script
 * but the server responded with a MIME type of text/html").
 *
 * Override with VITE_BASE_PATH when hosting elsewhere, e.g. a custom domain at the
 * root ('/'), which is also the value to use if the repo is ever renamed.
 */
export const BASE_PATH = process.env.VITE_BASE_PATH ?? '/CountUp/';
