// Offline support for the installed app.
//
// The app runs from its cached copy (so it works at school without Wi-Fi and
// a half-finished deploy can never break it mid-lesson). When a new version is
// published, it downloads in the background and waits; the app shows
// "Update ready" and switches only when you tap Update.
//
// VERSION must match APP_VERSION in src/version.js (a test checks this).
// Change it whenever you publish, so devices pick up the new files.

const VERSION = '1.2.5';
const CACHE = `inkwell-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'src/app.js',
  'src/autosave.js',
  'src/commands.js',
  'src/document-view.js',
  'src/geometry.js',
  'src/media.js',
  'src/model.js',
  'src/paper.js',
  'src/pdf.js',
  'src/render.js',
  'src/storage.js',
  'src/theme.js',
  'src/util.js',
  'src/version.js',
  'src/whiteboard.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
];

// Download every file of the new version up front; if any fails, the update
// is abandoned and the current version keeps running.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))));
});

// The app asks for the switch when you tap Update.
self.addEventListener('message', (event) => {
  if (event.data === 'apply-update') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('inkwell-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Cached copy first; anything not cached comes from the network.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE)
      .then((cache) => cache.match(request, { ignoreSearch: true }))
      .then((cached) => cached ?? fetch(request)),
  );
});
