@echo off
echo メモリ最適化版でツイート検証を実行します...
node --max-old-space-size=8192 --expose-gc check-success-fail.js
pause 