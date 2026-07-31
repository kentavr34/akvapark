// Генерация настоящих 3D-моделей через Tripo3D (openapi.tripo3d.ai) —
// text-to-3D, отдаёт .glb с текстурами, грузится через уже встроенный
// в игру GLTFLoader (см. index.html, раздел 7e MASTERPLAN).
// Ключ — tools/.tripo-key.local (не в git, см. .gitignore).
//
// Использование:
//   node tools/gen-3d.mjs "prompt на английском" out.glb
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const KEY = readFileSync(join(here, '.tripo-key.local'), 'utf8').trim();
const BASE = 'https://openapi.tripo3d.ai/v3';

async function generate(prompt, outPath) {
  const submitRes = await fetch(BASE + '/generation/text-to-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ prompt, model: 'v3.1-20260211' })
  });
  const submitJson = await submitRes.json();
  if (!submitRes.ok) throw new Error('submit failed: ' + JSON.stringify(submitJson));
  const taskId = submitJson.data.task_id;
  console.log('task:', taskId);

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollRes = await fetch(BASE + '/tasks/' + taskId, {
      headers: { Authorization: 'Bearer ' + KEY }
    });
    const pollJson = await pollRes.json();
    const d = pollJson.data;
    if (!d) { console.log('...', JSON.stringify(pollJson).slice(0, 200)); continue; }
    if (d.status === 'success') {
      const url = d.output.model_url || d.output.pbr_model || d.output.base_model;
      const modelRes = await fetch(url);
      const buf = Buffer.from(await modelRes.arrayBuffer());
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
      console.log('OK:', outPath, buf.length, 'bytes');
      return outPath;
    }
    if (d.status === 'failed') throw new Error('generation failed: ' + JSON.stringify(d));
    console.log('...', d.status, d.progress ?? '');
  }
  throw new Error('poll timeout');
}

const [, , prompt, outPath] = process.argv;
if (!prompt || !outPath) {
  console.error('Использование: node tools/gen-3d.mjs "prompt" out.glb');
  process.exit(1);
}
generate(prompt, outPath).catch((e) => { console.error(e.message); process.exit(1); });
