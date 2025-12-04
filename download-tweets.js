const fs = require('fs-extra');
const path = require('path');
const { TwitterDL } = require('twitter-downloader');
const { ErrorManager, ERROR_TYPES, determineErrorType } = require('./error-manager');

// 設定ファイルのパス
const CONFIG_FILE_PATH = path.join(__dirname, 'config.json');

// 設定
let CONFIG = {
  likeJsPath: path.join(__dirname, 'like.js'),
  processedTweetsFile: path.join(__dirname, 'processed-tweets.json'),
  outputDir: path.join(__dirname, 'downloads'),
  logFile: path.join(__dirname, 'download-log.txt'),
  // 一度に処理するツイート数の制限（レート制限対策）
  batchSize: 50,
  // バッチ間の待機時間（ミリ秒）
  batchDelay: 5000,
  // レート制限時の待機時間（ミリ秒）- デフォルトで15分
  rateLimitWaitTime: 15 * 60 * 1000,
  // レート制限時の最大再試行回数
  maxRateLimitRetries: 3
};

// エラー管理インスタンス
const errorManager = new ErrorManager();

// 設定ファイルから設定を読み込む
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const configData = fs.readJSONSync(CONFIG_FILE_PATH);
      
      // ダウンロード設定を適用
      if (configData.downloadSettings) {
        CONFIG.batchSize = configData.downloadSettings.batchSize || CONFIG.batchSize;
        CONFIG.batchDelay = configData.downloadSettings.batchDelay || CONFIG.batchDelay;
        CONFIG.rateLimitWaitTime = configData.downloadSettings.rateLimitWaitTime || CONFIG.rateLimitWaitTime;
        CONFIG.maxRateLimitRetries = configData.downloadSettings.maxRateLimitRetries || CONFIG.maxRateLimitRetries;
      }
      
      return true;
    }
  } catch (error) {
    console.error(`設定ファイルの読み込みに失敗しました: ${error.message}`);
  }
  return false;
}

// ログ関数
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  fs.appendFileSync(CONFIG.logFile, logMessage);
}

// twitter-media-downloader のASCIIアートなど、ノイズの多い出力を整形するヘルパー
function formatErrorOutput(rawOutput) {
  if (!rawOutput) return '';
  const lines = rawOutput
    .toString()
    .split(/\r?\n/)
    // 空行と純粋な装飾行(記号ばかり)を落とす
    .filter(line => line.trim() && /[a-zA-Z0-9ぁ-んァ-ン一-龠]/.test(line));

  // 有効な行がなければ空文字を返す
  if (lines.length === 0) return '';

  // 先頭数行だけを採用し、ログを暴走させない
  const MAX_LINES = 5;
  const sliced = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) {
    sliced.push(`... (${lines.length - MAX_LINES} 行 省略)`);
  }
  return sliced.join(' / ');
}

// 処理済みツイートの読み込み
async function loadProcessedTweets() {
  try {
    if (await fs.pathExists(CONFIG.processedTweetsFile)) {
      return await fs.readJSON(CONFIG.processedTweetsFile);
    }
  } catch (error) {
    log(`処理済みツイートファイルの読み込みに失敗しました: ${error.message}`);
  }
  return { successful: {}, failed: {}, noMedia: {} };
}

// 処理済みツイートの保存
async function saveProcessedTweets(processed) {
  try {
    await fs.writeJSON(CONFIG.processedTweetsFile, processed, { spaces: 2 });
  } catch (error) {
    log(`処理済みツイートファイルの保存に失敗しました: ${error.message}`);
  }
}

// ツイートが処理可能かチェック
// ※ 高速化のため、メイン処理からは事前に作ったエラーIDのSetを渡して使う
function isTweetProcessable(tweetId, processed, errorIdSet = null, enableLog = true) {
  // 既に処理済みの場合はスキップ
  if (processed.successful[tweetId] || processed.failed[tweetId] || processed.noMedia[tweetId]) {
    return false;
  }
  
  // エラーが発生している場合はスキップ
  const hasErr = errorIdSet ? errorIdSet.has(tweetId) : errorManager.hasError(tweetId);
  if (hasErr) {
    if (enableLog) {
      const error = errorManager.getError(tweetId);
      log(`エラーが発生したツイートをスキップ: ${tweetId} (${error?.type || 'unknown'})`);
    }
    return false;
  }
  
  return true;
}

