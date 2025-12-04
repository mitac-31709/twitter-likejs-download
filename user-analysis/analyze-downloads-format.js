const fs = require('fs');
const path = require('path');

// 処理対象ディレクトリ
const DOWNLOADS_DIR = path.join(__dirname, '../downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  console.error('[analyze-downloads-format] downloads ディレクトリが存在しません:', DOWNLOADS_DIR);
  process.exit(1);
}

// 統計用カウンタ
let totalDirs = 0;              // downloads 配下のディレクトリ数
let totalJsonFiles = 0;         // JSON ファイルが存在した件数（tweetId/tweetId.json）
let totalParsed = 0;            // JSON パース成功件数
let totalParseError = 0;        // JSON パースエラー件数
let totalMissingJson = 0;       // JSON が存在しないディレクトリ数

// 構造ごとのカウンタ
let withAuthor = 0;
let withAuthorUsername = 0;
let withCreatedAt = 0;
let withStatistics = 0;
let withMedia = 0;

// 代表的な 3 パターン用のカウンタ（先の解析結果に基づく）
let shapeFullTweet = 0;     // author,createdAt,description,...,media,statistics,status...
let shapeLightTweet = 0;    // author,createdAt,description,...,mediaCount,statistics
let shapeStatusOnly = 0;    // status,statusMetadata,statusUpdatedAt

// フォーマット別のバリエーションを簡易カウント（キー集合の文字列表現で集計）
// 上記 3 パターン以外のみ集計し、「例外フォーマット」として確認できるようにする
const topLevelShapeCounts = {};

// 代表的なキー構成（ソート済み）を事前定義
const FULL_TWEET_KEYS = [
  'author',
  'createdAt',
  'description',
  'id',
  'isQuoteStatus',
  'languange',
  'media',
  'mediaCount',
  'possiblySensitive',
  'possiblySensitiveEditable',
  'statistics',
  'status',
  'statusMetadata',
  'statusUpdatedAt'
].join(',');

const LIGHT_TWEET_KEYS = [
  'author',
  'createdAt',
  'description',
  'id',
  'isQuoteStatus',
  'languange',
  'media',
  'mediaCount',
  'possiblySensitive',
  'possiblySensitiveEditable',
  'statistics'
].join(',');

const STATUS_ONLY_KEYS = [
  'status',
  'statusMetadata',
  'statusUpdatedAt'
].join(',');

console.log('[analyze-downloads-format] 解析開始: ', DOWNLOADS_DIR);

// downloads配下の全サブディレクトリを取得
const tweetDirs = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  .map(dirent => dirent.name);

totalDirs = tweetDirs.length;
console.log('[analyze-downloads-format] ディレクトリ数 (ツイート候補):', totalDirs);

for (const tweetId of tweetDirs) {
  const jsonPath = path.join(DOWNLOADS_DIR, tweetId, tweetId + '.json');

  if (!fs.existsSync(jsonPath)) {
    totalMissingJson += 1;
    continue;
  }

  totalJsonFiles += 1;

  let data;
  try {
    const text = fs.readFileSync(jsonPath, 'utf8');
    data = JSON.parse(text);
    totalParsed += 1;
  } catch (e) {
    totalParseError += 1;
    // 形式を確認したいので、最初の数件だけエラー詳細を出す
    if (totalParseError <= 10) {
      console.log('[analyze-downloads-format] JSON パースエラー:', tweetId, 'エラー:', e.message);
    }
    continue;
  }

  // トップレベルのキー構成で簡易分類
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data).sort();
    const shapeKey = keys.join(',');

    // 代表的な 3 パターンは専用カウンタへ
    if (shapeKey === FULL_TWEET_KEYS) {
      shapeFullTweet += 1;
    } else if (shapeKey === LIGHT_TWEET_KEYS) {
      shapeLightTweet += 1;
    } else if (shapeKey === STATUS_ONLY_KEYS) {
      shapeStatusOnly += 1;
    } else {
      // 想定外フォーマットのみマップに積む
      topLevelShapeCounts[shapeKey] = (topLevelShapeCounts[shapeKey] || 0) + 1;
    }
  }

  // よく使うキーの有無をチェック
  if (data && data.author) {
    withAuthor += 1;
    if (data.author.username) {
      withAuthorUsername += 1;
    }
  }

  if (data && data.createdAt) {
    withCreatedAt += 1;
  }

  if (data && data.statistics) {
    withStatistics += 1;
  }

  if (data && Array.isArray(data.media) && data.media.length > 0) {
    withMedia += 1;
  }
}

// 結果サマリ
console.log('--------------------------------------------');
console.log('[analyze-downloads-format] 解析サマリ');
console.log('[analyze-downloads-format] ディレクトリ数 (ツイート候補) :', totalDirs);
console.log('[analyze-downloads-format] JSON ファイル存在数           :', totalJsonFiles);
console.log('[analyze-downloads-format] JSON 不存在ディレクトリ数      :', totalMissingJson);
console.log('[analyze-downloads-format] JSON パース成功数              :', totalParsed);
console.log('[analyze-downloads-format] JSON パースエラー数            :', totalParseError);
console.log('[analyze-downloads-format] author あり                    :', withAuthor);
console.log('[analyze-downloads-format] author.username あり           :', withAuthorUsername);
console.log('[analyze-downloads-format] createdAt あり                 :', withCreatedAt);
console.log('[analyze-downloads-format] statistics あり                :', withStatistics);
console.log('[analyze-downloads-format] media 配列あり                 :', withMedia);

console.log('--------------------------------------------');
console.log('[analyze-downloads-format] 代表的なトップレベルキー構成ごとの件数:');
console.log('  FULL_TWEET  (author,createdAt,description,...,media,statistics,status,...) 件数:', shapeFullTweet);
console.log('  LIGHT_TWEET (author,createdAt,description,...,mediaCount,statistics)       件数:', shapeLightTweet);
console.log('  STATUS_ONLY (status,statusMetadata,statusUpdatedAt)                        件数:', shapeStatusOnly);

if (Object.keys(topLevelShapeCounts).length > 0) {
  console.log('--------------------------------------------');
  console.log('[analyze-downloads-format] 想定外トップレベルキー構成ごとの件数 (上位50):');
  Object.entries(topLevelShapeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50) // 多すぎると読めないので上位 50 パターンまで表示
    .forEach(([shape, count]) => {
      console.log(`  件数=${count}  キー構成=[${shape}]`);
    });
}

console.log('[analyze-downloads-format] 解析完了');


