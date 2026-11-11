#!/usr/bin/env node
// 渲染全部成片：先完整大片，再 4 条分类短片。
// 大片: 主图开场 -> 各分类(标题卡+素材含字幕条) -> 留言卡 -> 主图收尾, 歌单循环。
// 短片: 主图开场 -> 各分类(标题卡+素材含字幕条) -> 主图收尾, 单曲循环。
// 用法: node scripts/make-all-videos.js [full|themes|all]（默认 all）
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = fs.existsSync(path.join(ROOT, 'tools', 'ffmpeg')) ? path.join(ROOT, 'tools', 'ffmpeg') : 'ffmpeg';
const DB = path.join(ROOT, 'data', 'db.sqlite');
const UPLOAD = path.join(ROOT, 'data', 'uploads');
const MAIN = path.join(ROOT, 'data', 'main', 'main-cover-landscape.jpg');
const ASSETS = path.join(ROOT, 'data', 'tmp', 'video-assets');
const TMP = path.join(ROOT, 'data', 'tmp', 'all-build');
const FULL_OUT = path.join(ROOT, 'exports', '忆叶公玉生老大人-1920x1080.mp4');
const THEME_DIR = path.join(ROOT, 'exports', '分类短片');
const CHUNK = 8;
const NORM = path.join(TMP, 'norm');

const W = 1920, H = 1080, FPS = 30, T = 0.6;

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
  const seconds = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]) : 0;
  return { seconds, hasAudio: /Stream .*Audio/.test(info) };
}

const q = sql => JSON.parse(sh('sqlite3', ['-json', DB, sql]));
const CAT_ORDER = JSON.parse(q("select value from settings where key='categoryOrder'")[0].value);
const PHOTO_SEC = (+q("select value from settings where key='speed'")[0].value || 3) + T;
const VOL = +q("select value from settings where key='musicVolume'")[0].value || 0.45;
const playlist = JSON.parse(q("select value from settings where key='musicPlaylist'")[0].value)
  .filter(f => fs.existsSync(path.join(ROOT, 'data', 'music', f)));
const titleMap = JSON.parse(fs.readFileSync(path.join(ASSETS, 'titles', 'map.json'), 'utf8'));
const titleFile = cat => path.join(ASSETS, 'titles', `title-${titleMap.indexOf(cat)}.jpg`);

