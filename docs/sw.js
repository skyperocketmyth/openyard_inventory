/**
 * Open Yard Inventory service worker.
 *
 * BUMP `CACHE` ON EVERY CHANGE to index.html or lib/*.js. Forgetting this is the
 * number one cause of "why is my phone still showing the old version".
 */
const CACHE = 'oy-inventory-v6';

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

  // Navigations: NETWORK-FIRST with a short timeout, falling back to cache.
  //
  // This was cache-first, which pinned an install to whatever index.html it had
  // already stored — a broken build stayed broken on the device even after the
  // fix was live on the server, and the only escape was a manual hard refresh.
  // Yard staff will not do that. Network-first means a deploy always lands;
  // the timeout plus cache fallback means it still opens with no signal at all.
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      const cached = await caches.match('./index.html');
      try {
        const fresh = await Promise.race([
          fetch(e.request),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('slow network')), 3500))
        ]);
        if (fresh && fresh.ok) {
          const c = await caches.open(CACHE);
          c.put('./index.html', fresh.clone());
          return fresh;
        }
        return cached || fresh;
      } catch {
        // Offline, or the network was too slow to wait for. Use what we have.
        return cached || fetch(e.request);
      }
    })());
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
