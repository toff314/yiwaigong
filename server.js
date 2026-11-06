// 忆·外公 —— 纪念相册收集与播放系统
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { execSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const crypto = require('crypto');
const { normalizeCategory, categoryCode, randomMessage } = require('./lib/family');

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
const MUSIC_DIR = path.join(ROOT, 'data', 'music');
const MAIN_DIR = path.join(ROOT, 'data', 'main');
const EXPORT_DIR = path.join(ROOT, 'exports');
const OFFLINE_DIR = path.join(ROOT, 'offline');
const DB_PATH = path.join(ROOT, 'data', 'db.sqlite');
const PORT = process.env.MEMORIAL_PORT || 3450;
const FFMPEG = fs.existsSync(path.join(ROOT, 'tools', 'ffmpeg')) ? path.join(ROOT, 'tools', 'ffmpeg') : 'ffmpeg';

// ---- 配置（可通过环境变量覆盖）----
const CONFIG = {
  accessCode: process.env.MEMORIAL_CODE || 'yeyusheng', // 口令：可改成外公名字
  adminPassword: process.env.MEMORIAL_ADMIN || 'yiwaijong2026',
  title: '忆·外公',
  subtitle: '叶玉生 · 1938 — 2026',
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(MUSIC_DIR, { recursive: true });
fs.mkdirSync(MAIN_DIR, { recursive: true });
fs.mkdirSync(EXPORT_DIR, { recursive: true });
fs.mkdirSync(OFFLINE_DIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'data', 'tmp'), { recursive: true });

// ---- 数据库 ----
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,          -- 服务器存储名
  origname TEXT NOT NULL,          -- 原始文件名
  kind TEXT NOT NULL CHECK(kind IN ('photo','video')),
  uploader TEXT NOT NULL,          -- 上传者姓名
  caption TEXT DEFAULT '',         -- 寄语
  year TEXT DEFAULT '',            -- 年代角标（可选）
  featured INTEGER DEFAULT 0,      -- 重要照片（大图段落优先）
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
try { db.exec("ALTER TABLE media ADD COLUMN category TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE media ADD COLUMN sort_order INTEGER DEFAULT 0"); } catch {}

const KNOWN_CATEGORIES = ['早期', '平时', '个影', '酒席', '旅行', '生病', '合影'];
const DEFAULT_SETTINGS = {
  categoryOrder: [...KNOWN_CATEGORIES, '未分类'],
  playMode: 'category',       // category | sequence | random | single
  speed: 1,                   // 0.5 - 3 倍速
  singleCategory: 'all',      // single 模式下选择的目录
  showCategoryCard: 0,        // 目录标题卡（默认关闭，直接进入照片轮播）
  music: '',                  // 首选背景音乐（兼容旧字段）
  musicPlaylist: [],          // 背景音乐播放顺序
  coverImage: '',              // 开场主图：main/xxx 或 media/xxx
  musicVolume: 0.55,
  loop: 1,
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  if (!Array.isArray(out.categoryOrder)) out.categoryOrder = [...DEFAULT_SETTINGS.categoryOrder];
  if (!Array.isArray(out.musicPlaylist)) out.musicPlaylist = out.music ? [out.music] : [];
  if (typeof out.coverImage !== 'string') out.coverImage = '';
  return out;
}

function saveSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, JSON.stringify(v));
  }
}

function categoryOf(item) { return (item.category || '').trim() || '未分类'; }

function allCategories() {
  const rows = db.prepare("SELECT DISTINCT category FROM media WHERE category IS NOT NULL AND category <> ''").all();
  const s = getSettings();
  const set = new Set([...KNOWN_CATEGORIES, ...rows.map(r => r.category), '未分类', ...s.categoryOrder]);
  const ordered = s.categoryOrder.filter(c => set.has(c));
  for (const c of set) if (!ordered.includes(c)) ordered.push(c);
  return ordered;
}

