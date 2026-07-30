// Скачивание новой версии игры с сервера — то же самое, что делает
// android/.../Updater.java, только на Node вместо Java. Порядок такой же
// жёсткий, чтобы не оставить игрока с битым файлом:
//   1. читаем маленький version.json;
//   2. если номер сборки не больше нашего — выходим, трафик не тратим;
//   3. качаем index.html во временный файл;
//   4. проверяем: html целый, номер сборки внутри совпадает с обещанным;
//   5. только теперь переименовываем во что грузит приложение.
// Оборвалась сеть на любом шаге — временный файл выбрасывается, игра
// остаётся прежней.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const UPDATE_BASE = 'https://akvapark.45.67.216.36.sslip.io/';
const TIMEOUT_MS = 15000;
const MAX_HTML = 24 * 1024 * 1024;
const MIN_HTML = 50000;

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function buildInHtml(text) {
  const tail = text.slice(-65536);
  const m = /const AKVA_BUILD = (\d+);/.exec(tail);
  return m ? parseInt(m[1], 10) : -1;
}

class Updater {
  /** @param {string} liveDir каталог для скачанной копии (app.getPath('userData')/live) */
  constructor(liveDir) {
    this.liveDir = liveDir;
    this.busy = false;
  }

  installedBuild(bundledBuild) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.liveDir, 'version.json'), 'utf8'));
      const idx = path.join(this.liveDir, 'index.html');
      if (typeof v.build === 'number' && fs.existsSync(idx) && fs.statSync(idx).size > MIN_HTML) {
        return Math.max(bundledBuild, v.build);
      }
    } catch (_) { /* нет скачанной копии — это нормально */ }
    return bundledBuild;
  }

  /** Путь к странице, которую сейчас нужно грузить: свежая, если она новее заводской. */
  currentGamePath(bundledPath, bundledBuild) {
    const live = path.join(this.liveDir, 'index.html');
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.liveDir, 'version.json'), 'utf8'));
      if (typeof v.build === 'number' && v.build > bundledBuild &&
          fs.existsSync(live) && fs.statSync(live).size > MIN_HTML) {
        return live;
      }
    } catch (_) { /* используем заводскую копию */ }
    return bundledPath;
  }

  /** @returns {Promise<{version:string, build:number}|null>} */
  async check(haveBuild) {
    if (this.busy) return null;
    this.busy = true;
    try {
      return await this._run(haveBuild);
    } catch (_) {
      return null; // нет сети — просто играем дальше на том, что есть
    } finally {
      this.busy = false;
    }
  }

  async _run(haveBuild) {
    const metaRes = await fetchWithTimeout(UPDATE_BASE + 'version.json?ts=' + Date.now(), { cache: 'no-store' });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    if (typeof meta.build !== 'number' || meta.build <= haveBuild) return null;

    await fsp.mkdir(this.liveDir, { recursive: true });
    const tmp = path.join(this.liveDir, 'index.html.part');
    const dst = path.join(this.liveDir, 'index.html');

    const htmlRes = await fetchWithTimeout(UPDATE_BASE + 'index.html?ts=' + Date.now(), { cache: 'no-store' });
    if (!htmlRes.ok) return null;
    const buf = Buffer.from(await htmlRes.arrayBuffer());
    if (buf.length < MIN_HTML || buf.length > MAX_HTML) return null;

    const text = buf.toString('utf8');
    if (!text.includes('</html>') || buildInHtml(text) !== meta.build) {
      return null; // сервер отдал не то — молча остаёмся на старой версии
    }

    await fsp.writeFile(tmp, buf);
    await fsp.rm(dst, { force: true });
    await fsp.rename(tmp, dst);
    await fsp.writeFile(path.join(this.liveDir, 'version.json'), JSON.stringify(meta));

    return { version: meta.version || String(meta.build), build: meta.build };
  }
}

module.exports = { Updater, UPDATE_BASE };
