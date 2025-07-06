@echo off
echo メモリ最適化版でメディアダウンロードを実行します...
node --max-old-space-size=8192 --expose-gc media-check-and-download.js
pause 