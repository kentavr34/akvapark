/* ==========================================================================
   Service Worker «Заброшенный аквапарк»
   Задача: игра всегда свежая при интернете и всегда играбельна без него.

   Логика простая и без гонок:
     1. При запуске спрашиваем крошечный version.json (без кеша, с таймаутом).
     2. Если номер сборки не совпал с тем, что лежит в кеше — тянем новый
        index.html, кладём в кеш и отдаём его.
     3. Совпал или сети нет — мгновенно отдаём из кеша.
   Итог: обновление применяется само, ошибок «половина старая, половина новая»
   не бывает — игра это один файл, он меняется целиком.
   ========================================================================== */
'use strict';

const CACHE = 'akva-shell-v2';
const META_KEY = '/__akva_meta__';
const NET_TIMEOUT = 4000;

/* файлы, без которых игра не запустится офлайн */
const SHELL = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll падает целиком, если хоть один файл не отдался — кладём по одному
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await rememberBuild(await fetchBuild());
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  if (d.type === 'PURGE') {
    e.waitUntil(caches.delete(CACHE).then(() => self.clients.claim()));
  }
});

/* ---------- вспомогательное ---------- */

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
}

async function fetchBuild() {
  try {
    const r = await Promise.race([
      fetch('./version.json?ts=' + Date.now(), { cache: 'no-store' }),
      timeout(NET_TIMEOUT)
    ]);
    if (!r || !r.ok) return null;
    const j = await r.json();
    return typeof j.build === 'number' ? j.build : null;
  } catch (_) { return null; }
}

async function storedBuild() {
  const cache = await caches.open(CACHE);
  const r = await cache.match(META_KEY);
  if (!r) return null;
  try { return (await r.json()).build; } catch (_) { return null; }
}

async function rememberBuild(build) {
  if (build === null || build === undefined) return;
  const cache = await caches.open(CACHE);
  await cache.put(META_KEY, new Response(JSON.stringify({ build }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

/* Свежий index.html: скачиваем целиком, проверяем, что это действительно
   страница игры, и только потом подменяем кеш. Битый ответ не ломает игру. */
async function fetchFreshIndex() {
  const r = await Promise.race([
    fetch('./index.html?ts=' + Date.now(), { cache: 'no-store' }),
    timeout(NET_TIMEOUT * 6)
  ]);
  if (!r || !r.ok) throw new Error('bad status');
  const body = await r.clone().text();
  if (body.length < 50000 || body.indexOf('</html>') < 0) throw new Error('incomplete');
  const cache = await caches.open(CACHE);
  await cache.put('./index.html', new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  }));
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function cachedIndex() {
  const cache = await caches.open(CACHE);
  return (await cache.match('./index.html')) || (await cache.match('./'));
}

/* ---------- перехват ---------- */

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // version.json — всегда из сети, кеш только как запасной вариант
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith((async () => {
      try {
        const r = await Promise.race([fetch(req, { cache: 'no-store' }), timeout(NET_TIMEOUT)]);
        if (r && r.ok) {
          const cache = await caches.open(CACHE);
          cache.put('./version.json', r.clone()).catch(() => {});
          return r;
        }
        throw new Error('bad');
      } catch (_) {
        return (await caches.match('./version.json')) ||
               new Response('{"build":0,"offline":true}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // главная страница игры — только сам файл игры, не витрина на корне
  // (витрина '/' и 'landing.html' не версионируются через AKVA_BUILD,
  // им хватает обычного кеш-с-фоновым-обновлением ниже по файлу)
  const isDoc = url.pathname.endsWith('/index.html');
  if (isDoc) {
    e.respondWith((async () => {
      const have = await cachedIndex();
      const net = await fetchBuild();

      if (net === null) {                       // сети нет
        return have || fetch(req).catch(() => new Response('Нет сети', { status: 503 }));
      }
      const mine = await storedBuild();
      if (have && mine === net) return have;    // уже свежая

      try {
        const fresh = await fetchFreshIndex();  // качаем обновление
        await rememberBuild(net);
        return fresh;
      } catch (_) {
        return have || fetch(req).catch(() => new Response('Нет сети', { status: 503 }));
      }
    })());
    return;
  }

  // остальное (иконки, манифест) — из кеша, в фоне обновляем
  e.respondWith((async () => {
    const hit = await caches.match(req);
    const net = fetch(req).then((r) => {
      if (r && r.ok) caches.open(CACHE).then((c) => c.put(req, r.clone())).catch(() => {});
      return r;
    }).catch(() => null);
    return hit || (await net) || new Response('', { status: 504 });
  })());
});