function sortItems(items, settings) {
  const order = settings.categoryOrder || [];
  const rank = new Map(order.map((c, i) => [c, i]));
  return items.slice().sort((a, b) => {
    const ca = categoryOf(a), cb = categoryOf(b);
    if (ca !== cb) {
      const ra = rank.has(ca) ? rank.get(ca) : 999;
      const rb = rank.has(cb) ? rank.get(cb) : 999;
      if (ra !== rb) return ra - rb;
      return ca.localeCompare(cb, 'zh-CN');
    }
    return (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;
  });
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function groupByCategory(items, categories) {
  const groups = [];
  for (const cat of categories) {
    const list = items.filter(i => categoryOf(i) === cat);
    if (list.length) groups.push({ category: cat, items: list });
  }
  return groups;
}

const app = express();
app.use(express.json());
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ---- 上传 ----
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 单文件 500MB（视频）
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpe?g|png|webp|gif|mp4|mov|m4v|webm)$/i.test(file.originalname);
    cb(ok ? null : new Error('仅支持图片(jpg/png/webp/gif)和视频(mp4/mov/m4v/webm)'), ok);
  },
});

// 照片压缩：最长边 2400px，质量 85（保留细节，控制体积）
async function compressPhotoTo(src, dest) {
  await sharp(src).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toFile(dest);
  fs.unlinkSync(src);
}

async function compressVideoTo(src, dest) {
  const tmp = dest + '.compress.mp4';
  try {
    await execFileAsync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', src,
      '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,fps=30",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-max_muxing_queue_size', '1024',
      tmp,
    ], { timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 * 4 });
    fs.renameSync(tmp, dest);
    fs.unlinkSync(src);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// 新上传素材沿用批量导入的命名规则：<目录编码>-<三位序号>.<扩展名>
function allocateFilename(category, ext) {
  const code = categoryCode(category);
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM media WHERE category=?').get(category).m;
  let seq = max + 1;
  let filename = `${code}-${String(seq + 1).padStart(3, '0')}${ext}`;
  while (fs.existsSync(path.join(UPLOAD_DIR, filename))) {
    seq++;
    filename = `${code}-${String(seq + 1).padStart(3, '0')}${ext}`;
  }
  return { filename, seq };
}

app.post('/api/upload', upload.array('files', 50), async (req, res) => {
  if (req.body.code !== CONFIG.accessCode) return res.status(403).json({ error: '口令不正确' });
  const uploader = (req.body.uploader || '').trim().slice(0, 30);
  if (!uploader) return res.status(400).json({ error: '请填写您的名字' });
  const givenCaption = (req.body.caption || '').trim().slice(0, 200);
  const allowed = new Set([...KNOWN_CATEGORIES, ...allCategories().filter(c => c !== '未分类')]);
  const category = allowed.has(normalizeCategory(req.body.category)) ? normalizeCategory(req.body.category) : '';
  const saved = [];
  try {
    for (const f of req.files || []) {
      const isPhoto = /\.(jpe?g|png|webp|gif)$/i.test(f.originalname);
      const isGif = /\.gif$/i.test(f.originalname);
      const ext = isPhoto ? (isGif ? '.gif' : '.jpg') : '.mp4';
      const kind = isPhoto ? 'photo' : 'video';
      const { filename, seq } = allocateFilename(category, ext);
      const dest = path.join(UPLOAD_DIR, filename);
      if (isPhoto && !isGif) await compressPhotoTo(f.path, dest);
      else if (isPhoto) fs.renameSync(f.path, dest);
      else {
        try { await compressVideoTo(f.path, dest); }
        catch (e) { fs.renameSync(f.path, dest); }
      }
      const caption = givenCaption || randomMessage(category);
      const info = db.prepare('INSERT INTO media (filename, origname, kind, uploader, caption, year, featured, category, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(filename, f.originalname, kind, uploader, caption, '', 0, category, seq, Date.now());
      saved.push({ id: info.lastInsertRowid, kind, filename });
    }
    if (saved.length) addLamps(saved.length);
    res.json({ ok: true, saved: saved.length, total: db.prepare('SELECT COUNT(*) c FROM media').get().c, lamps: lampCount() });
  } catch (e) {
    for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch {} }
    res.status(500).json({ error: '保存失败: ' + e.message });
  }
});

