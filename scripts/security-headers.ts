import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolves the exact HTTPS + WSS origins for `connect-src` from `VITE_SUPABASE_URL`
 * when set at build time (e.g. `https://abcdefghijklm.supabase.co` ->
 * `https://abcdefghijklm.supabase.co wss://abcdefghijklm.supabase.co`).
 * Falls back to `https://*.supabase.co wss://*.supabase.co` only when
 * `VITE_SUPABASE_URL` is unset (e.g. offline/CI artifact builds).
 */
export function resolveSupabaseCspSources(rawSupabaseUrl?: string): string {
  const trimmed = (rawSupabaseUrl ?? '').trim();
  if (trimmed) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${parsed.protocol}//${parsed.host} ${wsProto}//${parsed.host}`;
      }
    } catch {
      // Fall back to strict *.supabase.co below if malformed
    }
  }
  return 'https://*.supabase.co wss://*.supabase.co';
}

export function buildContentSecurityPolicy(rawSupabaseUrl?: string): string {
  const supabaseSources = resolveSupabaseCspSources(rawSupabaseUrl);
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self' ${supabaseSources} https://challenges.cloudflare.com`,
    'frame-src https://challenges.cloudflare.com',
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function buildCloudflareHeadersFile(rawSupabaseUrl?: string): string {
  const csp = buildContentSecurityPolicy(rawSupabaseUrl);
  return [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  X-Frame-Options: DENY',
    '  Permissions-Policy: accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()',
    '',
    '/sw.js',
    '  Cache-Control: no-cache, no-store, must-revalidate',
    '',
    '/index.html',
    '  Cache-Control: no-cache',
    '',
    '/manifest.webmanifest',
    '  Cache-Control: no-cache',
    '  Content-Type: application/manifest+json; charset=utf-8',
    '',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
}

export async function writeCloudflareHeadersFile(
  outDir: string,
  rawSupabaseUrl?: string
): Promise<void> {
  const contents = buildCloudflareHeadersFile(rawSupabaseUrl);
  await writeFile(path.join(outDir, '_headers'), contents, 'utf8');
}
