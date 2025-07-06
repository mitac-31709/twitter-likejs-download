const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { ErrorManager, ERROR_TYPES, determineErrorType } = require('./error-manager');

const downloadsDir = path.join(__dirname, 'downloads');
const MAX_CONCURRENT_DOWNLOADS = 5; // 同時ダウンロード数を制限
const BATCH_SIZE = 100; // バッチサイズを小さくしてメモリ使用量を制限

// エラー管理インスタンス
const errorManager = new ErrorManager();

// 並列制御用のクラス
class ConcurrencyLimiter {
  constructor(maxConcurrency) {
    this.maxConcurrency = maxConcurrency;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.running >= this.maxConcurrency) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        this.queue.shift()();
      }
    }
  }
}

const limiter = new ConcurrencyLimiter(MAX_CONCURRENT_DOWNLOADS);

// 指定URLからファイルをダウンロード
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    mod.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      // エラー時はファイルを削除
      fs.unlink(dest, () => reject(err));
    });
  });
}

// メディアURLから保存ファイル名を推測
function getFilenameFromUrl(url) {
  try {
    const u = new URL(url);
    return path.basename(u.pathname);
  } catch {
    return null;
  }
}

// ディレクトリ一覧を取得（メモリ効率化）
function getTweetIds() {
  const ids = [];
  try {
    const entries = fs.readdirSync(downloadsDir);
    for (const entry of entries) {
      const fullPath = path.join(downloadsDir, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        ids.push(entry);
      }
    }
  } catch (error) {
    console.error(`downloadsディレクトリの読み込みエラー: ${error.message}`);
  }
  return ids;
}

// バッチ処理でメモリ使用量を制限
function processBatch(items, processor, batchSize = BATCH_SIZE) {
  return new Promise(async (resolve) => {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      console.log(`バッチ処理中: ${i + 1}-${Math.min(i + batchSize, items.length)}/${items.length}`);
      
      const batchResults = await Promise.all(batch.map(processor));
      results.push(...batchResults);
      
      // ガベージコレクションを促す
      if (global.gc) {
        global.gc();
      }
      
      // 進捗表示
      const progress = Math.min(i + batchSize, items.length);
      console.log(`処理進捗: ${progress}/${items.length} (${Math.round(progress/items.length*100)}%)`);
    }
    resolve(results);
  });
}