const catRank = Object.fromEntries(CAT_ORDER.map((c, i) => [c, i]));
const rows = q("select id, category, kind, filename, caption, uploader, sort_order from media order by id")
  .filter(r => (r.kind === 'photo' || r.kind === 'video') && fs.existsSync(path.join(UPLOAD, r.filename)))
  .sort((a, b) => (catRank[a.category] ?? 99) - (catRank[b.category] ?? 99) || (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);

// 视频先逐个预转为标准 1920x1080/30fps 中间文件（模糊填充），避免分段时内存爆炸
fs.mkdirSync(NORM, { recursive: true });
function normalizeVideo(file) {
  const out = path.join(NORM, path.basename(file).replace(/\.\w+$/, '') + '.mp4');
  if (fs.existsSync(out)) return out;
  const dur = ffprobe(file).seconds;
  run(`预转视频 ${path.basename(file)}`, [
    '-i', file, '-t', dur.toFixed(3),
    '-filter_complex',
    `[0:v]split=2[bg][fg];` +
    `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=18:4[bgo];` +
    `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];` +
    `[bgo][fgs]overlay=(W-w)/2:(H-h)/2,fps=${FPS},format=yuv420p,setsar=1[v]`,
    '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20', '-r', String(FPS), out]);
  return out;
}

const media = rows.map(r => {
  const file = path.join(UPLOAD, r.filename);
  const cap = (r.caption || '').trim() || (r.uploader || '').trim()
    ? path.join(ASSETS, 'caps', `cap-${r.id}.png`) : null;
  if (r.kind === 'video') {
    const p = ffprobe(file);
    return { kind: 'video', vfile: normalizeVideo(file), file, dur: p.seconds + T, hasAudio: p.hasAudio, cap, category: r.category };
  }
  return { kind: 'photo', file, dur: PHOTO_SEC, cap, category: r.category };
});

// ---- 组装某个节目的素材列表 ----
function buildItems(cats, { messages = false } = {}) {
  const items = [{ kind: 'photo', file: MAIN, dur: 4 + T, cap: null }];
  for (const cat of cats) {
    items.push({ kind: 'photo', file: titleFile(cat), dur: 3 + T, cap: null });
    for (const m of media.filter(x => x.category === cat)) items.push(m);
  }
  if (messages) {
    for (const f of fs.readdirSync(path.join(ASSETS, 'msgs')).filter(f => f.endsWith('.jpg')).sort((a, b) => +a.slice(4, -4) - +b.slice(4, -4))) {
      items.push({ kind: 'photo', file: path.join(ASSETS, 'msgs', f), dur: 4 + T, cap: null });
    }
  }
  items.push({ kind: 'photo', file: MAIN, dur: 5 + T, cap: null });
  return items;
}

// ---- 渲染一个节目 ----
function render(name, items, musicFiles, out) {
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
  const total = acc;

  const work = path.join(TMP, name);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  chunks.forEach((ch, ki) => {
    const args = [];
    const fc = [];
    let inputCount = 0;
    ch.forEach((it, k) => {
      const srcIdx = inputCount;
      if (it.kind === 'photo') args.push('-loop', '1', '-framerate', String(FPS), '-t', it.dur.toFixed(3), '-i', it.file);
      else args.push('-i', it.vfile);
      inputCount++;
      let v;
      if (it.kind === 'photo') {
        v = `[${srcIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=18:4[bg${k}];` +
          `[${srcIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg${k}];` +
          `[bg${k}][fg${k}]overlay=(W-w)/2:(H-h)/2`;
      } else {
        v = `[${srcIdx}:v]format=yuv420p,setsar=1`;
      }
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
      const tail = it.kind === 'video'
        ? `,tpad=stop_mode=clone:stop=${Math.ceil(T * FPS) + 4}` : '';
      fc.push(`[${last}]format=yuv420p,setsar=1${tail},trim=0:${it.dur.toFixed(3)},setpts=PTS-STARTPTS,fps=${FPS}[v${k}]`);
    });
    let prev = 'v0';
    for (let k = 1; k < ch.length; k++) {
      const out2 = k === ch.length - 1 ? 'vout' : `x${k}`;
      fc.push(`[${prev}][v${k}]xfade=transition=fade:duration=${T}:offset=${(ch[k].start - ch[0].start).toFixed(3)}[${out2}]`);
      prev = out2;
    }
    if (ch.length === 1) fc.push('[v0]null[vout]');
    const segOut = path.join(work, `seg-${String(ki).padStart(3, '0')}.mp4`);
    args.push('-filter_complex', fc.join(';'), '-map', '[vout]', '-an',
      '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-threads', '3', '-x264-params', 'rc-lookahead=15', segOut);
    run(`${name} 分段 ${ki + 1}/${chunks.length}`, args);
  });

  const silent = path.join(work, 'silent.mp4');
  fs.writeFileSync(path.join(work, 'list.txt'),
    chunks.map((_, ki) => `file 'seg-${String(ki).padStart(3, '0')}.mp4'`).join('\n'));
  run(`${name} 拼接`, ['-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.txt'), '-c', 'copy', silent]);

  const args = ['-i', silent];
  const fc = [];
  const audioIns = [];
  let nextInput = 1;
  items.forEach(it => {
    if (it.kind === 'video' && it.hasAudio) {
      const idx = nextInput++;
      args.push('-i', it.file);
      const delay = Math.round(it.start * 1000);
      fc.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay},apad=whole_dur=${total.toFixed(3)}[a${idx}]`);
      audioIns.push(`[a${idx}]`);
    }
  });
  const m0 = nextInput;
  musicFiles.forEach(f => args.push('-i', path.join(ROOT, 'data', 'music', f)));
  fc.push(musicFiles.map((_, j) => `[${m0 + j}:a]`).join('') +
    `concat=n=${musicFiles.length}:v=0:a=1,aresample=48000,aformat=channel_layouts=stereo,aloop=loop=-1:size=2e9,atrim=0:${total.toFixed(3)},volume=${VOL},afade=t=out:st=${Math.max(0, total - 4).toFixed(3)}:d=4[mus]`);
  audioIns.push('[mus]');
  fc.push(audioIns.join('') + `amix=inputs=${audioIns.length}:normalize=0,atrim=0:${total.toFixed(3)},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run(`${name} 混音输出`, [...args, '-filter_complex', fc.join(';'), '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
  const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`>>> ${out}  时长 ${(total / 60).toFixed(1)} 分钟, ${size} MB`);
}

const mode = process.argv[2] || 'all';
if (mode === 'full' || mode === 'all') {
  render('full', buildItems(CAT_ORDER.filter(c => media.some(m => m.category === c)), { messages: true }), playlist, FULL_OUT);
}
if (mode === 'themes' || mode === 'all') {
  const M = f => [f];
  render('01-合影', buildItems(['合影']), M('弯弯的眉毛-献给叶玉生-男声版.m4a'), path.join(THEME_DIR, '01-合影.mp4'));
  render('02-平时', buildItems(['平时']), M('眉毛弯成一座桥-献给叶玉生-女声版.m4a'), path.join(THEME_DIR, '02-平时.mp4'));
  render('03-生病', buildItems(['生病']), M('追忆-叶玉生-背景音乐-3分14秒.m4a'), path.join(THEME_DIR, '03-生病.mp4'));
  render('04-酒席及其他', buildItems(['个影', '早期', '酒席', '旅行']), M('追忆-叶玉生-背景音乐-3分08秒.m4a'), path.join(THEME_DIR, '04-酒席及其他.mp4'));
}
console.log('全部完成');
