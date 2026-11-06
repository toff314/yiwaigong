#!/usr/bin/env node
// 导入 yiwaigong.zip：按目录分类、统一命名、均衡分配家属留言
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
  '个影': '个影',
  '酒席': '酒席',
  '旅行': '旅行',
  '旅游': '旅行',
  '生病': '生病',
  '合影': '合影',
};

const PREMIUM = ['叶玲', '叶文桂', '叶兰'];
const SECOND = '黄迪';

function targetCounts(total, current) {
  const base = Math.floor(total / FAMILY.length);
  const target = new Map();
  for (const name of FAMILY) target.set(name, base);
  for (const name of PREMIUM) target.set(name, base + 4);
  target.set(SECOND, base + 2);
  let diff = total - [...target.values()].reduce((a, b) => a + b, 0);
  const others = FAMILY.filter(n => !PREMIUM.includes(n) && n !== SECOND);
  others.sort((a, b) => diff < 0
    ? (current.get(b) || 0) - (current.get(a) || 0)
    : (current.get(a) || 0) - (current.get(b) || 0));
  let i = 0;
  while (diff !== 0) {
    const name = others[i % others.length];
    target.set(name, target.get(name) + (diff > 0 ? 1 : -1));
    diff += diff > 0 ? -1 : 1;
    i++;
  }
  return target;
}

function assignUploaders(db, newFiles) {
  const current = new Map(FAMILY.map(n => [n, 0]));
  for (const row of db.prepare('SELECT uploader, COUNT(*) c FROM media GROUP BY uploader').all()) {
    if (current.has(row.uploader)) current.set(row.uploader, row.c);
  }
  const total = [...current.values()].reduce((a, b) => a + b, 0) + newFiles.length;
  const target = targetCounts(total, current);
  const needs = new Map(FAMILY.map(n => [n, Math.max(0, (target.get(n) || 0) - (current.get(n) || 0))]));

  let sum = [...needs.values()].reduce((a, b) => a + b, 0);
  let diff = newFiles.length - sum;
  const order = [...PREMIUM, SECOND, ...FAMILY.filter(n => !PREMIUM.includes(n) && n !== SECOND)];
  let i = 0;
  while (diff !== 0) {
    const name = order[i % order.length];
    const v = needs.get(name) + (diff > 0 ? 1 : -1);
    if (v >= 0) { needs.set(name, v); diff += diff > 0 ? -1 : 1; }
    i++;
  }

  const inCategory = new Map();
  for (const row of db.prepare('SELECT category, uploader, COUNT(*) c FROM media GROUP BY category, uploader').all()) {
    inCategory.set(row.category + '|' + row.uploader, row.c);
  }
  const rank = new Map(order.map((n, idx) => [n, idx]));
  const portraitFirst = [...PREMIUM, SECOND];
  const result = [];
  for (const f of newFiles) {
    const candidates = FAMILY.filter(n => (needs.get(n) || 0) > 0);
    candidates.sort((a, b) => {
      if (f.category === '个影') {
        const pa = portraitFirst.includes(a) && (inCategory.get(f.category + '|' + a) || 0) === 0 ? 0 : 1;
        const pb = portraitFirst.includes(b) && (inCategory.get(f.category + '|' + b) || 0) === 0 ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      const ra = inCategory.get(f.category + '|' + a) || 0;
      const rb = inCategory.get(f.category + '|' + b) || 0;
      if (ra !== rb) return ra - rb;
      const na = needs.get(a), nb = needs.get(b);
      if (na !== nb) return nb - na;
      return (rank.get(a) ?? 999) - (rank.get(b) ?? 999);
    });
    const pick = candidates[0];
    needs.set(pick, needs.get(pick) - 1);
    inCategory.set(f.category + '|' + pick, (inCategory.get(f.category + '|' + pick) || 0) + 1);
    result.push(pick);
  }
  return result;
}

function assignCaptions(db, newFiles) {
  const used = new Map();
  for (const row of db.prepare('SELECT category, caption, COUNT(*) c FROM media GROUP BY category, caption').all()) {
    used.set(row.category + '|' + row.caption, row.c);
  }
  const result = [];
  for (const f of newFiles) {
    const pool = MESSAGES[f.category] || MESSAGES['未分类'];
    let best = pool[0], bestCount = Infinity;
    for (const m of pool) {
      const c = used.get(f.category + '|' + m) || 0;
      if (c < bestCount) { bestCount = c; best = m; }
    }
    used.set(f.category + '|' + best, bestCount + 1);
    result.push(best);
  }
  return result;
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

  const dirs = fs.readdirSync(TMP).filter(d => {
    try { return fs.statSync(path.join(TMP, d)).isDirectory(); } catch { return false; }
  }).sort();

  const newFiles = [];
  let skipped = 0;
  for (const dir of dirs) {
    if (dir.startsWith('.') || dir === '__MACOSX') continue;
    const catLabel = CATEGORIES[dir] || normalizeCategory(dir) || dir;
    const files = fs.readdirSync(path.join(TMP, dir))
      .filter(f => /\.(jpe?g|png|webp|gif|mp4|mov|m4v|webm)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    for (const file of files) {
      if (exists.get(file, catLabel)) { skipped++; continue; }
      newFiles.push({ dir, file, category: catLabel, src: path.join(TMP, dir, file) });
    }
  }

  const uploaders = assignUploaders(db, newFiles);
  const captions = assignCaptions(db, newFiles);

  let added = 0, failed = 0;
  const seqs = new Map();
  for (let i = 0; i < newFiles.length; i++) {
    const { file, category, src } = newFiles[i];
    const isVideo = /\.(mp4|mov|m4v|webm)$/i.test(file);
    const code = categoryCode(category);
    if (!seqs.has(category)) {
      seqs.set(category, db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM media WHERE category=?').get(category).m + 1);
    }
    let seq = seqs.get(category);
    let filename = `${code}-${String(seq + 1).padStart(3, '0')}${isVideo ? '.mp4' : '.jpg'}`;
    while (fs.existsSync(path.join(UPLOAD_DIR, filename))) {
      seq++;
      filename = `${code}-${String(seq + 1).padStart(3, '0')}${isVideo ? '.mp4' : '.jpg'}`;
    }
    seqs.set(category, seq + 1);

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

    insert.run(filename, file, isVideo ? 'video' : 'photo', uploaders[i], captions[i], '',
      0, category, seq, Date.now() + added);
    added++;
    if (added % 20 === 0) console.log(`已导入 ${added} 个…`);
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
