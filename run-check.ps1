Write-Host "メモリ最適化版でツイート検証を実行します..." -ForegroundColor Green
node --max-old-space-size=8192 --expose-gc check-success-fail.js
Read-Host "Enterキーを押して終了" 