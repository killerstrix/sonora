// Service worker: la interfaz funciona sin conexión y la biblioteca se sirve desde caché si el servidor no responde.
const SHELL = 'sonora-shell-v7';
const DATA = 'sonora-data-v1';
const SHELL_FILES = ['./', 'index.html', 'styles.css', 'app.js', 'native.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => ![SHELL, DATA].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // El audio usa peticiones por rangos y las descargas son archivos grandes: pasan directo al servidor.
  if (url.pathname.endsWith('/audio') || url.pathname.endsWith('/download')
      || url.pathname === '/api/zip' || url.pathname.startsWith('/api/stream')) return;

  // Carátulas: caché primero.
  if (url.pathname.endsWith('/cover')) {
    e.respondWith(caches.open(DATA).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // API: red primero, caché como respaldo.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(DATA).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req).then(r => r || Response.error())));
    return;
  }

  // Interfaz: red primero (el servidor es local y responde al instante, así siempre se ve la última versión);
  // la copia en caché solo se usa si el servidor no responde.
  e.respondWith(fetch(req).then(res => {
    if (res.ok) caches.open(SHELL).then(c => c.put(req, res.clone()));
    return res;
  }).catch(() => caches.match(req).then(hit => hit || caches.match('index.html'))));
});
