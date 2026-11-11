#!/usr/bin/env node
// 生成「忆·外公」主图（横版 + 竖版），输出到 data/main/
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.resolve(__dirname, '..', 'data', 'main');
fs.mkdirSync(OUT, { recursive: true });

function chrys(cx, cy, r, opacity) {
  return `<g stroke="#d8b878" stroke-width="${Math.max(1, r * 0.012)}" fill="none" opacity="${opacity}" transform="translate(${cx},${cy})">
    <circle cx="0" cy="0" r="${r * 0.08}"/>
    ${[0, 45, 90, 135].map(a => `<g transform="rotate(${a})">
      <ellipse cx="0" cy="${-r * 0.28}" rx="${r * 0.12}" ry="${r * 0.24}"/>
      <ellipse cx="0" cy="${r * 0.28}" rx="${r * 0.12}" ry="${r * 0.24}"/>
      <ellipse cx="${-r * 0.28}" cy="0" rx="${r * 0.24}" ry="${r * 0.12}"/>
      <ellipse cx="${r * 0.28}" cy="0" rx="${r * 0.24}" ry="${r * 0.12}"/>
    </g>`).join('')}
  </g>`;
}

function svg(w, h) {
  const portrait = h > w;
  const cx = w / 2;
  const title = portrait ? 132 : 156;
  const name = portrait ? 64 : 74;
  const years = portrait ? 44 : 50;
  const verse = portrait ? 28 : 32;
  const top = portrait ? h * 0.18 : h * 0.16;
  const gap = portrait ? 1.0 : 0.9;
  const frame = Math.min(w, h) * 0.045;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <radialGradient id="bg" cx="50%" cy="42%" r="75%">
        <stop offset="0%" stop-color="#242019"/>
        <stop offset="55%" stop-color="#141210"/>
        <stop offset="100%" stop-color="#0a0907"/>
      </radialGradient>
      <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#9d7f45"/>
        <stop offset="45%" stop-color="#e8c987"/>
        <stop offset="100%" stop-color="#9d7f45"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    ${chrys(cx, portrait ? h * 0.44 : h * 0.48, Math.min(w, h) * 0.34, 0.11)}
    <rect x="${frame}" y="${frame}" width="${w - frame * 2}" height="${h - frame * 2}" fill="none" stroke="#b99757" stroke-opacity=".35"/>
    <rect x="${frame + 10}" y="${frame + 10}" width="${w - frame * 2 - 20}" height="${h - frame * 2 - 20}" fill="none" stroke="#b99757" stroke-opacity=".12"/>
    <g font-family="'Noto Serif CJK SC','Songti SC',serif" text-anchor="middle">
      <text x="${cx}" y="${top - title * 0.85}" fill="#c9a86a" fill-opacity=".75" font-size="${verse * 0.9}" letter-spacing="${verse * 0.6}">追 思</text>
      <text x="${cx}" y="${top + title * 0.15}" fill="#fffdf6" font-size="${title * 0.6}" font-weight="600" letter-spacing="${title * 0.05}">忆叶公玉生老大人</text>
      <line x1="${cx - w * 0.16}" y1="${top + title * 0.55}" x2="${cx + w * 0.16}" y2="${top + title * 0.55}" stroke="url(#gold)" stroke-opacity=".7"/>
      <text x="${cx}" y="${top + title * 0.55 + name * 1.25}" fill="#f2ead8" font-size="${name}" letter-spacing="${name * 0.18}">叶玉生</text>
      <text x="${cx}" y="${top + title * 0.55 + name * 1.25 + years * 1.55}" fill="#e8c987" font-size="${years}" letter-spacing="${years * 0.22}">1938 — 2026</text>
      <text x="${cx}" y="${h - gap * frame - verse * 1.4}" fill="#cfc5b3" fill-opacity=".9" font-size="${verse}" letter-spacing="${verse * 0.28}">音容宛在 · 风范长存</text>
    </g>
  </svg>`;
}

(async () => {
  for (const [name, w, h] of [['main-cover-landscape', 1920, 1080], ['main-cover-portrait', 1080, 1920]]) {
    const out = path.join(OUT, name + '.jpg');
    await sharp(Buffer.from(svg(w, h))).jpeg({ quality: 92 }).toFile(out);
    console.log(out, fs.statSync(out).size);
  }
})().catch(e => { console.error(e); process.exit(1); });
