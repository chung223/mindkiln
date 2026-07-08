/* 女媧工坊 Service Worker —— 只快取靜態外殼,讓應用可離線開啟。
   API 與 SSE(/api/*)一律走網路、絕不快取,避免登入狀態與即時串流出錯。 */

const CACHE = 'nuwa-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 只接管同源的 GET;其餘(POST、跨源、API、SSE)交給瀏覽器直接處理
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 靜態資源:網路優先,成功就順手更新快取;失敗(離線)才回退快取。
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        // 導航請求離線時回退到外殼首頁
        if (e.request.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      }),
  );
});
