const fs = require('fs-extra');
const path = require('path');

// エラー管理ファイルのパス
const ERROR_FILE_PATH = path.join(__dirname, 'error-tweets.json');

// エラータイプの定義
const ERROR_TYPES = {
  DOWNLOAD_FAILED: 'download_failed',           // ツイートデータのダウンロード失敗
  JSON_PARSE_ERROR: 'json_parse_error',         // JSONファイルの解析エラー
  MEDIA_404: 'media_404',                       // メディアファイルの404エラー
  MEDIA_403: 'media_403',                       // メディアファイルの403エラー
  MEDIA_DOWNLOAD_FAILED: 'media_download_failed', // メディアファイルのダウンロード失敗
  RATE_LIMIT: 'rate_limit',                     // レート制限
  AUTH_ERROR: 'auth_error',                     // 認証エラー
  NETWORK_ERROR: 'network_error',               // ネットワークエラー
  UNKNOWN_ERROR: 'unknown_error',               // その他のエラー
  NOT_FOUND: 'not_found'                        // ローカルに必要なファイルやJSONが存在しない
};

// エラー管理クラス
class ErrorManager {
  constructor() {
    this.errors = this.loadErrors();
  }

  // エラーファイルの読み込み
  loadErrors() {
    try {
      if (fs.existsSync(ERROR_FILE_PATH)) {
        return fs.readJSONSync(ERROR_FILE_PATH);
      }
    } catch (error) {
      console.error(`エラーファイルの読み込みに失敗しました: ${error.message}`);
    }
    return {
      errors: {},
      statistics: {
        total_errors: 0,
        by_type: {},
        by_date: {}
      }
    };
  }

  // エラーファイルの保存（同期版でメモリ効率化）
  saveErrors() {
    try {
      fs.writeJSONSync(ERROR_FILE_PATH, this.errors, { spaces: 2 });
    } catch (error) {
      console.error(`エラーファイルの保存に失敗しました: ${error.message}`);
    }
  }

  // バッチ処理用の保存制御
  setBatchMode(enabled) {
    this.batchMode = enabled;
  }

  // エラーの追加
  addError(tweetId, errorType, details = {}) {
    const timestamp = new Date().toISOString();
    
    this.errors.errors[tweetId] = {
      type: errorType,
      timestamp: timestamp,
      details: details,
      retry_count: (this.errors.errors[tweetId]?.retry_count || 0) + 1
    };

    // 統計情報の更新
    this.errors.statistics.total_errors++;
    
    // エラータイプ別の統計
    if (!this.errors.statistics.by_type[errorType]) {
      this.errors.statistics.by_type[errorType] = 0;
    }
    this.errors.statistics.by_type[errorType]++;

    // 日付別の統計
    const date = timestamp.split('T')[0];
    if (!this.errors.statistics.by_date[date]) {
      this.errors.statistics.by_date[date] = 0;
    }
    this.errors.statistics.by_date[date]++;

    // バッチモードでない場合のみ即座に保存
    if (!this.batchMode) {
      this.saveErrors();
    }
  }

  // エラーの確認
  hasError(tweetId) {
    return !!this.errors.errors[tweetId];
  }

  // エラーの取得
  getError(tweetId) {
    return this.errors.errors[tweetId];
  }

  // エラーの削除（成功した場合）
  removeError(tweetId) {
    if (this.errors.errors[tweetId]) {
      const errorType = this.errors.errors[tweetId].type;
      
      // 統計情報の更新
      this.errors.statistics.total_errors--;
      this.errors.statistics.by_type[errorType]--;
      
      const date = this.errors.errors[tweetId].timestamp.split('T')[0];
      this.errors.statistics.by_date[date]--;

      delete this.errors.errors[tweetId];
      // バッチモードでない場合のみ即座に保存
      if (!this.batchMode) {
        this.saveErrors();
      }
    }
  }

  // エラータイプ別のフィルタリング
  getErrorsByType(errorType) {
    return Object.entries(this.errors.errors)
      .filter(([_, error]) => error.type === errorType)
      .map(([tweetId, error]) => ({ tweetId, ...error }));
  }

  // 再試行回数でフィルタリング
  getErrorsByRetryCount(minRetryCount) {
    return Object.entries(this.errors.errors)
      .filter(([_, error]) => error.retry_count >= minRetryCount)
      .map(([tweetId, error]) => ({ tweetId, ...error }));
  }

  // 統計情報の取得
  getStatistics() {
    return this.errors.statistics;
  }

  // エラーリストの取得
  getErrorList() {
    return Object.entries(this.errors.errors).map(([tweetId, error]) => ({
      tweetId,
      ...error
    }));
  }

  // エラーのクリア（特定のツイートID）
  clearError(tweetId) {
    this.removeError(tweetId);
  }

  // 全エラーのクリア
  clearAllErrors() {
    this.errors = {
      errors: {},
      statistics: {
        total_errors: 0,
        by_type: {},
        by_date: {}
      }
    };
    // バッチモードでない場合のみ即座に保存
    if (!this.batchMode) {
      this.saveErrors();
    }
  }

  // エラーサマリーの表示
  printSummary() {
    const stats = this.getStatistics();
    console.log('\n=== エラー統計 ===');
    console.log(`総エラー数: ${stats.total_errors}件`);
    
    if (Object.keys(stats.by_type).length > 0) {
      console.log('\nエラータイプ別:');
      Object.entries(stats.by_type).forEach(([type, count]) => {
        console.log(`  ${type}: ${count}件`);
      });
    }

    if (Object.keys(stats.by_date).length > 0) {
      console.log('\n日付別:');
      Object.entries(stats.by_date)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 7) // 最新7日間
        .forEach(([date, count]) => {
          console.log(`  ${date}: ${count}件`);
        });
    }
  }
}

// エラータイプの判定ヘルパー関数
function determineErrorType(error, output = '') {
  const errorMessage = error.message || error.toString();
  const fullMessage = errorMessage + ' ' + output;

  if (fullMessage.includes('404') || fullMessage.includes('Not Found')) {
    return ERROR_TYPES.MEDIA_404;
  }
  if (fullMessage.includes('403') || fullMessage.includes('Forbidden')) {
    return ERROR_TYPES.MEDIA_403;
  }
  if (fullMessage.includes('429') || fullMessage.includes('Too Many Requests') || fullMessage.includes('Rate limit')) {
    return ERROR_TYPES.RATE_LIMIT;
  }
  if (fullMessage.includes('Authentication failed') || fullMessage.includes('Unauthorized') || fullMessage.includes('Login failed')) {
    return ERROR_TYPES.AUTH_ERROR;
  }
  if (fullMessage.includes('ENOTFOUND') || fullMessage.includes('ECONNREFUSED') || fullMessage.includes('ETIMEDOUT')) {
    return ERROR_TYPES.NETWORK_ERROR;
  }
  if (fullMessage.includes('JSON') || fullMessage.includes('parse')) {
    return ERROR_TYPES.JSON_PARSE_ERROR;
  }
  if (fullMessage.includes('download') || fullMessage.includes('Failed to get')) {
    return ERROR_TYPES.MEDIA_DOWNLOAD_FAILED;
  }
  
  return ERROR_TYPES.UNKNOWN_ERROR;
}

module.exports = {
  ErrorManager,
  ERROR_TYPES,
  determineErrorType
}; 