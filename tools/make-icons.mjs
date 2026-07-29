/* Генератор иконок игры. Рисуем попиксельно и пишем PNG через zlib —
   никаких зависимостей, чтобы сборка не ломалась на чистой машине.
   Запуск: node tools/make-icons.mjs */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'icons'), { recursive: true });

/* ---------- PNG ---------- */
function crc32(buf) {
  let c, table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- рисование ---------- */
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const sat = v => v < 0 ? 0 : v > 255 ? 255 : v | 0;

function draw(S, maskable) {
  const px = Buffer.alloc(S * S * 4);
  const pad = maskable ? 0.20 : 0.06;      // maskable: важное держим в центре
  const R = S / 2;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const dx = (x - R) / R, dy = (y - R) / R;
      const d = Math.hypot(dx, dy);

      // фон: ночная вода сверху вниз
      let c = mix([9, 32, 48], [4, 16, 26], v);
      // лёгкое свечение из центра
      c = mix(c, [26, 86, 116], Math.max(0, 0.55 - d) * 0.9);

      const inside = maskable ? true : d < 1 - pad;
      if (!inside) { const i0 = (y * S + x) * 4; px[i0 + 3] = 0; continue; }

      const k = 1 - pad * 2;                          // рабочая зона
      const cx = (u - 0.5) / k, cy = (v - 0.5) / k;   // -0.5..0.5

      // ---- жёлоб горки: две дуги ----
      for (const [ox, oy, rr, w, col] of [
        [-0.02, 0.10, 0.34, 0.085, [58, 200, 255]],
        [-0.02, 0.10, 0.22, 0.062, [140, 232, 255]]
      ]) {
        const dd = Math.hypot(cx - ox, cy - oy);
        const ang = Math.atan2(cy - oy, cx - ox);
        if (ang < -0.15 && ang > -Math.PI + 0.15) {
          const e = 1 - Math.min(1, Math.abs(dd - rr) / w);
          if (e > 0) c = mix(c, col, Math.pow(e, 0.7) * 0.95);
        }
      }

      // ---- волна внизу ----
      const wave = 0.20 + Math.sin(cx * 9.5) * 0.028 + Math.sin(cx * 21 + 1.2) * 0.012;
      if (cy > wave) {
        const dep = Math.min(1, (cy - wave) * 3.2);
        c = mix(c, [16, 108, 122], 0.55 + dep * 0.3);
        // блик по кромке
        const edge = 1 - Math.min(1, (cy - wave) / 0.035);
        if (edge > 0) c = mix(c, [190, 245, 255], edge * 0.75);
        // рябь
        const rip = Math.sin(cx * 40 + cy * 30) * 0.5 + 0.5;
        c = mix(c, [70, 180, 200], rip * dep * 0.16);
      }

      // ---- капля-блик слева сверху ----
      const bd = Math.hypot(cx + 0.26, cy + 0.27);
      if (bd < 0.075) c = mix(c, [235, 252, 255], (1 - bd / 0.075) * 0.9);

      // виньетка
      c = mix(c, [3, 12, 20], Math.max(0, d - 0.62) * 1.1);

      const i = (y * S + x) * 4;
      px[i] = sat(c[0]); px[i + 1] = sat(c[1]); px[i + 2] = sat(c[2]);
      // мягкий край круга у обычной иконки
      px[i + 3] = maskable ? 255 : sat(255 * Math.min(1, (1 - pad - d) / 0.02 + 1));
    }
  }
  return png(S, S, px);
}

const out = [
  ['icons/icon-192.png', 192, false],
  ['icons/icon-512.png', 512, false],
  ['icons/icon-maskable-512.png', 512, true]
];
for (const [f, s, m] of out) {
  writeFileSync(join(ROOT, f), draw(s, m));
  console.log('ok', f, s + 'x' + s);
}
