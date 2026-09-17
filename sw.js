// Service worker: keep the background-removal model and runtime in the browser cache so they're
// downloaded once, not on every visit (their CDN sends no caching headers).
const CACHE = 'cutout-model-v1';
const CACHED_HOSTS = ['staticimgly.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !CACHED_HOSTS.includes(url.hostname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok) cache.put(e.request, res.clone());
    return res;
  })());
});
