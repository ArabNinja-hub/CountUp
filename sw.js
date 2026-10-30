/* The build replaces these placeholders with a content version and static files. */
const CACHE_VERSION = '6e3bb6b500baae6e2b27';
const PRECACHE_FILES = [{"path":"assets/firebase-BRgC_wdB.js","sha256":"40f7c60213ccb8effdc3e78edccdb180c784e01ba6cfc7f015e63ecccb42fa7f"},{"path":"assets/index-BFabDyAc.css","sha256":"f6b73f080b371b1ff98a013c4da65cce51616f03be05626d3d16d5f893871972"},{"path":"assets/index-xU9dAh2W.js","sha256":"8d84e9efcbb3f73c566085e27fe35c7c98e8035d412fcf81e9ce54e925f0be39"},{"path":"assets/react-vendor-DmmXQRo7.js","sha256":"520b0cf06f79ea8a29626c6c05286e558364de26a914025dfc07071dbc0ddb27"},{"path":"assets/rolldown-runtime-WkwZ5CU-.js","sha256":"2629f2ad3cb75a57d98de697127f5af7d777ef572bbcdfa6e3ce8f438cd4527e"},{"path":"assets/vendor-C2v1zAcu.js","sha256":"d7f67567b7330be80097b44450f9ee69cd98a9f538fdd65c16e0d03e82aa939d"},{"path":"brand/icon.png","sha256":"dc7cca4dfac380edf39ff629b3a10578efdec0b697a167a59d5b1fd504acda27"},{"path":"brand/logo.png","sha256":"7e2813c5f03dea0d4fefa19833017e5d6cf9e325f41ed371e9630c4aa129f6bd"},{"path":"index.html","sha256":"bb73c778f00f73fff97929c69d0fd92f02af444bf746d8f533adc5495bcc9320"}];

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
