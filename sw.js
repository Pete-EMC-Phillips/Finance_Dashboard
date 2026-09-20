// Phillips Finance — offline service worker.
//
// Strategy: "network-first, falling back to cache". Every time a page or file loads
// successfully over the network, we save a fresh copy in the cache. If the network
// request fails (no signal, airplane mode, etc.), we serve whatever copy we last
// cached instead of showing an error. That means:
//   - Online: you always see the latest version you uploaded to GitHub.
//   - Offline: you see the last version that successfully loaded, instead of nothing.
//
// Bump CACHE_VERSION any time you want to force every visitor's old cache to be
// thrown away (not usually necessary with network-first, but harmless to do whenever
// you make a big change).
const CACHE_VERSION = 'phillips-finance-v2';

// Everything needed to open every tracker with no network at all, including the
// Chart.js library each tracker loads from a CDN (without this, the charts would
// break offline even though the page itself loaded).
const PRECACHE_URLS = [
  './',
  './index.html',
  './isa_tracker.html',
  './pension_tracker.html',
  './mortgage_tracker.html',
  './budget_tracker.html',
  './creditcard_tracker.html',
  './savings_tracker.html',
  './whatif_planner.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js'
];

// Fires once, the first time the browser discovers sw.js. Downloads and caches
// every file in PRECACHE_URLS up front, so offline works even before you've
// personally visited every tracker at least once.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {}) // if one CDN fetch fails during install, don't block the rest
  );
  self.skipWaiting(); // activate this version immediately, don't wait for old tabs to close
});

// Fires when this version takes over. Deletes any older-named caches left behind
// from a previous CACHE_VERSION, so you're not accumulating stale copies forever.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim(); // start controlling already-open tabs, not just new ones
});

// Fires for every request the page makes (HTML, the Chart.js script, icons, etc.).
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return; // don't try to cache POSTs etc.

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // got a live response — save a copy for next time we're offline, then return it
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)) // offline — fall back to the cached copy
  );
});
