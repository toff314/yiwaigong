#!/usr/bin/env node
// 压缩已上传视频：最长边 1280、H.264 CRF 26、AAC 128k、faststart
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
const db = new Database(path.join(ROOT, 'data', 'db.sqlite'));
const FFMPEG = process.env.FFMPEG_BIN || (fs.existsSync(path.join(ROOT, 'tools', 'ffmpeg')) ? path.join(ROOT, 'tools', 'ffmpeg') : 'ffmpeg');

const rows = db.prepare("SELECT id, filename FROM media WHERE kind='video' ORDER BY id").all();
let saved = 0;

for (const row of rows) {
  const src = path.join(UPLOAD_DIR, row.filename);
  if (!fs.existsSync(src)) continue;
  const before = fs.statSync(src).size;
  const tmp = path.join(UPLOAD_DIR, `.compress-${row.id}-${Date.now()}.mp4`);
  process.stdout.write(`${row.filename}  ${(before / 1048576).toFixed(1)}MB -> `);
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
    const after = fs.statSync(tmp).size;
    if (after > 0 && after < before) {
      fs.renameSync(tmp, src);
      saved += before - after;
      console.log(`${(after / 1048576).toFixed(1)}MB  ✓`);
    } else {
      fs.unlinkSync(tmp);
      console.log('保持原样');
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    console.log('失败: ' + (e.stderr ? e.stderr.toString().slice(0, 200) : e.message));
  }
}

console.log(`完成，共节省 ${(saved / 1048576).toFixed(1)}MB`);