// ---- 列表 / 播放数据 ----
app.get('/api/media', (req, res) => {
  const settings = getSettings();
  const rows = sortItems(db.prepare('SELECT id, filename, origname, kind, uploader, caption, year, featured, category, sort_order, created_at FROM media').all().filter(i => fs.existsSync(path.join(UPLOAD_DIR, i.filename))), settings);
  res.json({ title: CONFIG.title, subtitle: CONFIG.subtitle, items: rows, total: rows.length, settings });
});

app.get('/api/playlist', (req, res) => {
  const settings = getSettings();
  if (req.query.mode && ['category', 'sequence', 'random', 'single'].includes(req.query.mode)) settings.playMode = req.query.mode;
  if (req.query.category) settings.singleCategory = req.query.category;
  if (req.query.speed && Number(req.query.speed) > 0) settings.speed = Number(req.query.speed);

  let items = sortItems(db.prepare('SELECT id, filename, origname, kind, uploader, caption, year, featured, category, sort_order, created_at FROM media').all().filter(i => fs.existsSync(path.join(UPLOAD_DIR, i.filename))), settings);
  if (settings.playMode === 'single' && settings.singleCategory !== 'all') {
    items = items.filter(i => categoryOf(i) === settings.singleCategory);
  } else if (settings.playMode === 'random') {
    items = shuffle(items);
  }
  const categories = allCategories();
  const groups = groupByCategory(items, categories);
  res.json({
    title: CONFIG.title, subtitle: CONFIG.subtitle, settings, items, groups,
    categories: categories.map(name => ({ name, count: db.prepare('SELECT COUNT(*) c FROM media WHERE COALESCE(NULLIF(category,\'\'),\'未分类\')=?').get(name).c })),
    total: items.length,
  });
});

app.get('/api/main-images', (req, res) => {
  res.json({ items: listMainImages() });
});

app.get('/api/categories', (req, res) => {
  res.json({ categories: allCategories() });
});

app.get('/api/count', (req, res) => {
  res.json({
    total: db.prepare('SELECT COUNT(*) c FROM media').get().c,
    messages: db.prepare('SELECT COUNT(*) c FROM messages').get().c,
  });
});

// 纯文字留言：不用上传照片也能留一句话
app.get('/api/messages', (req, res) => {
  const rows = db.prepare('SELECT id, name, content, created_at FROM messages ORDER BY id DESC').all();
  res.json({ items: rows, total: rows.length });
});
app.post('/api/messages', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  const content = String(req.body.content || '').trim().slice(0, 500);
  if (!name) return res.status(400).json({ error: '请填写您的名字' });
  if (!content) return res.status(400).json({ error: '请写下想说的话' });
  const info = db.prepare('INSERT INTO messages (name, content, created_at) VALUES (?,?,?)')
    .run(name, content, Date.now());
  addLamps(1);
  res.json({
    ok: true,
    id: info.lastInsertRowid,
    total: db.prepare('SELECT COUNT(*) c FROM messages').get().c,
    lamps: lampCount(),
  });
});

// 「点亮心灯」计数：点击、留言、上传都会加灯，并且每小时自动增加 2 盏
const LAMP_KEY = 'lamps';
const LAMP_AUTO_KEY = 'lamps_last_auto';
const LAMP_INTERVAL_MS = 60 * 60 * 1000;
const LAMP_PER_HOUR = 2;
const upsertStat = (key, value) => db.prepare(
  'INSERT INTO stats (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
).run(key, value);

function addLamps(n) {
  n = Math.max(0, Number(n) || 0);
  if (!n) return;
  db.prepare('INSERT INTO stats (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value')
    .run(LAMP_KEY, n);
}

function applyHourlyLamps() {
  const now = Date.now();
  const row = db.prepare('SELECT value FROM stats WHERE key=?').get(LAMP_AUTO_KEY);
  if (!row) {
    upsertStat(LAMP_AUTO_KEY, now);
    return 0;
  }
  const last = Number(row.value) || now;
  const hours = Math.floor((now - last) / LAMP_INTERVAL_MS);
  if (hours <= 0) return 0;
  const add = hours * LAMP_PER_HOUR;
  db.transaction(() => {
    addLamps(add);
    upsertStat(LAMP_AUTO_KEY, last + hours * LAMP_INTERVAL_MS);
  })();
  return add;
}

