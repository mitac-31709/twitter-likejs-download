const { ErrorManager, ERROR_TYPES } = require('./error-manager');

const errorManager = new ErrorManager();

// コマンドライン引数の処理
const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`
エラー管理ユーティリティ

使用方法:
  node error-utils.js <command> [options]

コマンド:
  list                    - エラーリストを表示
  summary                 - エラー統計を表示
  clear <tweetId>         - 特定のツイートのエラーをクリア
  clear-all               - 全エラーをクリア
  retry <tweetId>         - 特定のツイートのエラーをクリアして再試行可能にする
  type <errorType>        - 特定のエラータイプのツイートを表示
  help                    - このヘルプを表示

エラータイプ:
  ${Object.entries(ERROR_TYPES).map(([key, value]) => `  ${value} - ${key}`).join('\n  ')}
`);
}

function listErrors() {
  const errors = errorManager.getErrorList();
  if (errors.length === 0) {
    console.log('エラーはありません');
    return;
  }
  
  console.log(`\n=== エラーリスト (${errors.length}件) ===`);
  errors.forEach(error => {
    console.log(`\nツイートID: ${error.tweetId}`);
    console.log(`  タイプ: ${error.type}`);
    console.log(`  日時: ${error.timestamp}`);
    console.log(`  再試行回数: ${error.retry_count}`);
    if (error.details) {
      // HTTPステータスコードの情報を優先表示
      if (error.details.statusCode) {
        console.log(`  HTTPステータス: ${error.details.statusCode}`);
      }
      if (error.details.isTimeout) {
        console.log(`  タイムアウト: はい`);
      }
      if (error.details.url) {
        console.log(`  URL: ${error.details.url}`);
      }
      if (error.details.mediaType) {
        console.log(`  メディアタイプ: ${error.details.mediaType}`);
      }
      if (error.details.message) {
        console.log(`  エラーメッセージ: ${error.details.message}`);
      }
      // その他の詳細情報
      const otherDetails = { ...error.details };
      delete otherDetails.statusCode;
      delete otherDetails.isTimeout;
      delete otherDetails.url;
      delete otherDetails.mediaType;
      delete otherDetails.message;
      if (Object.keys(otherDetails).length > 0) {
        console.log(`  その他: ${JSON.stringify(otherDetails, null, 2)}`);
      }
    }
  });
}

function showSummary() {
  errorManager.printSummary();
}

function clearError(tweetId) {
  if (!tweetId) {
    console.error('ツイートIDを指定してください');
    return;
  }
  
  if (errorManager.hasError(tweetId)) {
    errorManager.clearError(tweetId);
    console.log(`ツイート ${tweetId} のエラーをクリアしました`);
  } else {
    console.log(`ツイート ${tweetId} にはエラーがありません`);
  }
}

function clearAllErrors() {
  errorManager.clearAllErrors();
  console.log('全エラーをクリアしました');
}

function retryTweet(tweetId) {
  if (!tweetId) {
    console.error('ツイートIDを指定してください');
    return;
  }
  
  if (errorManager.hasError(tweetId)) {
    errorManager.clearError(tweetId);
    console.log(`ツイート ${tweetId} のエラーをクリアしました。次回の実行で再試行されます。`);
  } else {
    console.log(`ツイート ${tweetId} にはエラーがありません`);
  }
}

function showErrorsByType(errorType) {
  if (!errorType) {
    console.error('エラータイプを指定してください');
    return;
  }
  
  const errors = errorManager.getErrorsByType(errorType);
  if (errors.length === 0) {
    console.log(`エラータイプ "${errorType}" のエラーはありません`);
    return;
  }
  
  console.log(`\n=== エラータイプ "${errorType}" のエラー (${errors.length}件) ===`);
  errors.forEach(error => {
    console.log(`\nツイートID: ${error.tweetId}`);
    console.log(`  日時: ${error.timestamp}`);
    console.log(`  再試行回数: ${error.retry_count}`);
    if (error.details) {
      // HTTPステータスコードの情報を優先表示
      if (error.details.statusCode) {
        console.log(`  HTTPステータス: ${error.details.statusCode}`);
      }
      if (error.details.isTimeout) {
        console.log(`  タイムアウト: はい`);
      }
      if (error.details.url) {
        console.log(`  URL: ${error.details.url}`);
      }
      if (error.details.mediaType) {
        console.log(`  メディアタイプ: ${error.details.mediaType}`);
      }
      if (error.details.message) {
        console.log(`  エラーメッセージ: ${error.details.message}`);
      }
      // その他の詳細情報
      const otherDetails = { ...error.details };
      delete otherDetails.statusCode;
      delete otherDetails.isTimeout;
      delete otherDetails.url;
      delete otherDetails.mediaType;
      delete otherDetails.message;
      if (Object.keys(otherDetails).length > 0) {
        console.log(`  その他: ${JSON.stringify(otherDetails, null, 2)}`);
      }
    }
  });
}

// メイン処理
async function main() {
  try {
    switch (command) {
      case 'list':
        listErrors();
        break;
      case 'summary':
        showSummary();
        break;
      case 'clear':
        clearError(args[1]);
        break;
      case 'clear-all':
        clearAllErrors();
        break;
      case 'retry':
        retryTweet(args[1]);
        break;
      case 'type':
        showErrorsByType(args[1]);
        break;
      case 'help':
      case '--help':
      case '-h':
        printUsage();
        break;
      default:
        console.error('不明なコマンドです');
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error(`エラーが発生しました: ${error.message}`);
    process.exit(1);
  }
}

// スクリプト実行
if (require.main === module) {
  main();
} 