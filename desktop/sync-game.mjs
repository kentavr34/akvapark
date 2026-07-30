// Копирует текущую игру из корня репозитория в resources/game — то же
// самое, что build-apk.sh делает для Android (assets/game/index.html):
// заводская копия, зашитая в установщик, всегда актуальна на момент сборки.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'index.html');
const dstDir = join(here, 'resources', 'game');
const dst = join(dstDir, 'index.html');

mkdirSync(dstDir, { recursive: true });
copyFileSync(src, dst);
console.log('sync-game: скопировано', src, '->', dst);
