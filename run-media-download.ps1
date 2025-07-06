Write-Host "メモリ最適化版でメディアダウンロードを実行します..." -ForegroundColor Green
node --max-old-space-size=8192 --expose-gc media-check-and-download.js
Read-Host "Enterキーを押して終了" 