async function processTweetDir(tweetId) {
  // エラーが発生しているツイートの処理
  if (errorManager.hasError(tweetId)) {
    const error = errorManager.getError(tweetId);
    const retryCount = error.retry_count || 0;
    
    // 再試行回数が3回未満の場合は再試行、それ以上はスキップ
    if (retryCount < 3) {
      console.log(`エラーが発生したツイートを再試行: ${tweetId} (${error.type}, 再試行回数: ${retryCount})`);
    } else {
      console.log(`エラーが発生したツイートをスキップ: ${tweetId} (${error.type}, 再試行回数上限: ${retryCount})`);
      return { tweetId, status: 'skipped', reason: 'max_retry_exceeded', retryCount };
    }
  }

  const tweetDir = path.join(downloadsDir, tweetId);
  const tweetDataPath = path.join(tweetDir, 'tweet-data.json');
  const tweetIdJsonPath = path.join(tweetDir, tweetId + '.json');
  let jsonPath = null;
  
  if (fs.existsSync(tweetDataPath)) {
    jsonPath = tweetDataPath;
  } else if (fs.existsSync(tweetIdJsonPath)) {
    jsonPath = tweetIdJsonPath;
  } else {
    // JSONファイルが見つからない場合はエラーとして記録
    errorManager.addError(tweetId, ERROR_TYPES.JSON_PARSE_ERROR, { 
      message: 'JSON file not found',
      paths: [tweetDataPath, tweetIdJsonPath],
      tweetId: tweetId
    });
    console.log(`JSONファイルが見つかりません: ${tweetId}`);
    return { tweetId, status: 'error', reason: 'json_not_found' };
  }
  
  let data;
  try {
    data = fs.readJSONSync(jsonPath);
  } catch (e) {
    errorManager.addError(tweetId, ERROR_TYPES.JSON_PARSE_ERROR, { 
      message: e.message,
      path: jsonPath,
      tweetId: tweetId
    });
    console.log(`JSON読み込み失敗: ${jsonPath}`);
    return { tweetId, status: 'error', reason: 'json_parse_error' };
  }
  
  if (!data.media || !Array.isArray(data.media)) {
    return { tweetId, status: 'skipped', reason: 'no_media' };
  }
  
  const downloadTasks = [];
  let downloadCount = 0;
  let errorCount = 0;
  let successCount = 0;
  let skipCount = 0;
  
  for (const media of data.media) {
    if (media.type === 'photo' && media.image) {
      const filename = getFilenameFromUrl(media.image);
      if (!filename) {
        console.log(`ファイル名を取得できません: ${media.image}`);
        skipCount++;
        continue;
      }
      const filePath = path.join(tweetDir, filename);
      if (!fs.existsSync(filePath)) {
        console.log(`ダウンロード: ${media.image} → ${filePath}`);
        downloadTasks.push(
          limiter.run(() => downloadFile(media.image, filePath))
            .then(() => {
              console.log(`成功: ${media.image}`);
              downloadCount++;
              successCount++;
              // 成功した場合はエラーを削除（もし存在すれば）
              errorManager.removeError(tweetId);
            })
            .catch(e => {
              console.log(`失敗: ${media.image} - ${e.message}`);
              errorCount++;
              // エラーを記録
              const errorType = determineErrorType(e);
              errorManager.addError(tweetId, errorType, { 
                url: media.image,
                message: e.message,
                mediaType: 'photo',
                filename: filename,
                filePath: filePath,
                tweetId: tweetId
              });
              // 失敗時はファイルを削除（念のため）
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
              }
            })
        );
      } else {
        console.log(`既に存在: ${filePath}`);
        skipCount++;
      }
    } else if (media.type === 'video' && Array.isArray(media.videos)) {
      // 一番高画質の動画を選ぶ
      const sorted = media.videos.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (sorted.length > 0) {
        const url = sorted[0].url;
        const filename = getFilenameFromUrl(url);
        if (!filename) {
          console.log(`動画ファイル名を取得できません: ${url}`);
          skipCount++;
          continue;
        }
        const filePath = path.join(tweetDir, filename);
        if (!fs.existsSync(filePath)) {
          console.log(`ダウンロード: ${url} → ${filePath}`);
          downloadTasks.push(
            limiter.run(() => downloadFile(url, filePath))
              .then(() => {
                console.log(`成功: ${url}`);
                downloadCount++;
                successCount++;
                // 成功した場合はエラーを削除（もし存在すれば）
                errorManager.removeError(tweetId);
              })
              .catch(e => {
                console.log(`失敗: ${url} - ${e.message}`);
                errorCount++;
                // エラーを記録
                const errorType = determineErrorType(e);
                errorManager.addError(tweetId, errorType, { 
                  url: url,
                  message: e.message,
                  mediaType: 'video',
                  filename: filename,
                  filePath: filePath,
                  bitrate: sorted[0].bitrate,
                  tweetId: tweetId
                });
                // 失敗時はファイルを削除（念のため）
                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                }
              })
          );
        } else {
          console.log(`既に存在: ${filePath}`);
          skipCount++;
        }
      } else {
        console.log(`動画URLが見つかりません: ${tweetId}`);
        skipCount++;
      }
      // サムネイルも保存
      if (media.cover) {
        const coverName = getFilenameFromUrl(media.cover);
        if (coverName) {
          const coverPath = path.join(tweetDir, coverName);
          if (!fs.existsSync(coverPath)) {
            console.log(`ダウンロード: ${media.cover} → ${coverPath}`);
            downloadTasks.push(
              limiter.run(() => downloadFile(media.cover, coverPath))
                .then(() => {
                  console.log(`成功: ${media.cover}`);
                  downloadCount++;
                  successCount++;
                  // 成功した場合はエラーを削除（もし存在すれば）
                  errorManager.removeError(tweetId);
                })
                .catch(e => {
                  console.log(`失敗: ${media.cover} - ${e.message}`);
                  errorCount++;
                  // エラーを記録
                  const errorType = determineErrorType(e);
                  errorManager.addError(tweetId, errorType, { 
                    url: media.cover,
                    message: e.message,
                    mediaType: 'video_cover',
                    filename: coverName,
                    filePath: coverPath,
                    tweetId: tweetId
                  });
                  // 失敗時はファイルを削除（念のため）
                  if (fs.existsSync(coverPath)) {
                    fs.unlinkSync(coverPath);
                  }
                })
            );
          } else {
            console.log(`既に存在: ${coverPath}`);
            skipCount++;
          }
        } else {
          console.log(`サムネイルファイル名を取得できません: ${media.cover}`);
          skipCount++;
        }
      }
    } else {
      console.log(`未対応のメディアタイプ: ${media.type}`);
      skipCount++;
    }
  }
  
  if (downloadTasks.length > 0) {
    await Promise.all(downloadTasks);
  }
  
  return { 
    tweetId, 
    status: 'completed', 
    downloads: downloadCount, 
    errors: errorCount,
    successes: successCount,
    skips: skipCount
  };
}

