#!/usr/bin/env node
// 导入 yiwaigong.zip：按目录分类、统一命名、随机分配家属留言
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const ZIP = process.argv[2] || path.join(ROOT, 'yiwaigong.zip');
const TMP = '/tmp/yiwaigong-import';
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
const DB_PATH = path.join(ROOT, 'data', 'db.sqlite');
const FFMPEG = fs.existsSync(path.join(ROOT, 'tools', 'ffmpeg')) ? path.join(ROOT, 'tools', 'ffmpeg') : 'ffmpeg';

const { FAMILY, MESSAGES, normalizeCategory, categoryCode } = require('../lib/family');

const CATEGORIES = {
  '早期': '早期',
  '平时': '平时',
  '酒席': '酒席',
  '旅行': '旅行',
  '旅游': '旅行',
  '生病': '生病',
  '合影': '合影',
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(arr, seed, offset = 0) {
  return arr[(seed + offset * 7919) % arr.length];
}

async function main() {
  if (!fs.existsSync(ZIP)) {
    console.error('找不到 zip:', ZIP);
    process.exit(1);
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log('解压中:', ZIP);
  execFileSync('unzip', ['-q', '-o', ZIP, '-d', TMP], { stdio: 'inherit' });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  try { db.exec("ALTER TABLE media ADD COLUMN category TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE media ADD COLUMN sort_order INTEGER DEFAULT 0"); } catch {}

  const exists = db.prepare('SELECT id FROM media WHERE origname = ? AND category = ?');
  const insert = db.prepare(`INSERT INTO media
    (filename, origname, kind, uploader, caption, year, featured, category, sort_order, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  let added = 0, skipped = 0, failed = 0;
  const dirs = fs.readdirSync(TMP).filter(d => {
    try { return fs.statSync(path.join(TMP, d)).isDirectory(); } catch { return false; }
  }).sort();

  for (const dir of dirs) {
    if (dir.startsWith('.') || dir === '__MACOSX') continue;
    const catLabel = CATEGORIES[dir] || dir;
    const cat = { code: categoryCode(catLabel), label: catLabel };
    const files = fs.readdirSync(path.join(TMP, dir))
      .filter(f => /\.(jpe?g|png|webp|gif|mp4|mov|m4v|webm)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));

    let seq = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM media WHERE category=?').get(cat.label).m + 1;
    for (const file of files) {
      const src = path.join(TMP, dir, file);
      const isVideo = /\.(mp4|mov|m4v|webm)$/i.test(file);
      const ext = isVideo ? '.mp4' : path.extname(file).toLowerCase();
      if (exists.get(file, cat.label)) { skipped++; seq++; continue; }

      const seed = hash(cat.code + '|' + file);
      const uploader = pick(FAMILY, seed, 1);
      const caption = pick(MESSAGES[cat.label] || ['音容宛在，思念长存'], seed, 0);
      seq++;
      let num = String(seq).padStart(3, '0');
      let filename = `${cat.code}-${num}${isVideo ? ext : '.jpg'}`;
      while (fs.existsSync(path.join(UPLOAD_DIR, filename))) {
        seq++;
        num = String(seq).padStart(3, '0');
        filename = `${cat.code}-${num}${isVideo ? ext : '.jpg'}`;
      }
      try {
        if (isVideo) {
          try { compressVideoSync(src, path.join(UPLOAD_DIR, filename)); }
          catch (e) { fs.copyFileSync(src, path.join(UPLOAD_DIR, filename)); }
        } else {
          await awaitCompress(src, path.join(UPLOAD_DIR, filename));
        }
      } catch (e) {
        console.error('处理失败:', file, e.message);
        failed++;
        continue;
      }
      insert.run(filename, file, isVideo ? 'video' : 'photo', uploader, caption, '',
        0, cat.label, seq - 1, Date.now() + added);
      added++;
      if (added % 20 === 0) console.log(`已导入 ${added} 个…`);
    }
  }

  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`完成：新增 ${added}，跳过重复 ${skipped}，失败 ${failed}`);
}

function compressVideoSync(src, dest) {
  const tmp = dest + '.compress.mp4';
  try {
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', src,
      '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,fps=30",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-max_muxing_queue_size', '1024',
      tmp,
    ], { timeout: 30 * 60 * 1000, stdio: ['ignore', 'ignore', 'pipe'] });
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function awaitCompress(src, dest) {
  return sharp(src).rotate()
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(dest);
}

main().catch(e => { console.error(e); process.exit(1); });