// ツイートのダウンロード（twitter-media-downloader.exe 非依存版）
async function downloadTweet(tweetId, retryCount = 0) {
  const tweetUrl = `https://twitter.com/i/web/status/${tweetId}`;
  const outputPath = path.join(CONFIG.outputDir, tweetId);

  try {
    // TwitterDL でツイート情報を取得
    const res = await TwitterDL(tweetUrl);

    if (res.status !== 'success') {
      const message = res.message || 'Unknown error';
      const error = new Error(message);
      const isGuestTokenError = message.includes('Failed to get Guest Token');

      // Guest Token が取れない場合は、実質的にレート制限扱いとして再試行させる
      if (isGuestTokenError && retryCount < CONFIG.maxRateLimitRetries) {
        return {
          success: false,
          noMedia: false,
          rateLimit: true,
          authError: false,
          retryCount: retryCount + 1,
          output: message,
        };
      }

      const errorType = determineErrorType(error, message) || ERROR_TYPES.RATE_LIMIT;

      // エラーを記録
      errorManager.addError(tweetId, errorType, {
        message,
        tweetId,
        tweetUrl,
      });

      // それ以外のケースは通常の失敗として扱う
      return {
        success: false,
        noMedia: false,
        rateLimit: false,
        authError: false,
        output: message,
      };
    }

    const tweetData = res.result;

    // 出力ディレクトリ作成
    await fs.ensureDir(outputPath);

    // tweet-data.json として保存（既存の media-check-and-download.js の想定形式と整合）
    const jsonPath = path.join(outputPath, 'tweet-data.json');
    await fs.writeJSON(jsonPath, tweetData, { spaces: 2 });

    // メディア有無による判定
    const hasMedia = Array.isArray(tweetData.media) && tweetData.media.length > 0;

    // 成功した場合はエラーを削除
    errorManager.removeError(tweetId);

    return {
      success: hasMedia,
      noMedia: !hasMedia,
      rateLimit: false,
      authError: false,
      output: '',
    };
  } catch (e) {
    const message = e.message || String(e);
    const errorType = determineErrorType(e);

    errorManager.addError(tweetId, errorType || ERROR_TYPES.DOWNLOAD_FAILED, {
      message,
      tweetId,
      tweetUrl,
    });

    return {
      success: false,
      noMedia: false,
      rateLimit: false,
      authError: false,
      output: message,
    };
  }
}

// like.jsからツイートIDを抽出
async function extractTweetIds() {
  log('like.jsファイルを読み込み中...');
  
  // ファイル全体を読み込む
  const content = await fs.readFile(CONFIG.likeJsPath, 'utf8');
  
  // "window.YTD.like.part0 = " の部分を取り除く
  let jsonContent;
  try {
    // JavaScriptの代入式からJSONデータ部分を抽出
    const match = content.match(/^window\.YTD\.like\.part0\s*=\s*(.+)/s);
    if (match && match[1]) {
      jsonContent = match[1].trim();
      // 末尾にセミコロンがある場合は削除
      if (jsonContent.endsWith(';')) {
        jsonContent = jsonContent.slice(0, -1);
      }
    } else {
      throw new Error('期待されるフォーマットではありません');
    }
    
    // JSONとして解析
    const data = JSON.parse(jsonContent);
    
    // ツイートIDを抽出
    const tweetIds = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && item.like && item.like.tweetId) {
          tweetIds.push(item.like.tweetId);
        }
      }
    }
    
    log(`${tweetIds.length}件のツイートIDを抽出しました`);
    return tweetIds;
    
  } catch (error) {
    log(`JSONデータの解析に失敗しました: ${error.message}`);
    throw error;
  }
}