function lampCount() {
  applyHourlyLamps();
  const row = db.prepare('SELECT value FROM stats WHERE key=?').get(LAMP_KEY);
  return row ? Number(row.value) : 0;
}
app.get('/api/lamps', (req, res) => {
  res.json({ lamps: lampCount() });
});
app.post('/api/lamps', (req, res) => {
  db.prepare('INSERT INTO stats (key,value) VALUES (?,1) ON CONFLICT(key) DO UPDATE SET value=value+1').run(LAMP_KEY);
  res.json({ lamps: lampCount() });
});

applyHourlyLamps();
setInterval(() => {
  try { applyHourlyLamps(); } catch (e) { console.error('心灯自动增加失败:', e.message); }
}, 60 * 1000);

app.use('/media/', express.static(UPLOAD_DIR, { maxAge: '1d' }));
app.use('/music/', express.static(MUSIC_DIR, { maxAge: '1d' }));
app.use('/main/', express.static(MAIN_DIR, { maxAge: '1d' }));

function listMainImages() {
  if (!fs.existsSync(MAIN_DIR)) return [];
  return fs.readdirSync(MAIN_DIR)
    .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
    .map(f => {
      const st = fs.statSync(path.join(MAIN_DIR, f));
      const title = /landscape/i.test(f) ? '设计主图（横版）'
        : /portrait/i.test(f) ? '设计主图（竖版）'
        : f.replace(/\.[^.]+$/, '');
      return { file: f, path: 'main/' + f, title, size: st.size };
    });
}

// ---- 音乐库 ----
function listMusic() {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  return fs.readdirSync(MUSIC_DIR)
    .filter(f => /\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(f))
    .sort()
    .map(f => {
      const st = fs.statSync(path.join(MUSIC_DIR, f));
      const base = f.replace(/\.[^.]+$/, '')
        .replace(/[-_]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '')
        .replace(/[_-]+/g, ' ').trim();
      return { file: f, title: base || f, size: st.size, mtime: st.mtimeMs };
    });
}

app.get('/api/music', (req, res) => res.json({ items: listMusic() }));

// ---- 管理 ----
function requireAdmin(req, res, next) {
  if (req.query.key === CONFIG.adminPassword || (req.body && req.body.key === CONFIG.adminPassword)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/admin/list', requireAdmin, (req, res) => {
  const settings = getSettings();
  const items = sortItems(db.prepare('SELECT * FROM media').all(), settings);
  const categories = allCategories().map(name => ({ name, count: items.filter(i => categoryOf(i) === name).length }));
  res.json({ items, categories, settings, music: listMusic(), mainImages: listMainImages() });
});

app.post('/api/admin/update', requireAdmin, (req, res) => {
  const { id, caption, year, featured, uploader, category, sort_order } = req.body;
  const cur = db.prepare('SELECT * FROM media WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const order = cur.kind === 'video'
    ? (cur.sort_order || 0)
    : (Number.isFinite(Number(sort_order)) ? Number(sort_order) : (cur.sort_order || 0));
  db.prepare('UPDATE media SET caption=?, year=?, featured=?, uploader=?, category=?, sort_order=? WHERE id=?')
    .run(
      String(caption ?? cur.caption ?? '').slice(0, 200),
      String(year ?? cur.year ?? '').slice(0, 20),
      featured ? 1 : 0,
      String(uploader ?? cur.uploader ?? '').slice(0, 30),
      String(category ?? cur.category ?? '').slice(0, 20),
      order,
      id
    );
  res.json({ ok: true });
});

app.post('/api/admin/delete', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT filename FROM media WHERE id=?').get(req.body.id);
  if (row) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, row.filename)); } catch {}
    db.prepare('DELETE FROM media WHERE id=?').run(req.body.id);
  }
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ settings: getSettings(), categories: allCategories(), music: listMusic(), mainImages: listMainImages() });
});

app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').replace(/[\r\n]/g, '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: '请填写目录名称' });
  if (name === '未分类') return res.status(400).json({ error: '「未分类」是保留名称' });
  if (allCategories().includes(name)) return res.status(400).json({ error: '这个目录已经存在' });
  const s = getSettings();
  saveSettings({ categoryOrder: [...s.categoryOrder, name] });
  res.json({ ok: true, settings: getSettings(), categories: allCategories() });
});

