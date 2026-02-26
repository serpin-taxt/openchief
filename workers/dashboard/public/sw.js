const CACHE_NAME = "openchief-v1";
const SHELL_URLS = ["/"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Let API calls and auth go straight to network
  if (e.request.url.includes("/api/")) return;

  // Network-first with cache fallback for everything else
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
