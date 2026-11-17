const SCOPE_PATH = new URL(self.registration.scope).pathname;
const CACHE_PREFIX = `canvasroom-shell:${SCOPE_PATH}:`;
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const SHELL = [SCOPE_PATH];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)),
  )));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin ||
      !url.pathname.startsWith(SCOPE_PATH) || event.request.headers.has("authorization")) return;
  const navigation = event.request.mode === "navigate";
  const asset = /\.(?:js|css|woff2?|png|jpe?g|svg|webp|ico)$/.test(url.pathname);
  if (!navigation && !asset) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok && !/private|no-store/i.test(response.headers.get("cache-control") || "") &&
        (asset || url.pathname === SCOPE_PATH)) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
        await cache.put(event.request, copy);
        const keys = await cache.keys();
        const expendable = keys.filter((key) => new URL(key.url).pathname !== SCOPE_PATH);
        await Promise.all(expendable.slice(0, Math.max(0, keys.length - 96)).map((key) => cache.delete(key)));
      }).catch(() => {}));
    }
    return response;
  }).catch(async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(event.request) || (navigation ? await cache.match(SCOPE_PATH) : undefined) || Response.error();
  }));
});
