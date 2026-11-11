#!/usr/bin/env node
// 增量重建完整大片：复用旧片前缀，只重渲「最后一张照片 + 张曦专题卡 + 全部留言卡 + 收尾」，
// 再拼接视频、重做整条音轨。
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = fs.existsSync(path.join(ROOT, 'tools', 'ffmpeg')) ? path.join(ROOT, 'tools', 'ffmpeg') : 'ffmpeg';
const DB = path.join(ROOT, 'data', 'db.sqlite');
const UPLOAD = path.join(ROOT, 'data', 'uploads');
const MAIN = path.join(ROOT, 'data', 'main', 'main-cover-landscape.jpg');
const ASSETS = path.join(ROOT, 'data', 'tmp', 'video-assets');
const TMP = path.join(ROOT, 'data', 'tmp', 'rebuild');
const FULL = path.join(ROOT, 'exports', '忆叶公玉生老大人-1920x1080.mp4');
const W = 1920, H = 1080, FPS = 30, T = 0.6, CHUNK = 8;

function sh(cmd, args) { return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
function run(tag, args) {
  const t0 = Date.now();
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-stats', ...args], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`${tag} 失败`, r.status); process.exit(1); }
  console.log(`${tag} 完成 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
function ffprobe(file) {
  let info = '';
  try { sh(FFMPEG, ['-hide_banner', '-i', file]); }
  catch (e) { info = (e.stderr || '').toString(); }
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  return { seconds: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]) : 0 };
}
const db = new Database(DB, { readonly: true });
const q = sql => db.prepare(sql).all();
const CAT_ORDER = JSON.parse(q("select value from settings where key='categoryOrder'")[0].value);
const PHOTO_SEC = (+q("select value from settings where key='speed'")[0].value || 3) + T;
const VOL = +q("select value from settings where key='musicVolume'")[0].value || 0.45;
const playlist = JSON.parse(q("select value from settings where key='musicPlaylist'")[0].value)
  .filter(f => fs.existsSync(path.join(ROOT, 'data', 'music', f)));
const titleMap = JSON.parse(fs.readFileSync(path.join(ASSETS, 'titles', 'map.json'), 'utf8'));

const catRank = Object.fromEntries(CAT_ORDER.map((c, i) => [c, i]));
const media = q("select id, category, kind, filename, caption, uploader, sort_order from media order by id")
  .filter(r => (r.kind === 'photo' || r.kind === 'video') && fs.existsSync(path.join(UPLOAD, r.filename)))
  .sort((a, b) => (catRank[a.category] ?? 99) - (catRank[b.category] ?? 99) || (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id)
  .map(r => {
    const file = path.join(UPLOAD, r.filename);
    const cap = (r.caption || '').trim() || (r.uploader || '').trim()
      ? path.join(ASSETS, 'caps', `cap-${r.id}.png`) : null;
    if (r.kind === 'video') return { kind: 'video', file, dur: ffprobe(file).seconds + T, cap, category: r.category };
    return { kind: 'photo', file, dur: PHOTO_SEC, cap, category: r.category };
  });

const messages = q("select id, name, content from messages order by id");
const LONG_NAME = '张曦';
const specialCount = +fs.readFileSync(path.join(ASSETS, 'msgs', 'special-count.txt'), 'utf8');
const regularMsgs = messages.filter(m => !(m.name === LONG_NAME && m.content.length > 300));

// ---- 与旧片完全一致的完整素材序列 ----
const items = [{ kind: 'photo', file: MAIN, dur: 4 + T, cap: null }];
for (const cat of CAT_ORDER) {
  if (!media.some(m => m.category === cat)) continue;
  items.push({ kind: 'photo', file: path.join(ASSETS, 'titles', `title-${titleMap.indexOf(cat)}.jpg`), dur: 3 + T, cap: null });
  for (const m of media.filter(x => x.category === cat)) items.push(m);
}
for (let p = 1; p <= specialCount; p++) items.push({ kind: 'photo', file: path.join(ASSETS, 'msgs', `special-${String(p).padStart(2, '0')}.jpg`), dur: 4 + T, cap: null });
for (const m of regularMsgs) items.push({ kind: 'photo', file: path.join(ASSETS, 'msgs', `msg-${m.id}.jpg`), dur: 4 + T, cap: null });
items.push({ kind: 'photo', file: MAIN, dur: 5 + T, cap: null });

// ---- 分段起始时间（段内重叠 T，段间硬切）----
const chunks = [[]];
for (const it of items) {
  if (chunks[chunks.length - 1].length >= CHUNK) chunks.push([]);
  chunks[chunks.length - 1].push(it);
}
let acc = 0;
for (const ch of chunks) {
  let cur = 0;
  ch.forEach((it, k) => { it.start = acc + cur - T * k; cur += it.dur; });
  acc += cur - T * (ch.length - 1);
}
const totalNew = acc;

// 旧片前缀 = 前 264 个素材（33 个整段）
const PREFIX_ITEMS = 264;
const prefixChunks = [];
{
  let n = 0;
  for (const ch of chunks) { if (n + ch.length > PREFIX_ITEMS) break; prefixChunks.push(ch); n += ch.length; }
  if (n !== PREFIX_ITEMS) { console.error('前缀分段不整除:', n); process.exit(1); }
}
const P = prefixChunks.reduce((s, ch) => s + ch.reduce((a, it) => a + it.dur, 0) - T * (ch.length - 1), 0);
const tailItems = items.slice(PREFIX_ITEMS);
const tailTotal = totalNew - P;
console.log(`完整序列 ${items.length} 段；前缀 ${PREFIX_ITEMS} 段 = ${P.toFixed(2)}s；尾部 ${tailItems.length} 段 = ${tailTotal.toFixed(2)}s；新总长 ${(totalNew / 60).toFixed(1)} 分钟`);

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ---- 1) 从旧片拷贝出前缀（无声视频）----
const prefixV = path.join(TMP, 'prefix.mp4');
run('提取前缀', ['-ss', '0', '-t', P.toFixed(3), '-i', FULL, '-map', '0:v', '-an', '-c', 'copy', '-avoid_negative_ts', 'make_zero', prefixV]);
const pdur = ffprobe(prefixV).seconds;
if (Math.abs(pdur - P) > 0.15) { console.error(`前缀时长异常: ${pdur} vs ${P}`); process.exit(1); }

// ---- 2) 渲染尾部（照片链 + 字幕条）----
const tailChunks = [[]];
for (const it of tailItems) {
  if (tailChunks[tailChunks.length - 1].length >= CHUNK) tailChunks.push([]);
  tailChunks[tailChunks.length - 1].push(it);
}
let base = 0;
for (const ch of tailChunks) {
  let cur = 0;
  ch.forEach((it, k) => { it.rel = cur - T * k; cur += it.dur; });
  base += cur - T * (ch.length - 1);
}
tailChunks.forEach((ch, ki) => {
  const args = [];
  const fc = [];
  let inputCount = 0;
  ch.forEach((it, k) => {
    const srcIdx = inputCount;
    args.push('-loop', '1', '-framerate', String(FPS), '-t', it.dur.toFixed(3), '-i', it.file);
    inputCount++;
    let v = `[${srcIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=18:4[bg${k}];` +
      `[${srcIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg${k}];` +
      `[bg${k}][fg${k}]overlay=(W-w)/2:(H-h)/2`;
    let last = `ov${k}`;
    if (it.cap && fs.existsSync(it.cap)) {
      const ci = inputCount;
      args.push('-loop', '1', '-framerate', String(FPS), '-t', it.dur.toFixed(3), '-i', it.cap);
      inputCount++;
      fc.push(`${v}[${last}];[${last}][${ci}:v]overlay=0:main_h-overlay_h[cv${k}]`);
      last = `cv${k}`;
    } else {
      fc.push(`${v}[${last}]`);
    }
    fc.push(`[${last}]format=yuv420p,setsar=1,trim=0:${it.dur.toFixed(3)},setpts=PTS-STARTPTS,fps=${FPS}[v${k}]`);
  });
  let prev = 'v0';
  for (let k = 1; k < ch.length; k++) {
    const out = k === ch.length - 1 ? 'vout' : `x${k}`;
    fc.push(`[${prev}][v${k}]xfade=transition=fade:duration=${T}:offset=${(ch[k].rel - ch[0].rel).toFixed(3)}[${out}]`);
    prev = out;
  }
  if (ch.length === 1) fc.push('[v0]null[vout]');
  const segOut = path.join(TMP, `tail-${String(ki).padStart(3, '0')}.mp4`);
  args.push('-filter_complex', fc.join(';'), '-map', '[vout]', '-an',
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-threads', '3', '-x264-params', 'rc-lookahead=15', segOut);
  run(`尾部 分段 ${ki + 1}/${tailChunks.length}`, args);
});

fs.writeFileSync(path.join(TMP, 'tail-list.txt'),
  tailChunks.map((_, ki) => `file 'tail-${String(ki).padStart(3, '0')}.mp4'`).join('\n'));
const tailV = path.join(TMP, 'tail.mp4');
run('尾部拼接', ['-f', 'concat', '-safe', '0', '-i', path.join(TMP, 'tail-list.txt'), '-c', 'copy', tailV]);

// ---- 3) 前缀 + 尾部 拼接 ----
fs.writeFileSync(path.join(TMP, 'all-list.txt'), `file 'prefix.mp4'\nfile 'tail.mp4'`);
const fullV = path.join(TMP, 'full-v.mp4');
run('视频拼接', ['-f', 'concat', '-safe', '0', '-i', path.join(TMP, 'all-list.txt'), '-c', 'copy', fullV]);

// ---- 4) 整条音轨：视频原声（位置不变）+ 歌单循环 ----
const args = [];
const fc = [];
const audioIns = [];
let nextInput = 0;
for (const it of items) {
  if (it.kind === 'video') {
    const idx = nextInput++;
    args.push('-i', it.file);
    const delay = Math.round(it.start * 1000);
    fc.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay},apad=whole_dur=${totalNew.toFixed(3)}[a${idx}]`);
    audioIns.push(`[a${idx}]`);
  }
}
const m0 = nextInput;
playlist.forEach(f => args.push('-i', path.join(ROOT, 'data', 'music', f)));
fc.push(playlist.map((_, j) => `[${m0 + j}:a]`).join('') +
  `concat=n=${playlist.length}:v=0:a=1,aresample=48000,aformat=channel_layouts=stereo,aloop=loop=-1:size=2e9,atrim=0:${totalNew.toFixed(3)},volume=${VOL},afade=t=out:st=${Math.max(0, totalNew - 4).toFixed(3)}:d=4[mus]`);
audioIns.push('[mus]');
fc.push(audioIns.join('') + `amix=inputs=${audioIns.length}:normalize=0,atrim=0:${totalNew.toFixed(3)},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
const audioFile = path.join(TMP, 'audio.m4a');
run('音轨渲染', [...args, '-filter_complex', fc.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', audioFile]);

// ---- 5) 合成最终文件（视频拷贝 + 新音轨）----
const finalTmp = path.join(TMP, 'full-new.mp4');
run('最终合成', ['-i', fullV, '-i', audioFile, '-map', '0:v', '-map', '1:a',
  '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', '-shortest', finalTmp]);

const fdur = ffprobe(finalTmp).seconds;
console.log(`新片时长 ${fdur.toFixed(2)}s（预期 ${totalNew.toFixed(2)}s）`);
if (Math.abs(fdur - totalNew) > 1.5) { console.error('时长异常，未替换'); process.exit(1); }
fs.copyFileSync(finalTmp, FULL);
console.log('已替换:', FULL);
