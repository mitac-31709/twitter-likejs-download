const fs = require('fs-extra');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const StreamValues = require('stream-json/streamers/StreamValues');

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
  maxRateLimitRetries: 3,
  // Twitter認証情報
  twitterCredentials: {
    username: '',
    password: ''
  }
};

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
      
      // 認証情報を適用
      if (configData.twitterCredentials) {
        CONFIG.twitterCredentials = configData.twitterCredentials;
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

// ツイートのダウンロード
async function downloadTweet(tweetId, retryCount = 0) {
  return new Promise((resolve) => {
    const twmdPath = path.join(__dirname, 'twitter-media-downloader.exe');
    const outputPath = path.join(CONFIG.outputDir, tweetId);

    // フォルダがなければ作成
    fs.ensureDirSync(outputPath);

    // コマンドライン引数の準備
    const args = ['-t', tweetId, '-o', outputPath, '-a'];
    
    // 認証情報があれば追加
    if (CONFIG.twitterCredentials && CONFIG.twitterCredentials.username && CONFIG.twitterCredentials.password) {
      args.push('-u', CONFIG.twitterCredentials.username);
      args.push('-p', CONFIG.twitterCredentials.password);
    }

    const process = spawn(twmdPath, args);

    let output = '';

    process.stdout.on('data', (data) => {
      output += data.toString();
    });

    process.stderr.on('data', (data) => {
      output += data.toString();
    });

    process.on('close', (code) => {
      const hasError = code !== 0;
      const hasNoMedia = output.includes('No media found') || output.includes('contains no media');
      const isRateLimit = output.includes('response status 429 Too Many Requests') || 
                          output.includes('Rate limit exceeded');
      const isAuthError = output.includes('Authentication failed') || 
                         output.includes('Login failed') ||
                         output.includes('Unauthorized') ||
                         output.includes('Invalid credentials');
      
      // フォルダが空なら削除する関数
      function removeIfEmpty(dir) {
        try {
          if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
          }
        } catch (e) {
          // 削除失敗時は無視
        }
      }

      if (isAuthError) {
        removeIfEmpty(outputPath);
        resolve({ 
          success: false, 
          noMedia: false, 
          rateLimit: false,
          authError: true, 
          output 
        });
      } else if (isRateLimit && retryCount < CONFIG.maxRateLimitRetries) {
        removeIfEmpty(outputPath);
        resolve({ 
          success: false, 
          noMedia: false, 
          rateLimit: true,
          authError: false, 
          retryCount: retryCount + 1,
          output 
        });
      } else if (hasNoMedia) {
        removeIfEmpty(outputPath);
        resolve({ success: false, noMedia: true, rateLimit: false, authError: false, output });
      } else if (hasError) {
        removeIfEmpty(outputPath);
        resolve({ success: false, noMedia: false, rateLimit: false, authError: false, output });
      } else {
        resolve({ success: true, noMedia: false, rateLimit: false, authError: false, output });
      }
    });
  });
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
      
      // 認証情報の確認
      if (CONFIG.twitterCredentials.username && CONFIG.twitterCredentials.password) {
        log(`ユーザー "${CONFIG.twitterCredentials.username}" としてログインします`);
      } else {
        log('認証情報が設定されていません。匿名モードで実行します');
      }
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
    
    // 未処理のツイートをフィルタリング
    const tweetIds = allTweetIds.filter(tweetId => 
      !processed.successful[tweetId] && 
      !processed.failed[tweetId] && 
      !processed.noMedia[tweetId]
    );
    
    log(`未処理のツイート: ${tweetIds.length}件`);
    
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
              log(`失敗: ${tweetId} - ${retryResult.output}`);
            }
          } else {
            processed.failed[tweetId] = new Date().toISOString();
            log(`失敗: ${tweetId} - ${result.output}`);
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