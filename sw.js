// Service Worker for Lattiao Travel Journal PWA v98
const CACHE_NAME = 'lattiao-travel-v144.27';
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

/* ---- v144.23: 个性化（App 名称 + 主屏幕图标）----
   浏览器在「添加到主屏幕」时会读 manifest.json 的 name/icons。静态 manifest 改不了，
   所以这里拦截 manifest.json，按用户设置动态生成一份（名字换成自定义、图标指向所选主题）；
   用户上传的自定义图存在 IndexedDB，由 /__app_icon_*.png 这几个虚拟路径供给。
   设置本身由页面写在 localStorage['lattiao_appearance']（明文 JSON，SW 读得到；
   App 主数据是 LZ 压缩的，SW 解不开，所以必须另存这份）。 */
var APPEAR_KEY = 'lattiao_appearance';
var APPEAR_MEM = null;   // 页面 postMessage 推来的设置（SW 内无 localStorage）
var THEME_ICONS = {
  mint: './app-icon-512-mint.png', sea: './app-icon-512-sea.png',
  peach: './app-icon-512-peach.png', cream: './app-icon-512-cream.png',
  star: './app-icon-512-star.png', polaroid: './app-icon-512-polaroid.png',
  matcha: './app-icon-512-matcha.png', sunset: './app-icon-512-sunset.png'
};
function readAppearance() {
  // ⚠️ Service Worker 里**没有 localStorage**（self.localStorage 是 undefined，访问即抛）。
  // 所以个性化设置必须存 IndexedDB 才能被 SW 读到 —— 页面同时用 postMessage 推一份做加速。
  if (APPEAR_MEM) return Promise.resolve(APPEAR_MEM);
  return openIconDb().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction('icons', 'readonly');
      var rq = tx.objectStore('icons').get('appearance');
      rq.onsuccess = function () {
        var v = rq.result; db.close();
        try { resolve(v ? JSON.parse(v) : {}); } catch (e) { resolve({}); }
      };
      rq.onerror = function () { db.close(); resolve({}); };
    });
  }).catch(function () { return {}; });
}
// 页面改设置后 postMessage 推过来，省一次 IndexedDB 读
self.addEventListener('message', function (e) {
  var d = e && e.data;
  if (d && d.type === 'appearance' && d.payload) APPEAR_MEM = d.payload;

  // v144.26: 用户点「发现新版本 → 点击刷新」时，页面不知道本 SW 的 CACHE_NAME
  //（那是 sw.js 里的常量），所以由 SW 自己把线上最新版 index.html 拉下来写进缓存，
  // 页面随后 reload 就能**一次**拿到新版，而不是「先旧、再刷新、再新」。
  // 离线时 fetch 会失败，页面照常 reload，至少还有旧缓存兜底。
  if (d && d.type === 'CACHE_NEW_INDEX') {
    event_and_ack(e, CACHE_NAME);
  }
});

function event_and_ack(e, cacheName) {
  var src = e && e.source;
  var reply = function (ok) { if (src && src.postMessage) src.postMessage({ type: 'CACHE_NEW_INDEX_DONE', ok: !!ok }); };
  var p = fetch('./index.html?u=' + Date.now(), { cache: 'no-store' })
    .then(function (r) {
      if (!r || !r.ok) throw new Error('bad status ' + (r && r.status));
      return caches.open(cacheName).then(function (c) { return c.put('./index.html', r.clone()).then(function () { return c.put('./', r); }); });
    })
    .then(function () { reply(true); })
    .catch(function () { reply(false); });
  if (e && e.waitUntil) e.waitUntil(p);
  return p;
}
function openIconDb() {
  return new Promise(function(resolve, reject) {
    if (!self.indexedDB) return reject(new Error('no idb'));
    var rq = indexedDB.open('lattiao_icon', 1);
    rq.onupgradeneeded = function () { rq.result.createObjectStore('icons'); };
    rq.onsuccess = function () { resolve(rq.result); };
    rq.onerror = function () { reject(rq.error || new Error('idb')); };
  });
}
function readCustomIcon() {
  return openIconDb().then(function (db) {
    return new Promise(function(resolve) {
      var tx = db.transaction('icons', 'readonly');
      var rq = tx.objectStore('icons').get('appIcon');
      rq.onsuccess = function () {
        var v = rq.result; db.close();
        // 兼容降级格式：Blob 存失败时页面会存 dataURL 字符串，这里换回 Blob
        if (v && typeof v === 'string' && v.indexOf('data:') === 0) {
          return fetch(v).then(function (r) { return r.blob(); }).catch(function () { return null; });
        }
        resolve(v || null);
      };
      rq.onerror = function () { db.close(); resolve(null); };
    });
  }).catch(function () { return null; });
}
function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function buildManifest(appear) {
  var name = (appear && appear.name) || '薄荷旅行手账';
  var custom = !!(appear && appear.custom);
  var theme = (appear && appear.theme) || 'mint';
  var icon512 = custom ? './__app_icon_512.png' : (THEME_ICONS[theme] || THEME_ICONS.mint);
  var icon192 = custom ? './__app_icon_192.png' : icon512.replace('512', '192');
  var icon180 = custom ? './__app_icon_180.png' : icon512.replace('512', '180');
  return {
    name: name,
    short_name: name.length > 6 ? name.slice(0, 6) : name,
    description: '记录每一段旅程 - 目的地、攻略、照片、记账',
    start_url: './',
    display: 'standalone',
    background_color: '#F5F3FF',
    theme_color: '#7C3AED',
    orientation: 'portrait-primary',
    icons: [
      { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ],
    shortcuts: [
      { name: '⏳ 最近出行', short_name: '出行倒计时', description: '查看最近的一次旅行',
        url: './?shortcut=countdown', icons: [{ src: icon192, sizes: '192x192' }] },
      { name: '📷 行程相册', short_name: '相册', description: '浏览所有旅行照片',
        url: './?shortcut=album', icons: [{ src: icon192, sizes: '192x192' }] },
      { name: '🧳 新建行程', short_name: '新建', description: '快速开始规划旅行',
        url: './?shortcut=newtrip', icons: [{ src: icon192, sizes: '192x192' }] }
    ]
  };
}

// Fetch: stale-while-revalidate（缓存优先 + 后台更新）
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return;
  }

  // --- 个性化：manifest 动态生成 ---
  var pathname = new URL(event.request.url).pathname;
  if (pathname && /\/manifest\.json$/.test(pathname)) {
    event.respondWith(
      readAppearance().then(function(appear) {
        return jsonResponse(buildManifest(appear));
      }).catch(function () {
        return fetch(event.request);
      })
    );
    return;
  }

  // --- 个性化：自定义图标（IndexedDB → Response）---
  var mIcon = pathname && /\/__app_icon_(180|192|512)\.png$/.exec(pathname);
  if (mIcon) {
    var size = mIcon[1];
    event.respondWith(
      readCustomIcon().then(function(blob) {
        if (blob) return new Response(blob, { status: 200, headers: { 'Content-Type': blob.type || 'image/png', 'Cache-Control': 'no-store' } });
        // 没上传过自定义图 → 回落到所选内置主题；再不行用默认薄荷紫
        return readAppearance().then(function(appear) {
          var theme = (appear && appear.theme) || 'mint';
          return fetch(THEME_ICONS[theme] || THEME_ICONS.mint);
        });
      }).catch(function () { return fetch(event.request); })
    );
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