app.post('/api/admin/categories/delete', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name === '未分类') return res.status(400).json({ error: '不能删除这个目录' });
  const count = db.prepare("SELECT COUNT(*) c FROM media WHERE category=?").get(name).c;
  if (count > 0) return res.status(400).json({ error: '目录里还有素材，先移走或删除素材' });
  const s = getSettings();
  saveSettings({ categoryOrder: s.categoryOrder.filter(c => c !== name) });
  res.json({ ok: true, settings: getSettings(), categories: allCategories() });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (Array.isArray(body.categoryOrder)) {
    const seen = new Set();
    patch.categoryOrder = body.categoryOrder
      .map(c => String(c || '').trim()).filter(Boolean)
      .filter(c => { if (seen.has(c)) return false; seen.add(c); return true; });
    for (const c of allCategories()) if (!patch.categoryOrder.includes(c)) patch.categoryOrder.push(c);
  }
  if (['category', 'sequence', 'random', 'single'].includes(body.playMode)) patch.playMode = body.playMode;
  if (Number(body.speed) > 0) patch.speed = Math.min(4, Math.max(0.25, Number(body.speed)));
  if (body.singleCategory !== undefined) patch.singleCategory = String(body.singleCategory || 'all');
  if (body.showCategoryCard !== undefined) patch.showCategoryCard = body.showCategoryCard ? 1 : 0;
  if (body.coverImage !== undefined) {
    const ci = String(body.coverImage || '');
    if (!ci) patch.coverImage = '';
    else if (ci.startsWith('main/')) {
      const f = path.basename(ci);
      if (fs.existsSync(path.join(MAIN_DIR, f))) patch.coverImage = 'main/' + f;
    } else if (ci.startsWith('media/')) {
      const f = path.basename(ci);
      if (db.prepare("SELECT id FROM media WHERE filename=? AND kind='photo'").get(f)) patch.coverImage = 'media/' + f;
    }
  }
  if (Array.isArray(body.musicPlaylist)) {
    patch.musicPlaylist = body.musicPlaylist
      .map(f => path.basename(String(f || '')))
      .filter(f => f && fs.existsSync(path.join(MUSIC_DIR, f)));
    patch.music = patch.musicPlaylist[0] || '';
  } else if (body.music !== undefined) {
    patch.music = String(body.music || '');
    patch.musicPlaylist = patch.music ? [patch.music] : [];
  }
  if (body.musicVolume !== undefined) patch.musicVolume = Math.min(1, Math.max(0, Number(body.musicVolume)));
  if (body.loop !== undefined) patch.loop = body.loop ? 1 : 0;
  saveSettings(patch);
  res.json({ ok: true, settings: getSettings() });
});

