const CACHE_NAME = "openchief-v3";

// Minimal offline fallback for navigation requests.
// Chrome requires the SW to respond with 200 to start_url when offline
// for PWA installability.
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenChief — Offline</title>
  <style>
    body { background: #0a0a0a; color: #e5e5e5; font-family: Inter, system-ui, sans-serif;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .box { text-align: center; max-width: 400px; padding: 2rem; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #a3a3a3; font-size: 0.875rem; }
    button { margin-top: 1rem; padding: 0.5rem 1.5rem; border-radius: 0.375rem;
             background: #c2841a; color: #0a0a0a; border: none; font-weight: 600;
             cursor: pointer; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="box">
    <h1>You're offline</h1>
    <p>OpenChief requires an internet connection. Please check your connection and try again.</p>
    <button onclick="window.location.reload()">Retry</button>
  </div>
</body>
</html>`;

self.addEventListener("install", (e) => {
  // Skip waiting to activate immediately — cache is populated dynamically
  // via the fetch handler on first navigation (avoids CF Access blocking
  // cache.addAll during install).
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
  const url = new URL(e.request.url);

  // Only handle navigation requests (HTML pages).
  // Let everything else (API calls, manifest.json, icons, JS, CSS) go
  // straight to the network without SW interference. This is critical:
  // if the SW intercepts manifest.json and returns 503 on failure,
  // Chrome can't parse the manifest and PWA install breaks.
  if (e.request.mode !== "navigate") return;

  // Network-first for navigations, with cache + offline fallback
  e.respondWith(
    fetch(e.request)
      .then((response) => {
        // Cache successful navigations for offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(e.request).then((cached) => {
          if (cached) return cached;
          // Always return a valid 200 HTML response for navigations.
          // This satisfies Chrome's PWA installability offline check.
          return new Response(OFFLINE_HTML, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }),
      ),
  );
});
