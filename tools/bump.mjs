/* Поднимает номер сборки в двух местах разом: version.json и AKVA_BUILD внутри
   index.html. Если их развести — игрок увидит вечное «есть обновление»,
   поэтому меняем только этим скриптом.

   node tools/bump.mjs                  -> build+1, версия 1.0.X
   node tools/bump.mjs 1.2.0 "заметка"  -> явная версия + заметка в баннере
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vPath = join(ROOT, 'version.json');
const iPath = join(ROOT, 'index.html');

const cur = JSON.parse(readFileSync(vPath, 'utf8'));
const build = (cur.build | 0) + 1;

let version = process.argv[2];
if (!version) {
  const p = String(cur.version || '1.0.0').split('.');
  p[2] = String((Number(p[2]) || 0) + 1);
  version = p.join('.');
}
const notes = process.argv[3] || cur.notes || '';

const next = {
  version,
  build,
  date: new Date().toISOString().slice(0, 10),
  channel: cur.channel || 'stable',
  notes
};
writeFileSync(vPath, JSON.stringify(next, null, 2) + '\n');

let html = readFileSync(iPath, 'utf8');
const before = html;
html = html.replace(/const AKVA_BUILD = \d+;/, `const AKVA_BUILD = ${build};`);
html = html.replace(/const AKVA_VERSION = '[^']*';/, `const AKVA_VERSION = '${version}';`);
if (html === before) {
  console.error('ОШИБКА: не нашёл AKVA_BUILD/AKVA_VERSION в index.html — версия не поднята');
  process.exit(1);
}
writeFileSync(iPath, html);

console.log(`версия ${version}, сборка ${build}${notes ? ' — ' + notes : ''}`);
