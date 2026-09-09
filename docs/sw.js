/**
 * Open Yard Inventory service worker.
 *
 * BUMP `CACHE` ON EVERY CHANGE to index.html or lib/*.js. Forgetting this is the
 * number one cause of "why is my phone still showing the old version".
 */
const CACHE = 'oy-inventory-v4';

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './lib/deltas.js',
  './lib/idb.js',
  './lib/api.js',
  './lib/outbox.js',
  './lib/sync.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll rejects the whole install if ANY entry 404s, so add individually.
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never touch the API. Apps Script 302s to googleusercontent.com, and a
  // cached response there breaks every call in a way that looks like the
  // server is down. POSTs must never be intercepted at all.
  if (e.request.method !== 'GET') return;
  if (url.includes('script.google.com')) return;
  if (url.includes('googleusercontent.com')) return;
  if (url.includes('googleapis.com')) return;
  if (url.includes('accounts.google.com')) return;
  if (url.includes('/exec')) return;

  // Navigations: cache-first so the app opens with zero signal.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html')
        .then(hit => hit || fetch(e.request))
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Shell assets: stale-while-revalidate. Serves instantly from cache, then
  // refreshes in the background, so a deploy lands on the next open instead of
  // pinning the user on an old build until the worker version changes.
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res && res.ok) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
