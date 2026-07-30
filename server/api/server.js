// ==========================================================================
//  Синхронизация профиля игрока — маленький HTTP-сервис без зависимостей.
//  Живёт своим systemd-сервисом на 127.0.0.1, наружу торчит только через
//  nginx location /api/ (см. server/akvapark-common.conf).
//
//  Хранилище — обычные JSON-файлы, один на deviceId (эта игра не настолько
//  большая, чтобы тащить ради этого базу данных). deviceId — случайная
//  строка, которую генерирует сама игра при первом запуске (не логин,
//  не email — обычный анонимный идентификатор устройства).
//
//  Слияние при записи — «взять максимум» по каждому полю прогресса, чтобы
//  синхронизация НИКОГДА не откатывала игрока назад (см. merge() ниже
//  и комментарий про монеты — единственный осознанный компромисс).
// ==========================================================================
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.AKVA_API_PORT || 8091);
const DATA_DIR = process.env.AKVA_API_DATA || '/opt/akvapark/data/profiles';
const MAX_BODY = 32 * 1024;                 // с запасом: реальный профиль — единицы КБ
const ID_RE = /^[a-f0-9]{32,64}$/;          // только hex — заодно защита от path traversal

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- простой лимит частоты: по deviceId и по IP ---------- */
const lastWriteByDevice = new Map();        // deviceId -> ts последней записи
const WRITE_COOLDOWN_MS = 8000;

const ipWindow = new Map();                 // ip -> {count, windowStart}
const IP_WINDOW_MS = 60000;
const IP_MAX_REQ = 60;

function ipAllowed(ip) {
  const now = Date.now();
  let w = ipWindow.get(ip);
  if (!w || now - w.windowStart > IP_WINDOW_MS) { w = { count: 0, windowStart: now }; ipWindow.set(ip, w); }
  w.count++;
  return w.count <= IP_MAX_REQ;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of ipWindow) if (now - w.windowStart > IP_WINDOW_MS * 2) ipWindow.delete(ip);
  for (const [id, ts] of lastWriteByDevice) if (now - ts > WRITE_COOLDOWN_MS * 4) lastWriteByDevice.delete(id);
}, 5 * 60000).unref();

/* ---------- слияние профилей: максимум по каждому полю ---------- */
function freshProfile() { return { v: 1, done: {}, best: {}, bank: 0, owned: {}, equipped: {}, lore: {} }; }

function merge(a, b) {
  a = a && typeof a === 'object' ? a : freshProfile();
  b = b && typeof b === 'object' ? b : freshProfile();
  const out = freshProfile();

  out.done = { ...a.done, ...b.done };       // глава пройдена хоть где-то — считается пройденной
  out.lore = { ...a.lore, ...b.lore };       // жетон найден хоть где-то — считается найденным
  out.owned = { ...a.owned, ...b.owned };    // куплено хоть где-то — остаётся купленным навсегда

  out.best = {};
  for (const id of new Set([...Object.keys(a.best || {}), ...Object.keys(b.best || {})])) {
    const sa = (a.best[id] && a.best[id].stars) || 0;
    const sb = (b.best[id] && b.best[id].stars) || 0;
    out.best[id] = { stars: Math.max(sa, sb) };
  }

  // Монеты — максимум, не сумма и не «последний победил». Компромисс:
  // трата на одном устройстве может не «прилипнуть», если на другом
  // баланс был выше на момент синка — но баланс игрока НИКОГДА не
  // уменьшается синхронизацией. Для чисто косметической экономики без
  // реальных денег это безопаснее, чем шанс визуально «потерять» монеты.
  out.bank = Math.max(Number(a.bank) || 0, Number(b.bank) || 0);

  // Экипировка — не монотонный ресурс (это предпочтение, не прогресс).
  // Берём то, что прислал клиент (a — свежее из этого запроса), сервер
  // (b) только дозаполняет категории, которых у клиента вообще нет.
  out.equipped = { ...b.equipped, ...a.equipped };

  return out;
}

/* ---------- файловое хранилище ---------- */
function fileFor(id) { return path.join(DATA_DIR, id + '.json'); }

async function readProfile(id) {
  try { return JSON.parse(await fsp.readFile(fileFor(id), 'utf8')); }
  catch (_) { return null; }
}

async function writeProfile(id, data) {
  const tmp = fileFor(id) + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, fileFor(id));
}

/* ---------- HTTP ---------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  // Android WebView (appassets.androidplatform.net) и Electron (file://) —
  // другое происхождение, им нужен CORS, чтобы fetch() вообще сработал.
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {           // CORS preflight (Android/Electron — другое происхождение)
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const ip = req.socket.remoteAddress || 'unknown';
  if (!ipAllowed(ip)) { send(res, 429, { error: 'слишком много запросов' }); return; }

  const m = /^\/api\/profile\/([^/]+)$/.exec(req.url.split('?')[0]);
  if (!m) { send(res, 404, { error: 'not found' }); return; }
  const id = m[1];
  if (!ID_RE.test(id)) { send(res, 400, { error: 'плохой deviceId' }); return; }

  if (req.method === 'GET') {
    const stored = await readProfile(id);
    send(res, 200, stored || freshProfile());
    return;
  }

  if (req.method === 'POST') {
    const last = lastWriteByDevice.get(id) || 0;
    if (Date.now() - last < WRITE_COOLDOWN_MS) { send(res, 429, { error: 'слишком часто, подожди' }); return; }

    let body;
    try { body = await readBody(req); } catch (_) { send(res, 413, { error: 'тело запроса слишком большое' }); return; }
    let incoming;
    try { incoming = JSON.parse(body); } catch (_) { send(res, 400, { error: 'битый json' }); return; }

    lastWriteByDevice.set(id, Date.now());
    const stored = await readProfile(id);
    const merged = merge(incoming, stored);
    await writeProfile(id, merged);
    send(res, 200, merged);
    return;
  }

  send(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`akvapark-api: слушаю 127.0.0.1:${PORT}, данные в ${DATA_DIR}`);
});
