// Service Worker dla Tarczy czasu pracy
// WAŻNE: przy każdej nowej wersji aplikacji zmień nazwę cache - stare wersje automatycznie się usuną.
// vGPT_6.1.11: based on a previously developed v:1.28 version created by another AI.
const CACHE_NAME = 'tarcza-vGPT-6.1.11';

const FILES_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './Photos/sakwa.png',
  './Photos/oko_otwarte_v2.png',
  './Photos/blink_normal_v2.gif',
  './Photos/blink_fast_v2.gif',
  './Photos/blink_double_v2.gif',
  './Photos/blink_slow_v2.gif'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
  // Domyślnie czekamy aż stary SW zostanie zwolniony - ALE klient może wysłać SKIP_WAITING
  // żeby od razu przejąć kontrolę (zaraz po wykryciu nowego SW).
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Klient prosi o natychmiastową aktywację nowej wersji
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Nie cache'ujemy requestów do Google Apps Script - zawsze na żywo
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('script.googleusercontent.com')) {
    return;
  }

  // Network-first dla nawigacji i kluczowych plików - zapewnia, że nowa wersja
  // dochodzi szybko, bez konieczności czekania na wygaśnięcie cache.
  const isNavigate = event.request.mode === 'navigate';
  const isHTML = url.pathname.endsWith('/') || url.pathname.endsWith('.html');
  const isSW = url.pathname.endsWith('sw.js');
  const isManifest = url.pathname.endsWith('manifest.json');

  if (isNavigate || isHTML || isSW || isManifest) {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Dla reszty (obrazki, ikony itp.) - cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
