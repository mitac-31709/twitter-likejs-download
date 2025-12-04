const fs = require('fs-extra');
const path = require('path');
const { ErrorManager, ERROR_TYPES } = require('./error-manager');

// メモリ使用量を制限するためのバッチサイズ
const BATCH_SIZE = 1000;

// processed-tweets.jsonの読み込み
const processedPath = path.join(__dirname, 'processed-tweets.json');

// 初回実行などでファイルが存在しない場合にも落ちないように安全に読み込む
let processed = {
  successful: {},
  failed: {},
  noMedia: {}
};

try {
  if (fs.existsSync(processedPath)) {
    const loaded = fs.readJSONSync(processedPath);
    processed.successful = loaded.successful || {};
    processed.failed = loaded.failed || {};
    processed.noMedia = loaded.noMedia || {};
  }
} catch (e) {
  console.error(`processed-tweets.json の読み込みに失敗しました: ${e.message}`);
}

const successful = processed.successful || {};

const downloadsDir = path.join(__dirname, 'downloads');

// ディレクトリ一覧を取得（メモリ効率化）
function getDownloadIds() {
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

const allDownloadIds = getDownloadIds();
const notFound = [];
const newlyAdded = [];
const errorManager = new ErrorManager();

function existsTweetJson(tweetId) {
  const tweetDir = path.join(downloadsDir, tweetId);
  const tweetDataPath = path.join(tweetDir, 'tweet-data.json');
  const tweetIdJsonPath = path.join(tweetDir, tweetId + '.json');
  return fs.existsSync(tweetDataPath) || fs.existsSync(tweetIdJsonPath);
}

// バッチ処理でメモリ使用量を制限
function processBatch(items, processor, batchSize = BATCH_SIZE) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = processor(batch);
    results.push(...batchResults);
    
    // ガベージコレクションを促す
    if (global.gc) {
      global.gc();
    }
    
    // 進捗表示
    const progress = Math.min(i + batchSize, items.length);
    console.log(`処理進捗: ${progress}/${items.length} (${Math.round(progress/items.length*100)}%)`);
  }
  return results;
}

// 成功ツイートの検証処理
function validateSuccessfulTweets(tweetIds) {
  const batchNotFound = [];
  
  for (const tweetId of tweetIds) {
    if (!existsTweetJson(tweetId)) {
      batchNotFound.push(tweetId);
      
      // ディレクトリ削除
      const tweetDir = path.join(downloadsDir, tweetId);
      try {
        fs.removeSync(tweetDir);
        console.log(`削除: ${tweetId}`);
      } catch (e) {
        console.log(`削除失敗: ${tweetId} (${e.message})`);
      }
      
      // processed-tweets.jsonからも削除
      delete processed.successful[tweetId];
      
      // エラー登録
      errorManager.addError(tweetId, ERROR_TYPES.NOT_FOUND, { 
        message: 'tweet-data.json または {TweetID}.json が存在しません' 
      });
    } else {
      // tweet-data.json などが存在する場合はエラーをクリア
      if (errorManager.hasError(tweetId)) {
        errorManager.clearError(tweetId);
      }
    }
  }
  
  return batchNotFound;
}

// 新規追加ツイートの検証処理
function validateNewTweets(tweetIds) {
  const batchNewlyAdded = [];
  
  for (const tweetId of tweetIds) {
    if (existsTweetJson(tweetId) && !successful[tweetId]) {
      processed.successful[tweetId] = new Date().toISOString();
      batchNewlyAdded.push(tweetId);
      console.log(`追加: ${tweetId}`);
      
      // エラーをクリア
      if (errorManager.hasError(tweetId)) {
        errorManager.clearError(tweetId);
      }
    }
  }
  
  return batchNewlyAdded;
}

// メイン処理
async function main() {
  console.log('=== ツイート検証処理開始 ===');
  console.log(`成功ツイート数: ${Object.keys(successful).length}`);
  console.log(`ダウンロードディレクトリ数: ${allDownloadIds.length}`);
  
  // バッチモードを有効化
  errorManager.setBatchMode(true);
  
  // 成功ツイートの検証（バッチ処理）
  const successfulIds = Object.keys(successful);
  console.log('\n成功ツイートの検証中...');
  const batchNotFound = processBatch(successfulIds, validateSuccessfulTweets);
  notFound.push(...batchNotFound);
  
  // 新規ツイートの検証（バッチ処理）
  console.log('\n新規ツイートの検証中...');
  const batchNewlyAdded = processBatch(allDownloadIds, validateNewTweets);
  newlyAdded.push(...batchNewlyAdded);
  
  // エラーファイルを保存
  console.log('\nエラーファイルを保存中...');
  errorManager.saveErrors();
  
  // processed-tweets.jsonを上書き保存
  console.log('processed-tweets.jsonを保存中...');
  fs.writeJSONSync(processedPath, processed, { spaces: 2 });
  
  // 結果表示
  console.log('\n=== 処理結果 ===');
  if (notFound.length === 0) {
    console.log('全ての成功ツイートにtweet-data.jsonまたは{TweetID}.jsonが存在します。');
  } else {
    console.log('成功となっているがtweet-data.jsonまたは{TweetID}.jsonが存在しないツイートID:');
    notFound.forEach(id => console.log(id));
    console.log(`合計: ${notFound.length}件`);
  }

  if (newlyAdded.length > 0) {
    console.log('\ntweet-data.jsonまたは{TweetID}.jsonが存在するがJSONに記録されていなかったツイートID:');
    newlyAdded.forEach(id => console.log(id));
    console.log(`追加合計: ${newlyAdded.length}件`);
  }
  
  console.log('\n=== 処理完了 ===');
}

// エラーハンドリング付きで実行
main().catch(error => {
  console.error('処理中にエラーが発生しました:', error);
  process.exit(1);
}); 