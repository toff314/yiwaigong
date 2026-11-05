#!/usr/bin/env bash
# 用 Suno 生成「追忆叶玉生」的两首音乐。
# 前提：Suno 账号有可用额度，且 hCaptcha 验证能通过。
set -euo pipefail
cd "$(dirname "$0")/.."

SUNO="${SUNO:-cli-anything-suno}"

echo "== 当前额度 =="
$SUNO browse credits || true

echo "== 1/2 生成纯音乐背景 =="
$SUNO clip generate \
  --title "追忆·叶玉生（背景音乐）" \
  --tags "cinematic, ambient, melancholic, gentle piano, soft strings, slow, instrumental, peaceful, remembrance, 60 BPM" \
  --instrumental \
  --wait \
  --download data/music

echo "== 2/2 生成带歌词的追忆歌曲 =="
$SUNO clip generate \
  --title "弯弯的眉毛（献给叶玉生）" \
  --tags "Mandopop ballad, cinematic, warm, melancholic but hopeful, male vocal, Mandarin Chinese, clear diction, acoustic guitar, piano, strings, slow, 68 BPM" \
  --lyrics-file music/叶玉生-追忆歌词.txt \
  --wait \
  --download data/music

echo "完成。请到 data/music/ 下确认 mp3，并在管理后台选择背景音乐。"
echo "如需 LRC 字幕：$SUNO clip lrc <mp3路径> <lrc输出路径>"
