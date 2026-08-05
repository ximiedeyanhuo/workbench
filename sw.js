/**
 * sw.js — 个人工作台 Service Worker
 *
 * 缓存策略：
 * - 静态资源（CSS/JS/lib/图标）：stale-while-revalidate（先回缓存保速度，后台拉新版更新缓存，下次刷新即最新，不依赖手动升版本号）
 * - API 请求（/api/*）：网络优先，保证数据最新
 * - 离线时：展示缓存的页面，API 部分降级提示
 */

const CACHE = "workbench-v55";
const STATIC = [
  "/",
  "/index.html",
  "/css/app.css",
  "/js/app.js",
  "/js/db.js",
  "/js/tasks.js",
  "/js/notes.js",
  "/js/life.js",
  "/js/finance.js",
  "/js/stocks.js",
  "/js/gongkao.js",
  "/js/news.js",
  "/js/links.js",
  "/js/drive.js",
  "/lib/md.js",
  "/lib/chart.umd.min.js",
  "/lib/xlsx.mini.min.js",
  "/manifest.json",
  "/HELP.md",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // API 请求：网络优先，失败时尝试缓存（离线降级）
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // 静态资源：stale-while-revalidate —— 立即回缓存，后台拉新版写回缓存；
  // 避免纯缓存优先导致改了代码忘升版本号时用户永远拿旧 JS
  if (STATIC.includes(url.pathname)) {
    e.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(e.request).then((hit) => {
          const refresh = fetch(e.request)
            .then((res) => {
              if (res.ok) cache.put(e.request, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || refresh;
        })
      )
    );
    return;
  }

  // 其余（主要 index.html）：网络优先，离线时用缓存
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/")))
  );
});