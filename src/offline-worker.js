/* The build replaces these placeholders with a content version and static files. */
const CACHE_VERSION = '__COUNTUP_VERSION__';
const PRECACHE_FILES = '__COUNTUP_PRECACHE__';

const scope = new URL(self.registration.scope);
const cachePrefix = `countup-static-v1:${scope.pathname}:`;
const cacheName = `${cachePrefix}${CACHE_VERSION}`;
const assets = PRECACHE_FILES.map((file) => ({
  ...file,
  url: new URL(file.path.split('/').map(encodeURIComponent).join('/'), scope).href,
}));
const assetPaths = new Set(assets.map((file) => new URL(file.url).pathname));
const shellUrl = new URL('index.html', scope).href;

// Cache only the built app shell, never Firestore, authentication, or shop data.
// The new worker waits for existing tabs to close before replacing their assets.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      try {
        // A partial or stale deployment must not replace a working offline
        // release. Verify the bytes and MIME type before storing any files.
        const responses = await Promise.all(
          assets.map(async (file) => {
            const request = new Request(file.url, { cache: 'reload' });
            const response = await fetch(request);
            const type = response.headers.get('content-type') || '';
            if (
              !response.ok ||
              (/\.m?js$/i.test(file.path) && !/(javascript|ecmascript)/i.test(type)) ||
              (/\.css$/i.test(file.path) && !/text\/css/i.test(type)) ||
              (/\.html$/i.test(file.path) && !/text\/html/i.test(type))
            ) {
              throw new Error(`Offline asset unavailable or incorrectly served: ${file.path}`);
            }
            const bytes = await response.clone().arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            const sha256 = Array.from(new Uint8Array(digest), (value) =>
              value.toString(16).padStart(2, '0')
            ).join('');
            if (sha256 !== file.sha256) throw new Error(`Offline asset changed: ${file.path}`);
            return { request, response };
          })
        );
        await Promise.all(responses.map(({ request, response }) => cache.put(request, response)));
      } catch (error) {
        await caches.delete(cacheName);
        throw error;
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== scope.origin ||
    !url.pathname.startsWith(scope.pathname)
  )
    return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.status < 500) return response;
        } catch {
          // A navigation can use the previously installed shell when offline.
        }
        return (await caches.open(cacheName))
          .match(shellUrl)
          .then((response) => response || Response.error());
      })()
    );
  } else if (assetPaths.has(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(cacheName);
        return (await cache.match(request, { ignoreSearch: true })) || fetch(request);
      })()
    );
  }
});