async function main() {
  console.log('=== メディアチェック・ダウンロード処理開始 ===');
  
  // バッチモードを有効化
  errorManager.setBatchMode(true);
  
  const tweetIds = getTweetIds();
  console.log(`処理対象ツイート数: ${tweetIds.length}`);
  
  if (tweetIds.length === 0) {
    console.log('処理対象のツイートがありません。');
    return;
  }
  
  // バッチ処理でツイートを処理
  const results = await processBatch(tweetIds, processTweetDir);
  
  // エラーファイルを保存
  console.log('\nエラーファイルを保存中...');
  errorManager.saveErrors();
  
  // 結果統計
  const stats = {
    total: results.length,
    completed: results.filter(r => r.status === 'completed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    error: results.filter(r => r.status === 'error').length,
    totalDownloads: results.reduce((sum, r) => sum + (r.downloads || 0), 0),
    totalErrors: results.reduce((sum, r) => sum + (r.errors || 0), 0),
    totalSuccesses: results.reduce((sum, r) => sum + (r.successes || 0), 0),
    totalSkips: results.reduce((sum, r) => sum + (r.skips || 0), 0)
  };
  
  console.log('\n=== 処理結果 ===');
  console.log(`総処理数: ${stats.total}`);
  console.log(`完了: ${stats.completed}`);
  console.log(`スキップ: ${stats.skipped}`);
  console.log(`エラー: ${stats.error}`);
  console.log(`ダウンロード成功: ${stats.totalSuccesses}`);
  console.log(`ダウンロード失敗: ${stats.totalErrors}`);
  console.log(`ファイルスキップ: ${stats.totalSkips}`);
  console.log(`総ダウンロード試行: ${stats.totalDownloads}`);
  
  // エラー統計の表示
  errorManager.printSummary();
  
  // エラーがある場合の対処法を表示
  const errorStats = errorManager.getStatistics();
  if (errorStats.total_errors > 0) {
    console.log('\n=== エラー対処法 ===');
    console.log('エラーが発生したツイートの再試行:');
    console.log('  node error-utils.js retry <tweetId>');
    console.log('エラーリストの確認:');
    console.log('  node error-utils.js list');
    console.log('エラータイプ別の確認:');
    console.log('  node error-utils.js type <errorType>');
    console.log('全エラーのクリア:');
    console.log('  node error-utils.js clear-all');
  }
  
  console.log('\n=== 処理完了 ===');
}

// エラーハンドリング付きで実行
main().catch(error => {
  console.error('処理中にエラーが発生しました:', error);
  process.exit(1);
}); 