import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { writeOfflineWorker } from '../../scripts/offline-shell';

const templatePath = path.resolve('src/offline-worker.js');
let fixture = '';
let outDir = '';

beforeEach(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), 'countup-shell-'));
  outDir = path.join(fixture, 'dist');
  await mkdir(path.join(outDir, 'assets'), { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), '<html>offline shell</html>');
  await writeFile(path.join(outDir, '404.html'), '<html>fallback</html>');
  await writeFile(path.join(outDir, '.nojekyll'), '');
  await writeFile(path.join(outDir, 'assets', 'app.js'), 'console.log("release one")');
});
afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

type WorkerEvent = {
  request?: { url: string; method: string; mode: string };
  waitUntil?: (promise: Promise<unknown>) => void;
  respondWith?: (promise: Promise<Response>) => void;
};

async function startWorker(scope: string, failure?: 'network' | 'corrupt' | 'mime') {
  await writeOfflineWorker(outDir, templatePath);
  const code = await readFile(path.join(outDir, 'sw.js'), 'utf8');
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const stores = new Map<string, Map<string, Response>>();
  let online = true;
  const fetchNetwork = vi.fn(async (request: Request | { url: string }) => {
    const isScript = request.url.endsWith('/assets/app.js');
    if (!online || (failure === 'network' && isScript)) {
      throw new TypeError('Network unavailable');
    }
    if (isScript) {
      return new Response(failure === 'corrupt' ? 'stale release' : 'console.log("release one")', {
        headers: { 'content-type': failure === 'mime' ? 'text/html' : 'application/javascript' },
      });
    }
    if (request.url.endsWith('/index.html')) {
      return new Response('<html>offline shell</html>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(`network: ${request.url}`);
  });
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        put: async (request: Request, response: Response) => {
          store.set(request.url, response.clone());
        },
        match: async (request: string | { url: string }, options?: { ignoreSearch?: boolean }) => {
          const key = typeof request === 'string' ? request : request.url;
          const url = new URL(key);
          if (options?.ignoreSearch) url.search = '';
          return store.get(url.href)?.clone();
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const claim = vi.fn().mockResolvedValue(undefined);
  vm.runInNewContext(code, {
    self: {
      registration: { scope },
      clients: { claim },
      addEventListener: (type: string, handler: (event: WorkerEvent) => void) =>
        handlers.set(type, handler),
    },
    URL,
    Request,
    Response,
    Uint8Array,
    crypto: webcrypto,
    caches,
    fetch: fetchNetwork,
  });
  const lifecycle = async (type: string) => {
    let promise: Promise<unknown> | undefined;
    handlers.get(type)!({ waitUntil: (value) => (promise = value) });
    await promise;
  };
  const request = (url: string, mode = 'cors', method = 'GET') => {
    let response: Promise<Response> | undefined;
    handlers.get('fetch')!({
      request: { url, mode, method },
      respondWith: (value) => (response = value),
    });
    return response;
  };
  return {
    code,
    stores,
    claim,
    lifecycle,
    request,
    setOnline: (value: boolean) => (online = value),
  };
}

describe('production offline app shell', () => {
  it('versions actual built content and excludes generated fallbacks and the worker', async () => {
    await writeOfflineWorker(outDir, templatePath);
    const first = await readFile(path.join(outDir, 'sw.js'), 'utf8');
    expect(first).toContain('"assets/app.js"');
    expect(first).toContain('"index.html"');
    expect(first).not.toContain('"404.html"');
    expect(first).not.toContain('".nojekyll"');
    expect(first).not.toContain('"sw.js"');
    expect(first).not.toContain('__COUNTUP_');
    expect(first).not.toMatch(/skipWaiting\s*\(/);
    await writeOfflineWorker(outDir, templatePath);
    expect(await readFile(path.join(outDir, 'sw.js'), 'utf8')).toBe(first);
    await writeFile(path.join(outDir, 'assets', 'app.js'), 'console.log("release two")');
    await writeOfflineWorker(outDir, templatePath);
    const second = await readFile(path.join(outDir, 'sw.js'), 'utf8');
    expect(second.match(/CACHE_VERSION = '([^']+)'/)?.[1]).not.toBe(
      first.match(/CACHE_VERSION = '([^']+)'/)?.[1]
    );
  });

  it.each(['https://example.test/CountUp/', 'https://example.test/'])(
    'loads only the installed shell and assets offline under %s',
    async (scope) => {
      const worker = await startWorker(scope);
      await worker.lifecycle('install');
      await worker.lifecycle('activate');
      expect(worker.claim).toHaveBeenCalledOnce();
      worker.setOnline(false);
      const nav = await worker.request(`${scope}some/page`, 'navigate');
      expect(await nav?.text()).toBe('<html>offline shell</html>');
      const asset = await worker.request(`${scope}assets/app.js?v=1`);
      expect(await asset?.text()).toBe('console.log("release one")');
      expect(worker.request(`${scope}api/shop`)).toBeUndefined();
      expect(worker.request(`${scope}assets/app.js`, 'cors', 'POST')).toBeUndefined();
      expect(
        worker.request('https://firestore.googleapis.com/v1/projects/example')
      ).toBeUndefined();
      worker.setOnline(true);
      const fresh = await worker.request(`${scope}some/page`, 'navigate');
      expect(await fresh?.text()).toBe(`network: ${scope}some/page`);
    }
  );

  it('removes only old CountUp caches in its own scope on activation', async () => {
    const worker = await startWorker('https://example.test/CountUp/');
    worker.stores.set('countup-static-v1:/CountUp/:old', new Map());
    worker.stores.set('countup-static-v1:/Other/:old', new Map());
    worker.stores.set('another-app', new Map());
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    expect(worker.stores.has('countup-static-v1:/CountUp/:old')).toBe(false);
    expect(worker.stores.has('countup-static-v1:/Other/:old')).toBe(true);
    expect(worker.stores.has('another-app')).toBe(true);
  });

  it('does not replace an existing cache if installation fails', async () => {
    const worker = await startWorker('https://example.test/CountUp/', 'network');
    worker.stores.set('countup-static-v1:/CountUp/:old', new Map());
    await expect(worker.lifecycle('install')).rejects.toThrow(/Network unavailable/);
    expect([...worker.stores.keys()]).toEqual(['countup-static-v1:/CountUp/:old']);
  });

  it.each(['corrupt', 'mime'] as const)(
    'rejects a %s static asset without deleting the old release',
    async (failure) => {
      const worker = await startWorker('https://example.test/CountUp/', failure);
      worker.stores.set('countup-static-v1:/CountUp/:old', new Map());
      await expect(worker.lifecycle('install')).rejects.toThrow(/Offline asset/);
      expect([...worker.stores.keys()]).toEqual(['countup-static-v1:/CountUp/:old']);
    }
  );
});
