/* sw.js — offline app shell with stale-while-revalidate:
 * loads are served instantly from cache, while a background fetch quietly
 * refreshes the cache — so you're never more than one open() behind the
 * latest version, and it still works with no signal on the course. */

const CACHE = 'golf-buddy-v15';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/geo.js',
  './js/gps.js',
  './js/store.js',
  './js/course.js',
  './js/caddie.js',
  './js/analytics.js',
  './js/voice.js',
  './js/shotlistener.js',
  './js/map3d.js',
  './js/holeview.js',
  './js/hole3d.js',
  './js/vendor/three.module.js',
  './js/vendor/three.core.min.js',
  './icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only same-origin GETs; maps/overpass go straight to the network.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const cached = await c.match(e.request);
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok) c.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});
