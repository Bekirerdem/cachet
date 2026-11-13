// Caches the app's own files so it opens without a connection. It never touches anything
// else: requests to the model, the attestation services and the chain record always go to
// the network and are never stored.
const CACHE = 'shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
const isShell = (url) => url.origin === self.location.origin && (url.pathname === '/' || url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !isShell(url)) return; // not ours to answer

  if (url.pathname === '/') {
    // The page itself: newest when online, the saved copy when not.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  // Built files carry a hash in their name, so a saved copy never goes stale.
  event.respondWith(
    caches.match(request).then(
      (saved) =>
        saved ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
