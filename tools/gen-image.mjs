// Генерация изображений через DashScope (Alibaba, Wanx) — свободный аккаунт
// s.ragimoff, найден и проверен рабочий паттерн из истории проекта 994
// (994_archive/chat_history) — модель wanx2.1-t2i-turbo НЕ существует,
// рабочая — wan2.2-t2i-flash. Ключ лежит в tools/.dashscope-key.local
// (не в git, см. .gitignore) — никогда не хардкодить его прямо в этом файле.
//
// Использование:
//   node tools/gen-image.mjs "prompt на английском" out.png [ширина*высота]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const KEY = readFileSync(join(here, '.dashscope-key.local'), 'utf8').trim();
const SUBMIT = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis';

async function generate(prompt, outPath, size = '1024*1024', model = 'wan2.2-t2i-flash') {
  const body = JSON.stringify({
    model,
    input: {
      prompt,
      negative_prompt: 'text, letters, words, watermark, signature, low quality, blurry, deformed'
    },
    parameters: { size, n: 1 }
  });
  const submitRes = await fetch(SUBMIT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + KEY,
      'X-DashScope-Async': 'enable'
    },
    body
  });
  const submitJson = await submitRes.json();
  if (!submitRes.ok) throw new Error('submit failed: ' + JSON.stringify(submitJson));
  const taskId = submitJson.output.task_id;
  console.log('task:', taskId, submitJson.output.task_status);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollRes = await fetch('https://dashscope-intl.aliyuncs.com/api/v1/tasks/' + taskId, {
      headers: { Authorization: 'Bearer ' + KEY }
    });
    const pollJson = await pollRes.json();
    const status = pollJson.output.task_status;
    if (status === 'SUCCEEDED') {
      const url = pollJson.output.results[0].url;
      const imgRes = await fetch(url);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
      console.log('OK:', outPath, buf.length, 'bytes');
      return outPath;
    }
    if (status === 'FAILED') throw new Error('generation failed: ' + JSON.stringify(pollJson.output));
    console.log('...', status);
  }
  throw new Error('poll timeout');
}

const [, , prompt, outPath, size] = process.argv;
if (!prompt || !outPath) {
  console.error('Использование: node tools/gen-image.mjs "prompt" out.png [ширина*высота]');
  process.exit(1);
}
generate(prompt, outPath, size).catch((e) => { console.error(e.message); process.exit(1); });
