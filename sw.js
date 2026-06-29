const CACHE_NAME = 'eb-notify-v1.4.4';
const PRECACHE_URLS = ['./index.html','./support.js','./manifest.json','./icons/icon-192.svg','./icons/icon-512.svg','./firebase-init.js','./firebase-sync.js','./notify.js'];
const CDN_PATTERNS = ['fonts.googleapis.com','fonts.gstatic.com','unpkg.com/react','unpkg.com/react-dom','cdnjs.cloudflare.com','gstatic.com/firebasejs'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.hostname.includes('firestore.googleapis.com') || url.hostname.includes('firebaseio.com') || url.hostname.includes('identitytoolkit.googleapis.com') || url.hostname.includes('securetoken.googleapis.com')) return;
  const isCDN = CDN_PATTERNS.some(p => url.href.includes(p));
  if (isCDN) { event.respondWith(cacheFirst(event.request)); return; }
  if (url.origin === location.origin && /\.(js|svg|css|png|jpg|woff2?)$/i.test(url.pathname)) { event.respondWith(cacheFirst(event.request)); return; }
  event.respondWith(networkFirst(event.request));
});
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try { const r = await fetch(request); if (r.ok) { const c = await caches.open(CACHE_NAME); c.put(request, r.clone()); } return r; } catch(e) { if (request.headers.get('accept')?.includes('text/html')) return offlineFallback(); throw e; }
}
async function networkFirst(request) {
  try { const r = await fetch(request); if (r.ok) { const c = await caches.open(CACHE_NAME); c.put(request, r.clone()); } return r; }
  catch { const cached = await caches.match(request); if (cached) return cached; if (request.headers.get('accept')?.includes('text/html')) { const i = await caches.match('./index.html'); if (i) return i; } return offlineFallback(); }
}
function offlineFallback() {
  return new Response(`<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>EB Notify - Offline</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#EDF2F7;color:#1A6FA3;text-align:center}</style></head><body><div><h1>EB Notify</h1><p>ไม่มีอินเทอร์เน็ต กรุณาเชื่อมต่อแล้วลองใหม่</p><button onclick="location.reload()">ลองใหม่</button></div></body></html>`,{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}});
}
