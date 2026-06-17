// Service Worker for Emergency Box Notify - KPN Hospital
const CACHE_NAME = 'eb-notify-v1.0.1';

const PRECACHE_URLS = [
  './index.html',
  './support.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './firebase-init.js',
  './firebase-sync.js',
];

const CDN_PATTERNS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'unpkg.com/react',
  'unpkg.com/react-dom',
  'cdnjs.cloudflare.com',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('identitytoolkit.googleapis.com')) return;
  const isCDN = CDN_PATTERNS.some(p => url.href.includes(p));
  if (isCDN) { event.respondWith(cacheFirst(event.request)); return; }
  if (url.origin === location.origin && /\.(js|svg|css|png|jpg|woff2?)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(event.request)); return;
  }
  event.respondWith(networkFirst(event.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) { const cache = await caches.open(CACHE_NAME); cache.put(request, response.clone()); }
    return response;
  } catch { return offlineFallback(); }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) { const cache = await caches.open(CACHE_NAME); cache.put(request, response.clone()); }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.headers.get('accept')?.includes('text/html')) {
      const idx = await caches.match('./index.html');
      if (idx) return idx;
    }
    return offlineFallback();
  }
}

function offlineFallback() {
  return new Response(
    `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ออฟไลน์ - EB Notify</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#EDF2F7;color:#1A6FA3;text-align:center}.c{max-width:400px;padding:2rem}h1{font-size:1.5rem}p{color:#666}</style></head><body><div class="c"><h1>📦 EB Notify</h1><p>ไม่สามารถเชื่อมต่ออินเทอร์เน็ตได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง</p><button onclick="location.reload()" style="margin-top:1rem;padding:.5rem 1.5rem;border:2px solid #1A6FA3;border-radius:8px;background:white;color:#1A6FA3;cursor:pointer;font-size:1rem">ลองใหม่</button></div></body></html>`,
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
