#!/usr/bin/env node
// 压缩过大的照片：默认只处理 >256KB 的 jpg，最长边 1920、质量 80
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'uploads');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const num = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const THRESHOLD = num('--min-kb', 256) * 1024;
const MAX_DIM = num('--max', 1920);
const QUALITY = num('--q', 80);

async function main() {
  const files = fs.readdirSync(DIR)
    .filter(f => /\.(jpe?g)$/i.test(f))
    .map(f => ({ f, size: fs.statSync(path.join(DIR, f)).size }))
    .filter(x => x.size > THRESHOLD)
    .sort((a, b) => b.size - a.size);

  let done = 0, skipped = 0, before = 0, after = 0, failed = 0;
  for (const { f, size } of files) {
    const p = path.join(DIR, f);
    before += size;
    try {
      const buf = await sharp(p).rotate()
        .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: QUALITY, mozjpeg: true })
        .toBuffer();
      if (buf.length >= size) { skipped++; after += size; continue; }
      if (!dry) {
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, p);
      }
      after += buf.length;
      done++;
      if (done % 20 === 0) console.log(`已处理 ${done}/${files.length}…`);
    } catch (e) {
      failed++;
      after += size;
      console.error('失败:', f, e.message);
    }
  }
  console.log(`扫描 ${files.length} 张（>${THRESHOLD / 1024}KB）`);
  console.log(`${dry ? '预计' : '实际'}压缩 ${done} 张，跳过 ${skipped} 张（压缩后更大），失败 ${failed} 张`);
  console.log(`体积：${(before / 1024 / 1024).toFixed(1)}MB → ${(after / 1024 / 1024).toFixed(1)}MB（省 ${((before - after) / 1024 / 1024).toFixed(1)}MB）`);
}

main().catch(e => { console.error(e); process.exit(1); });
