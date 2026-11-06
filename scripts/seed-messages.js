#!/usr/bin/env node
// 给家人们预置默认留言（仅当留言表为空时执行）
const path = require('path');
const Database = require('better-sqlite3');
const { FAMILY } = require('../lib/family');

const db = new Database(path.resolve(__dirname, '..', 'data', 'db.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`);

const seeded = db.prepare("SELECT value FROM stats WHERE key='messages_seeded'").get();
if (seeded && !process.argv.includes('--force')) {
  console.log('已经预置过默认留言，跳过');
  process.exit(0);
}

const SEEDS = {
  '黄爱平': [
    '爸，家里都挺好的，您别牵挂。',
    '每次回去，还是习惯先往您常坐的位置看一眼。',
  ],
  '张孟': [
    '外公，您教我的那些话，我都记着。',
    '昨天路过您爱去的那家小店，站了很久。',
  ],
  '叶文桂': [
    '爸，天冷了，您在那边要记得添衣。',
    '您爱吃的菜，我们现在也会做了。',
  ],
  '黄学武': [
    '外公，院子里的花开得挺好。',
    '想起您坐在门口晒太阳，好像还是昨天。',
  ],
  '叶兰': [
    '爸，我们都挺好的，就是想您。',
    '您走以后，家里安静了很多。',
  ],
  '饶新荣': [
    '外公，您放心，我们会把家照顾好。',
    '有些话没来得及说，一直放在心里。',
  ],
  '叶玲': [
    '爸，今天又翻到您的照片，看了很久。',
    '您笑起来的样子，我们谁都没忘。',
  ],
  '黄景如': [
    '外公，等我再回去，给您带您爱喝的茶。',
    '您以前总问我累不累，现在没人问了。',
  ],
  '叶曼及': [
    '外公，您在那边的日子，也要好好吃饭。',
    '每次家里聚齐，都会想起您坐在中间。',
  ],
  '张旭': [
    '外公，您教我做人的道理，我一直在用。',
    '想再陪您下一盘棋。',
  ],
  '张曦': [
    '外公，这些天总觉得您还在，没走远。',
    '您放心，我们会常回去看看。',
  ],
  '黄迪': [
    '外公，我最近挺好的，您别担心我。',
    '您说的那句“慢慢来”，我现在懂了。',
  ],
  '饶甲强': [
    '外公，家里的灯还亮着，等您回来看看。',
    '您留下的那些老物件，我们都收好了。',
  ],
  '饶苗': [
    '外公，今天做了您爱吃的红烧肉。',
    '想您的时候，就翻翻相册，跟您说说话。',
  ],
  '黄德安': [
    '外公，您一辈子辛苦了，歇歇吧。',
    '您的儿孙都长大了，您别挂念。',
  ],
  '黄蜜': [
    '外公，您总把好吃的留给我们，现在我们给您留着。',
    '梦里见到您，还是那么慈祥。',
  ],
  '刘露': [
    '外公，谢谢您一直这么疼我。',
    '您的好，我们一辈子记着。',
  ],
  '詹彪': [
    '外公，家里一切都好，您安心。',
    '想起您喊我名字的声音，还是那么清楚。',
  ],
  '王燕': [
    '外公，您教我们的话，我们会讲给孩子听。',
    '您辛苦了一辈子，我们会好好过日子。',
  ],
  '汪玲': [
    '外公，您以前总叮嘱我多穿点，我都记着呢。',
    '有您在的家，才像家。',
  ],
  '袁兀': [
    '外公，您放心，我们会把这个家撑起来。',
    '想您了，就点一盏灯，跟您说几句话。',
  ],
};

const entries = [];
for (let round = 0; round < 2; round++) {
  for (const name of FAMILY) {
    const list = SEEDS[name] || [];
    if (list[round]) entries.push({ name, content: list[round] });
  }
}

const now = Date.now();
const span = 6 * 24 * 60 * 60 * 1000;
const insert = db.prepare('INSERT INTO messages (name, content, created_at) VALUES (?,?,?)');
db.transaction(() => {
  entries.forEach((e, i) => {
    const t = now - span + Math.round(span * i / Math.max(1, entries.length - 1));
    insert.run(e.name, e.content, t);
  });
  db.prepare("INSERT INTO stats (key,value) VALUES ('messages_seeded',1) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
})();

console.log(`已添加 ${entries.length} 条默认留言`);