// メイン処理
async function main() {
  try {
    // 設定ファイルの読み込み
    const configLoaded = loadConfig();
    if (configLoaded) {
      log('設定ファイルから設定を読み込みました');
    } else {
      log('設定ファイルが見つからないため、デフォルト設定で実行します');
    }

    // 出力ディレクトリの作成
    await fs.ensureDir(CONFIG.outputDir);

    // 処理済みツイートの読み込み
    const processed = await loadProcessedTweets();
    
    log('ツイートIDの抽出を開始します...');
    
    // ツイートIDの抽出
    const allTweetIds = await extractTweetIds();

    // 既知のエラーIDをSetにして、高速にスキップできるようにする
    const currentErrors = errorManager.getErrorList();
    const errorIdSet = new Set(currentErrors.map(e => e.tweetId));

    // 未処理のツイートをフィルタリング（ログはまとめて出す）
    let skippedAlreadyProcessed = 0;
    let skippedByError = 0;
    const tweetIds = allTweetIds.filter(tweetId => {
      // 既に処理済みの場合
      if (processed.successful[tweetId] || processed.failed[tweetId] || processed.noMedia[tweetId]) {
        skippedAlreadyProcessed++;
        return false;
      }
      // エラー記録がある場合
      if (errorIdSet.has(tweetId)) {
        skippedByError++;
        return false;
      }
      return true;
    });
    
    log(`未処理のツイート: ${tweetIds.length}件`);
    if (skippedAlreadyProcessed > 0) {
      log(`既に処理済みのためスキップ: ${skippedAlreadyProcessed}件`);
    }
    if (skippedByError > 0) {
      log(`エラー記録があるためスキップ: ${skippedByError}件`);
    }
    
    // バッチ処理
    for (let i = 0; i < tweetIds.length; i += CONFIG.batchSize) {
      const batch = tweetIds.slice(i, i + CONFIG.batchSize);
      log(`バッチ処理開始: ${i+1}～${Math.min(i+CONFIG.batchSize, tweetIds.length)}/${tweetIds.length}`);
      
      for (const tweetId of batch) {
        log(`ツイート処理開始: ${tweetId}`);
        
        try {
          const result = await downloadTweet(tweetId);
          
          if (result.success) {
            processed.successful[tweetId] = new Date().toISOString();
            log(`成功: ${tweetId}`);
          } else if (result.noMedia) {
            processed.noMedia[tweetId] = new Date().toISOString();
            log(`メディアなし: ${tweetId}`);
          } else if (result.authError) {
            log(`認証エラー: ${tweetId} - ${result.output}`);
            log('Twitter認証に失敗しました。config.jsonの認証情報を確認してください');
            processed.failed[tweetId] = new Date().toISOString();
            // 認証エラーが発生した場合は処理を中止
            return;
          } else if (result.rateLimit) {
            log(`レート制限: ${tweetId} - ${result.output}`);
            log(`レート制限のため${CONFIG.rateLimitWaitTime}ミリ秒待機します...`);
            await new Promise(resolve => setTimeout(resolve, CONFIG.rateLimitWaitTime));
            log(`再試行: ${tweetId} (${result.retryCount}/${CONFIG.maxRateLimitRetries})`);
            const retryResult = await downloadTweet(tweetId, result.retryCount);
            if (retryResult.success) {
              processed.successful[tweetId] = new Date().toISOString();
              log(`成功: ${tweetId}`);
            } else if (retryResult.noMedia) {
              processed.noMedia[tweetId] = new Date().toISOString();
              log(`メディアなし: ${tweetId}`);
            } else {
              processed.failed[tweetId] = new Date().toISOString();
            log(`失敗: ${tweetId} - ${formatErrorOutput(retryResult.output)}`);
            }
          } else {
            processed.failed[tweetId] = new Date().toISOString();
          log(`失敗: ${tweetId} - ${formatErrorOutput(result.output)}`);
          }
        } catch (error) {
          processed.failed[tweetId] = new Date().toISOString();
          log(`エラー: ${tweetId} - ${error.message}`);
        }
        
        // 各ダウンロード後に処理済みツイートを保存
        await saveProcessedTweets(processed);
      }
      
      // バッチ間の待機（最後のバッチ以外）
      if (i + CONFIG.batchSize < tweetIds.length) {
        log(`次のバッチまで${CONFIG.batchDelay}ミリ秒待機します...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.batchDelay));
      }
    }
    
    const processedCount = Object.keys(processed.successful).length;
    const failedCount = Object.keys(processed.failed).length;
    const noMediaCount = Object.keys(processed.noMedia).length;
    
    log('処理完了:');
    log(`- 成功: ${processedCount}件`);
    log(`- 失敗: ${failedCount}件`);
    log(`- メディアなし: ${noMediaCount}件`);
    
    // エラー統計の表示
    errorManager.printSummary();
    
  } catch (error) {
    log(`予期せぬエラーが発生しました: ${error.message}`);
    process.exit(1);
  }
}

// スクリプト実行
main().catch(error => {
  log(`致命的なエラーが発生しました: ${error.stack || error.message}`);
  process.exit(1);
});