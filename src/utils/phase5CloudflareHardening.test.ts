import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  buildCloudflareHeadersFile,
  buildContentSecurityPolicy,
  resolveSupabaseCspSources,
} from '../../scripts/security-headers';
import { writeOfflineWorker } from '../../scripts/offline-shell';
import { redactSensitiveErrorText } from '../services/errorReporting';

function parseCspDirectives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    map.set(tokens[0], tokens.slice(1));
  }
  return map;
}

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  expect(buf.readUInt32BE(0)).toBe(0x89504e47);
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

describe('Phase 5: Cloudflare Pages Headers, Strict CSP, Service Worker & PWA Manifest', () => {
  it('generates strict Content-Security-Policy & security headers allowing Sign-in, Turnstile, Realtime, Google Fonts & SW while blocking untrusted origins', async () => {
    const publicHeaders = await readFile(path.resolve('public/_headers'), 'utf8');
    expect(publicHeaders).toBe(buildCloudflareHeadersFile());

    // Exact Supabase project host pinning at build time
    expect(resolveSupabaseCspSources('https://abcdefghijklm.supabase.co')).toBe(
      'https://abcdefghijklm.supabase.co wss://abcdefghijklm.supabase.co'
    );

    const csp = buildContentSecurityPolicy('https://abcdefghijklm.supabase.co');
    const directives = parseCspDirectives(csp);

    // Core framing / injection protections
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'self'"]);
    expect(directives.get('form-action')).toEqual(["'self'"]);

    // Sign-in & Turnstile scripts/frames: NO unsafe-inline or unsafe-eval in script-src!
    const scriptSrc = directives.get('script-src') ?? [];
    expect(scriptSrc).toEqual(["'self'", 'https://challenges.cloudflare.com']);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(directives.get('frame-src')).toEqual(['https://challenges.cloudflare.com']);

    // Supabase Auth/REST/Edge Functions (HTTPS), Realtime (WSS), and Turnstile connect-src
    expect(directives.get('connect-src')).toEqual([
      "'self'",
      'https://abcdefghijklm.supabase.co',
      'wss://abcdefghijklm.supabase.co',
      'https://challenges.cloudflare.com',
    ]);
    expect(csp).not.toContain('firebase');
    expect(csp).not.toContain('googleapis.com/v1');

    // Service Worker ('self') + Supabase Realtime WebSocket heartbeat worker ('blob:')
    expect(directives.get('worker-src')).toEqual(["'self'", 'blob:']);

    // Google Fonts + inline chart/progress styles + Admin MFA QR SVG data: URI
    expect(directives.get('style-src')).toEqual([
      "'self'",
      "'unsafe-inline'",
      'https://fonts.googleapis.com',
    ]);
    expect(directives.get('font-src')).toEqual(["'self'", 'https://fonts.gstatic.com']);
    expect(directives.get('img-src')).toEqual(["'self'", 'data:']);
    expect(directives.get('manifest-src')).toEqual(["'self'"]);

    // Security & cache headers in _headers and SPA fallback in _redirects
    expect(publicHeaders).toContain('X-Content-Type-Options: nosniff');
    expect(publicHeaders).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    expect(publicHeaders).toContain('X-Frame-Options: DENY');
    expect(publicHeaders).toContain('Permissions-Policy: ');
    expect(publicHeaders).toMatch(/\/sw\.js\s+Cache-Control: no-cache, no-store, must-revalidate/);

    const redirects = await readFile(path.resolve('public/_redirects'), 'utf8');
    expect(redirects).toContain('/* /index.html 200');
  });

  it('excludes _headers/_redirects from precache, never intercepts Auth/API/Edge Functions, and rolls out updates cleanly', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'countup-p5-sw-'));
    try {
      const outDir = path.join(tmp, 'dist');
      await mkdir(path.join(outDir, 'assets'), { recursive: true });
      await writeFile(path.join(outDir, 'index.html'), '<html>v1</html>');
      await writeFile(path.join(outDir, 'assets', 'app.js'), 'console.log("v1")');
      await writeFile(path.join(outDir, '_headers'), buildCloudflareHeadersFile());
      await writeFile(path.join(outDir, '_redirects'), '/* /index.html 200\n');

      const templatePath = path.resolve('src/offline-worker.js');
      await writeOfflineWorker(outDir, templatePath);
      const swV1 = await readFile(path.join(outDir, 'sw.js'), 'utf8');

      // Cloudflare unserved config files MUST be excluded so SW install never 404s
      expect(swV1).not.toContain('"_headers"');
      expect(swV1).not.toContain('"_redirects"');
      expect(swV1).not.toMatch(/skipWaiting\s*\(/);

      type WorkerEvent = {
        request?: {
          url: string;
          method: string;
          mode: string;
          headers?: { get: (k: string) => string | null };
        };
        waitUntil?: (p: Promise<unknown>) => void;
        respondWith?: (p: Promise<Response>) => void;
      };

      const stores = new Map<string, Map<string, Response>>();
      const caches = {
        open: async (name: string) => {
          if (!stores.has(name)) stores.set(name, new Map());
          const store = stores.get(name)!;
          return {
            put: async (req: Request, res: Response) => {
              store.set(req.url, res.clone());
            },
            match: async (req: string | { url: string }, opts?: { ignoreSearch?: boolean }) => {
              const key = typeof req === 'string' ? req : req.url;
              const u = new URL(key);
              if (opts?.ignoreSearch) u.search = '';
              return store.get(u.href)?.clone();
            },
          };
        },
        keys: async () => [...stores.keys()],
        delete: async (name: string) => stores.delete(name),
      };

      const mountWorker = (code: string, appJsBody: string) => {
        const handlers = new Map<string, (ev: WorkerEvent) => void>();
        const fetchMock = vi.fn(async (req: Request | { url: string }) => {
          if (req.url.endsWith('/assets/app.js')) {
            return new Response(appJsBody, {
              headers: { 'content-type': 'application/javascript' },
            });
          }
          if (req.url.endsWith('/index.html')) {
            return new Response(appJsBody.includes('v2') ? '<html>v2</html>' : '<html>v1</html>', {
              headers: { 'content-type': 'text/html' },
            });
          }
          return new Response('api-payload', {
            headers: { 'content-type': 'application/json' },
          });
        });

        vm.runInNewContext(code, {
          self: {
            registration: { scope: 'https://countup.zm/' },
            clients: { claim: vi.fn().mockResolvedValue(undefined) },
            addEventListener: (t: string, h: (ev: WorkerEvent) => void) => handlers.set(t, h),
          },
          URL,
          Request,
          Response,
          Uint8Array,
          crypto: webcrypto,
          caches,
          fetch: fetchMock,
        });

        return {
          lifecycle: async (type: string) => {
            let p: Promise<unknown> | undefined;
            handlers.get(type)!({ waitUntil: (val) => (p = val) });
            await p;
          },
          dispatchFetch: (
            url: string,
            opts?: { method?: string; mode?: string; headers?: Record<string, string> }
          ) => {
            let intercepted: Promise<Response> | undefined;
            const lowerHeaders = Object.fromEntries(
              Object.entries(opts?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
            );
            handlers.get('fetch')!({
              request: {
                url,
                method: opts?.method ?? 'GET',
                mode: opts?.mode ?? 'cors',
                headers: { get: (name: string) => lowerHeaders[name.toLowerCase()] ?? null },
              },
              respondWith: (val) => (intercepted = val),
            });
            return intercepted;
          },
        };
      };

      const w1 = mountWorker(swV1, 'console.log("v1")');
      await w1.lifecycle('install');
      await w1.lifecycle('activate');
      expect(stores.size).toBe(1);
      const v1CacheName = [...stores.keys()][0];

      // Must NEVER intercept cross-origin Supabase Auth, REST, or Edge Function calls
      expect(
        w1.dispatchFetch('https://abcdefghijklm.supabase.co/auth/v1/otp', { method: 'POST' })
      ).toBeUndefined();
      expect(
        w1.dispatchFetch('https://abcdefghijklm.supabase.co/rest/v1/sales?select=*')
      ).toBeUndefined();
      expect(
        w1.dispatchFetch('https://abcdefghijklm.supabase.co/functions/v1/unlock-shop-session', {
          method: 'POST',
        })
      ).toBeUndefined();

      // Must NEVER intercept same-origin proxied Auth, REST, Edge Function, Realtime, or Cloudflare /cdn-cgi/ paths
      expect(w1.dispatchFetch('https://countup.zm/auth/v1/user')).toBeUndefined();
      expect(w1.dispatchFetch('https://countup.zm/rest/v1/shops')).toBeUndefined();
      expect(
        w1.dispatchFetch('https://countup.zm/functions/v1/get-payment-instructions', {
          mode: 'navigate',
        })
      ).toBeUndefined();
      expect(w1.dispatchFetch('https://countup.zm/realtime/v1/websocket')).toBeUndefined();
      expect(w1.dispatchFetch('https://countup.zm/cdn-cgi/challenge-platform/h/b')).toBeUndefined();

      // Must NEVER intercept any GET carrying Authorization or apikey headers
      expect(
        w1.dispatchFetch('https://countup.zm/custom-endpoint', {
          headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' },
        })
      ).toBeUndefined();
      expect(
        w1.dispatchFetch('https://countup.zm/custom-endpoint', {
          headers: { apikey: 'sb_publishable_key' },
        })
      ).toBeUndefined();

      // Clean rollout to V2: stages V2 alongside V1 during install, then deletes V1 on activate
      await writeFile(path.join(outDir, 'index.html'), '<html>v2</html>');
      await writeFile(path.join(outDir, 'assets', 'app.js'), 'console.log("v2")');
      await writeOfflineWorker(outDir, templatePath);
      const swV2 = await readFile(path.join(outDir, 'sw.js'), 'utf8');

      const w2 = mountWorker(swV2, 'console.log("v2")');
      await w2.lifecycle('install');
      expect(stores.size).toBe(2); // V1 still intact while existing tab finishes its sale
      await w2.lifecycle('activate');
      expect(stores.has(v1CacheName)).toBe(false);
      expect(stores.size).toBe(1);
      const servedV2 = await (await w2.dispatchFetch('https://countup.zm/assets/app.js')!).text();
      expect(servedV2).toBe('console.log("v2")');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('meets Android Chrome Web App Manifest & PNG icon installability requirements (192, 512, maskable)', async () => {
    const manifestRaw = await readFile(path.resolve('public/manifest.webmanifest'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      name: string;
      short_name: string;
      start_url: string;
      scope: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
    };

    expect(manifest.name).toContain('CountUp');
    expect(manifest.short_name).toBe('CountUp');
    expect(manifest.start_url).toBe('.');
    expect(manifest.scope).toBe('.');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#064e3b');
    expect(manifest.background_color).toBe('#f1f5f9');

    const expectedIcons = [
      { src: 'brand/icon-192.png', sizes: '192x192', purpose: 'any', w: 192, h: 192 },
      { src: 'brand/icon-512.png', sizes: '512x512', purpose: 'any', w: 512, h: 512 },
      {
        src: 'brand/icon-maskable-192.png',
        sizes: '192x192',
        purpose: 'maskable',
        w: 192,
        h: 192,
      },
      {
        src: 'brand/icon-maskable-512.png',
        sizes: '512x512',
        purpose: 'maskable',
        w: 512,
        h: 512,
      },
    ];

    for (const expected of expectedIcons) {
      const entry = manifest.icons.find(
        (ic) => ic.src === expected.src && ic.purpose === expected.purpose
      );
      expect(entry, `manifest icon ${expected.src} (${expected.purpose}) must exist`).toBeTruthy();
      expect(entry?.sizes).toBe(expected.sizes);
      expect(entry?.type).toBe('image/png');

      const pngBytes = await readFile(path.resolve('public', expected.src));
      const dims = readPngDimensions(pngBytes);
      expect(dims).toEqual({ width: expected.w, height: expected.h });
    }

    const indexHtml = await readFile(path.resolve('index.html'), 'utf8');
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(indexHtml).toContain('href="/brand/icon-192.png"');
  });

  it('redacts JWTs, recovery codes, PINs, and OTPs before sending client error telemetry', () => {
    const raw =
      'Auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.sig_abc123 with recovery CU-ABCD-EFGH-JKLM and pin="4829" otp: 918273';
    const clean = redactSensitiveErrorText(raw);
    expect(clean).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(clean).not.toContain('CU-ABCD-EFGH-JKLM');
    expect(clean).not.toContain('4829');
    expect(clean).not.toContain('918273');
    expect(clean).toContain('[REDACTED_TOKEN]');
    expect(clean).toContain('CU-[REDACTED]');
  });
});