// 音乐上传 / 删除
const musicUpload = multer({
  storage: multer.diskStorage({
    destination: MUSIC_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.mp3';
      const base = path.basename(file.originalname, path.extname(file.originalname))
        .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80) || 'music';
      cb(null, `${base}${ext}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(file.originalname);
    cb(ok ? null : new Error('仅支持音频 mp3/m4a/wav/ogg/aac/flac'), ok);
  },
});

app.post('/api/admin/music/upload', requireAdmin, musicUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到音频文件' });
  res.json({ ok: true, file: req.file.filename, music: listMusic() });
});

app.post('/api/admin/music/delete', requireAdmin, (req, res) => {
  const file = path.basename(String(req.body.file || ''));
  if (!file) return res.status(400).json({ error: '缺少文件名' });
  try { fs.unlinkSync(path.join(MUSIC_DIR, file)); } catch {}
  const s = getSettings();
  const playlist = (s.musicPlaylist || []).filter(f => f !== file);
  saveSettings({ musicPlaylist: playlist, music: playlist[0] || '' });
  res.json({ ok: true, music: listMusic() });
});

// ---- 导入 zip（后台）----
const zipUpload = multer({ dest: path.join(ROOT, 'data', 'tmp'), limits: { fileSize: 1024 * 1024 * 1024 } });
app.post('/api/admin/import-zip', requireAdmin, zipUpload.single('zip'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到 zip' });
  try {
    const out = execSync(`node "${path.join(ROOT, 'scripts', 'import-zip.js')}" "${req.file.path}"`, { cwd: ROOT, encoding: 'utf8', timeout: 30 * 60 * 1000 });
    fs.rmSync(req.file.path, { force: true });
    res.json({ ok: true, log: out.trim().split('\n').slice(-3) });
  } catch (e) {
    res.status(500).json({ error: '导入失败: ' + (e.message || e) });
  }
});

// ---- 离线导出 ----
app.post('/api/admin/export', requireAdmin, async (req, res) => {
  const settings = getSettings();
  const items = sortItems(db.prepare('SELECT * FROM media').all(), settings);
  if (!items.length) return res.status(400).json({ error: '还没有素材' });

  const pkgName = 'memorial-' + new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(3).toString('hex');
  const pkgDir = path.join(EXPORT_DIR, pkgName);
  fs.mkdirSync(path.join(pkgDir, 'media'), { recursive: true });

  const manifest = {
    title: CONFIG.title, subtitle: CONFIG.subtitle, settings,
    items: [],
  };
  for (const it of items) {
    if (!fs.existsSync(path.join(UPLOAD_DIR, it.filename))) continue;
    fs.copyFileSync(path.join(UPLOAD_DIR, it.filename), path.join(pkgDir, 'media', it.filename));
    manifest.items.push({
      filename: 'media/' + it.filename, kind: it.kind, uploader: it.uploader,
      caption: it.caption, year: it.year, category: categoryOf(it), sort_order: it.sort_order, featured: it.featured,
    });
  }
  const musicFiles = (settings.musicPlaylist && settings.musicPlaylist.length ? settings.musicPlaylist : (settings.music ? [settings.music] : []))
    .filter(f => fs.existsSync(path.join(MUSIC_DIR, f)));
  if (settings.coverImage) {
    const ci = settings.coverImage;
    if (ci.startsWith('main/')) {
      const f = path.basename(ci);
      if (fs.existsSync(path.join(MAIN_DIR, f))) {
        fs.mkdirSync(path.join(pkgDir, 'main'), { recursive: true });
        for (const mf of fs.readdirSync(MAIN_DIR).filter(x => /\.(jpe?g|png|webp)$/i.test(x))) {
          fs.copyFileSync(path.join(MAIN_DIR, mf), path.join(pkgDir, 'main', mf));
        }
        manifest.coverImage = 'main/' + f;
      }
    } else if (ci.startsWith('media/')) {
      const f = path.basename(ci);
      if (fs.existsSync(path.join(UPLOAD_DIR, f))) {
        fs.copyFileSync(path.join(UPLOAD_DIR, f), path.join(pkgDir, 'media', f));
        manifest.coverImage = 'media/' + f;
      }
    }
  }
  if (musicFiles.length) {
    fs.mkdirSync(path.join(pkgDir, 'music'), { recursive: true });
    for (const f of musicFiles) fs.copyFileSync(path.join(MUSIC_DIR, f), path.join(pkgDir, 'music', f));
    manifest.musicFiles = musicFiles.map(f => 'music/' + f);
    manifest.musicFile = manifest.musicFiles[0];
  }
  fs.writeFileSync(path.join(pkgDir, 'manifest.js'), 'window.MANIFEST = ' + JSON.stringify(manifest, null, 2) + ';');

  // 复制离线播放器（offline/ 下的 index.html 是独立可运行的播放页）
  const playerSrc = path.join(OFFLINE_DIR, 'index.html');
  if (fs.existsSync(playerSrc)) fs.copyFileSync(playerSrc, path.join(pkgDir, 'index.html'));

  const zipPath = path.join(EXPORT_DIR, pkgName + '.zip');
  execSync(`cd "${pkgDir}" && zip -qr "${zipPath}" .`);
  fs.rmSync(pkgDir, { recursive: true, force: true });
  res.json({ ok: true, download: '/exports/' + pkgName + '.zip', size: fs.statSync(zipPath).size });
});

app.use('/exports/', express.static(EXPORT_DIR));

// ---- 静态页面 ----
app.use(express.static(path.join(ROOT, 'public')));

app.listen(PORT, () => console.log(`忆·外公 服务已启动: http://127.0.0.1:${PORT}`));
