/**
 * Single source of truth for the subpath the app is served from.
 *
 * - Cloudflare Workers (`VITE_BASE_PATH=/`, set by `npm run build:cloudflare`)
 *   serves the site from the domain root `'/'` (e.g.
 *   `https://countup.<subdomain>.workers.dev/` or a custom domain). Legacy
 *   `CF_PAGES=1` builds are still recognized.
 * - GitHub Pages hosts project sites at `https://<owner>.github.io/<repo>/`, so
 *   when neither `VITE_BASE_PATH` nor `CF_PAGES=1` is set, the default remains
 *   `'/CountUp/'`.
 *
 * Always normalized with leading and trailing slashes (`'/'` or `'/subpath/'`).
 */
function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/') return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

export const BASE_PATH = normalizeBasePath(
  process.env.VITE_BASE_PATH ?? (process.env.CF_PAGES === '1' ? '/' : '/CountUp/')
);
