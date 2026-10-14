// Service Worker for Lattiao Travel Journal PWA v98
const CACHE_NAME = 'lattiao-travel-v144.17';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon.png'
];

// Install: cache app shell
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .catch(function(err) {
        console.warn('SW cache failed:', err);
      })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) {
          return key !== CACHE_NAME;
        }).map(function(key) {
          return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: stale-while-revalidate (v144.14)
// 改造前：导航走 network-first —— 每次打开都要等 GitHub Pages 网络往返（实测首访 4.9s），
// 断网或跨境抖动时先白屏几秒才回落缓存。
// 现在：先秒回缓存（离线也能开），同时后台静默拉新版本写回缓存，下次打开即为新版 ——
// 「打开快」和「拿到最新」不再互相打架。
function staleWhileRevalidate(request, aliasKey) {
  return caches.open(CACHE_NAME).then(function(cache) {
    return cache.match(request).then(function(cached) {
      var network = fetch(request).then(function(response) {
        if (response && response.ok) {
          cache.put(request, response.clone()).catch(function(){});
          // 导航请求与 './index.html' 两个 key 都写，命中哪个都能秒开
          if (aliasKey) cache.put(aliasKey, response.clone()).catch(function(){});
        }
        return response;
      }).catch(function() { return null; });
      if (cached) { network.catch(function(){}); return cached; }
      return network;
    });
  });
}

// Fetch: stale-while-revalidate（缓存优先 + 后台更新）
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(
      staleWhileRevalidate(event.request, './index.html').then(function(res) {
        return res || caches.match('./index.html');
      })
    );
    return;
  }
  event.respondWith(staleWhileRevalidate(event.request));
});
