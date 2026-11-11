#!/usr/bin/env node
// 渲染视频所需文字素材：每条素材的字幕条、分类标题卡、留言卡。
// 输出到 data/tmp/video-assets/，风格与网页播放页一致（黑底金字、宋体系）。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'data', 'db.sqlite');
const OUT = path.join(ROOT, 'data', 'tmp', 'video-assets');
const W = 1920, H = 1080;
const SERIF = "'Noto Serif CJK SC','Songti SC',serif";
const GOLD = '#c9a86a', INK = '#e8e2d5', MUTED = '#9a9284';

function sh(cmd, args) { return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
const q = sql => JSON.parse(sh('sqlite3', ['-json', DB, sql]));

// 估算文字宽度（CJK 全宽 = fontSize，ASCII ≈ 0.52，空格 ≈ 0.3）
function textWidth(s, size) {
  let w = 0;
  for (const ch of s) w += /[\x20-\x7e]/.test(ch) ? size * (ch === ' ' ? 0.3 : 0.52) : size;
  return w;
}
function wrapText(s, size, maxW, maxLines) {
  const lines = [];
  let cur = '';
  for (const ch of s) {
    if (textWidth(cur + ch, size) > maxW && cur) { lines.push(cur); cur = ch; }
    else cur += ch;
    if (lines.length === maxLines) break;
  }
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (textWidth(last + '…', size) > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  } else if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

const BG = (() => {
  const frame = Math.min(W, H) * 0.045;
  return `
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect x="${frame}" y="${frame}" width="${W - frame * 2}" height="${H - frame * 2}" fill="none" stroke="#b99757" stroke-opacity=".35"/>
    <rect x="${frame + 10}" y="${frame + 10}" width="${W - frame * 2 - 20}" height="${H - frame * 2 - 20}" fill="none" stroke="#b99757" stroke-opacity=".12"/>`;
})();
const DEFS = `
    <radialGradient id="bg" cx="50%" cy="42%" r="75%">
      <stop offset="0%" stop-color="#242019"/>
      <stop offset="55%" stop-color="#141210"/>
      <stop offset="100%" stop-color="#0a0907"/>
    </radialGradient>
    <linearGradient id="card" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e1b17"/>
      <stop offset="100%" stop-color="#181512"/>
    </linearGradient>
    <linearGradient id="goldline" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#9d7f45"/>
      <stop offset="50%" stop-color="#e8c987"/>
      <stop offset="100%" stop-color="#9d7f45"/>
    </linearGradient>`;
const svgDoc = inner => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${DEFS}</defs>${inner}</svg>`;
const chrys = (cx, cy, s, op) => `
  <g stroke="${GOLD}" fill="none" opacity="${op}" transform="translate(${cx},${cy})">
    <circle r="${s * 0.08}"/>
    ${[0, 45].map(a => `<g transform="rotate(${a})">
      <ellipse cx="0" cy="${-s * 0.28}" rx="${s * 0.12}" ry="${s * 0.24}"/>
      <ellipse cx="0" cy="${s * 0.28}" rx="${s * 0.12}" ry="${s * 0.24}"/>
      <ellipse cx="${-s * 0.28}" cy="0" rx="${s * 0.24}" ry="${s * 0.12}"/>
      <ellipse cx="${s * 0.28}" cy="0" rx="${s * 0.24}" ry="${s * 0.12}"/>
    </g>`).join('')}
  </g>`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'caps'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'titles'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'msgs'), { recursive: true });

  // ---- 1. 每条素材的字幕条（透明 PNG，底部叠加）----
  const media = q("select id, caption, uploader from media where kind in ('photo','video')");
  for (const m of media) {
    const size = 34;
    const lines = wrapText(m.caption || '', size, 1440, 2);
    const uploader = (m.uploader || '').trim();
    const boxH = 18 + lines.length * 46 + (uploader ? 44 : 8) + 14;
    const lineEls = lines.map((t, i) =>
      `<text x="960" y="${18 + 34 + i * 46}" text-anchor="middle" font-family="${SERIF}" font-size="${size}" fill="${INK}" letter-spacing="1">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`).join('');
    const whoEl = uploader ? `<text x="960" y="${18 + lines.length * 46 + 24}" text-anchor="middle" font-family="${SERIF}" font-size="26" fill="${GOLD}" letter-spacing="2">— ${uploader.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${boxH}">
      <rect x="180" y="4" width="1560" height="${boxH - 8}" rx="14" fill="rgba(14,12,10,.72)" stroke="${GOLD}" stroke-opacity=".3"/>
      ${lineEls}${whoEl}
    </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, 'caps', `cap-${m.id}.png`));
  }
  console.log(`字幕条 ${media.length} 张`);

  // ---- 2. 分类标题卡（编号按播放顺序 categoryOrder）----
  const CAT_ORDER = JSON.parse(q("select value from settings where key='categoryOrder'")[0].value);
  const present = q("select distinct category from media").map(r => r.category);
  const cats = CAT_ORDER.filter(c => present.includes(c));
  const cnNum = ['一', '二', '三', '四', '五', '六', '七', '八'];
  for (let i = 0; i < cats.length; i++) {
    const svg = svgDoc(`
      ${BG}
      <g font-family="${SERIF}" text-anchor="middle">
        <text x="960" y="200" font-size="34" fill="${GOLD}" fill-opacity=".75" letter-spacing="26">追 思</text>
        ${chrys(960, 400, 150, 0.16)}
        <text x="960" y="580" font-size="190" font-weight="600" fill="#fffdf6" letter-spacing="60">${cats[i]}</text>
        <rect x="760" y="650" width="400" height="2" fill="url(#goldline)" opacity=".7"/>
        <text x="960" y="740" font-size="40" fill="#f2ead8" letter-spacing="14">第${cnNum[i]}部分 · 共${cnNum[cats.length - 1]}部分</text>
        <text x="960" y="968" font-size="30" fill="${MUTED}" letter-spacing="10">音容宛在 · 风范长存</text>
      </g>`);
    await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(path.join(OUT, 'titles', `title-${i}.jpg`));
  }
  fs.writeFileSync(path.join(OUT, 'titles', 'map.json'), JSON.stringify(cats));
  console.log(`标题卡 ${cats.length} 张: ${cats.join(' ')}`);

  // ---- 3. 留言卡（仿留言墙样式）----
  const msgs = q("select id, name, content from messages order by id");
  const mSize = 44;
  for (const m of msgs) {
    const lines = wrapText(m.content || '', mSize, 1060, 4);
    const cardW = 1240;
    const cardH = 60 + lines.length * 88 + 70 + 60;
    const y0 = (H - cardH) / 2 + 30;
    const lineEls = lines.map((t, i) =>
      `<text x="960" y="${y0 + 60 + 44 + i * 88}" text-anchor="middle" font-family="${SERIF}" font-size="${mSize}" fill="${INK}" letter-spacing="2">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`).join('');
    const svg = svgDoc(`
      ${BG}
      <g font-family="${SERIF}" text-anchor="middle">
        ${chrys(960, 150, 44, 0.85)}
        <text x="960" y="250" font-size="42" font-weight="600" fill="${INK}" letter-spacing="18">忆叶公玉生老大人</text>
        <rect x="${(W - cardW) / 2}" y="${y0}" width="${cardW}" height="${cardH}" rx="12" fill="url(#card)" stroke="${GOLD}" stroke-opacity=".25"/>
        ${lineEls}
        <text x="${(W + cardW) / 2 - 70}" y="${y0 + cardH - 44}" text-anchor="end" font-size="30" fill="${GOLD}" letter-spacing="2">— ${(m.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>
        <text x="960" y="1000" font-size="30" fill="${MUTED}" letter-spacing="10">他们想对您说的话</text>
      </g>`);
    await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(path.join(OUT, 'msgs', `msg-${m.id}.jpg`));
  }
  console.log(`留言卡 ${msgs.length} 张`);
  console.log('全部素材完成');
})().catch(e => { console.error(e); process.exit(1); });
