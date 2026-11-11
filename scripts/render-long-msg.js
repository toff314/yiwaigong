// 把张曦的长留言分页渲染成专题卡（黑金风格，每屏最多8行）
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'tmp', 'video-assets', 'msgs');
const W = 1920, H = 1080;
const SERIF = "'Noto Serif CJK SC','Songti SC',serif";
const GOLD = '#c9a86a', INK = '#e8e2d5', MUTED = '#9a9284';
const FONT = 36, LINE_H = 68, MAX_LINES = 8, MAX_W = 1200, LEFT = (W - MAX_W) / 2;

function textWidth(s, size) {
  let w = 0;
  for (const ch of s) w += /[\x20-\x7e]/.test(ch) ? size * (ch === ' ' ? 0.3 : 0.52) : size;
  return w;
}
function wrapPara(s) {
  const lines = [];
  let cur = '';
  for (const ch of s) {
    if (textWidth(cur + ch, FONT) > MAX_W && cur) { lines.push(cur); cur = ch; }
    else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

const DEFS = `
  <radialGradient id="bg" cx="50%" cy="42%" r="75%">
    <stop offset="0%" stop-color="#242019"/><stop offset="55%" stop-color="#141210"/><stop offset="100%" stop-color="#0a0907"/>
  </radialGradient>`;
const chrys = (cx, cy, s, op) => `<g stroke="${GOLD}" fill="none" opacity="${op}" transform="translate(${cx},${cy})">
  <circle r="${s * 0.08}"/>${[0, 45].map(a => `<g transform="rotate(${a})">
  <ellipse cx="0" cy="${-s * 0.28}" rx="${s * 0.12}" ry="${s * 0.24}"/><ellipse cx="0" cy="${s * 0.28}" rx="${s * 0.12}" ry="${s * 0.24}"/>
  <ellipse cx="${-s * 0.28}" cy="0" rx="${s * 0.24}" ry="${s * 0.12}"/><ellipse cx="${s * 0.28}" cy="0" rx="${s * 0.24}" ry="${s * 0.12}"/></g>`).join('')}</g>`;

const db = new Database(path.join(ROOT, 'data', 'db.sqlite'));
const row = db.prepare('select id, name, content from messages where name = ? order by length(content) desc limit 1').get('张曦');
db.close();
if (!row) { console.error('没找到张曦的留言'); process.exit(1); }

// 分页：按段落装屏，段落超长则按行拆开
const pages = [];
let cur = [];
for (const para of row.content.split('\n').map(s => s.trim()).filter(Boolean)) {
  const lines = wrapPara(para);
  if (cur.length + lines.length > MAX_LINES && cur.length) { pages.push(cur); cur = []; }
  for (const line of lines) {
    if (cur.length >= MAX_LINES) { pages.push(cur); cur = []; }
    cur.push(line);
  }
}
if (cur.length) pages.push(cur);
console.log(`长留言 ${row.content.length} 字，分 ${pages.length} 屏`);

(async () => {
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p];
    const bodyY = 380;
    const lineEls = lines.map((t, i) =>
      `<text x="${LEFT}" y="${bodyY + i * LINE_H}" font-family="${SERIF}" font-size="${FONT}" fill="${INK}">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${DEFS}</defs>
      <rect width="${W}" height="${H}" fill="url(#bg)"/>
      <rect x="86" y="48" width="${W - 172}" height="${H - 96}" fill="none" stroke="#b99757" stroke-opacity=".35"/>
      <g font-family="${SERIF}" text-anchor="middle">
        ${chrys(960, 158, 40, 0.8)}
        <text x="960" y="244" font-size="34" font-weight="600" fill="${INK}" letter-spacing="14">忆叶公玉生老大人</text>
        <text x="960" y="298" font-size="26" fill="${GOLD}" letter-spacing="8">张曦 · 写给外公</text>
        <rect x="860" y="330" width="200" height="2" fill="${GOLD}" opacity=".6"/>
        <text x="${W / 2 + MAX_W / 2}" y="${H - 96}" text-anchor="end" font-size="26" fill="${GOLD}" letter-spacing="2">— 张曦</text>
        <text x="960" y="${H - 96}" font-size="24" fill="${MUTED}" letter-spacing="8">${p + 1} / ${pages.length}</text>
      </g>
      <g>${lineEls}</g>
    </svg>`;
    const out = path.join(OUT, `special-${String(p + 1).padStart(2, '0')}.jpg`);
    await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(out);
    console.log(out);
  }
  fs.writeFileSync(path.join(OUT, 'special-count.txt'), String(pages.length));
})();
