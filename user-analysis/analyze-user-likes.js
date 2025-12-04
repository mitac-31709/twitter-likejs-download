const fs = require('fs');
const path = require('path');

// 処理対象ディレクトリ
const DOWNLOADS_DIR = path.join(__dirname, '../downloads');
const OUTPUT_FILE = path.join(__dirname, 'user-like-count.json');

// ユーザーごとのカウント・情報用
const userData = {};

// 動的解析用のカウンタ
let totalDirs = 0;          // downloads 配下のディレクトリ数
let totalJsonFound = 0;     // .json ファイルが存在した件数
let totalParsed = 0;        // JSON パースに成功した件数
let totalAuthorFound = 0;   // author.username が存在した件数
let totalAuthorMissing = 0; // author または username が無かった件数
let totalParseError = 0;    // JSON パースエラー件数

// downloads配下の全サブディレクトリを取得
const tweetDirs = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  .map(dirent => dirent.name);

totalDirs = tweetDirs.length;
console.log('[analyze-user-likes] ディレクトリ数 (ツイート候補数):', totalDirs);

for (const tweetId of tweetDirs) {
  const jsonPath = path.join(DOWNLOADS_DIR, tweetId, tweetId + '.json');
  if (!fs.existsSync(jsonPath)) {
    // JSON が存在しないツイート ID
    console.log('[analyze-user-likes] JSON 不存在のためスキップ:', tweetId);
    continue;
  }

  totalJsonFound += 1;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    totalParsed += 1;

    if (data.author && data.author.username) {
      const username = data.author.username;
      if (!userData[username]) {
        userData[username] = {
          count: 0,
          author: data.author
        };
      }
      userData[username].count += 1;
      totalAuthorFound += 1;
    } else {
      totalAuthorMissing += 1;
      console.log(
        '[analyze-user-likes] author / author.username 欠如のためスキップ:',
        tweetId,
        'authorキー有無 =',
        !!data.author,
        'username有無 =',
        !!(data.author && data.author.username)
      );
    }
  } catch (e) {
    // JSONパースエラー等は無視（件数だけカウント）
    totalParseError += 1;
    console.log('[analyze-user-likes] JSON パースエラーのためスキップ:', tweetId, 'エラー:', e.message);
    continue;
  }
}

// 多い順にソート
const sorted = Object.entries(userData)
  .sort((a, b) => b[1].count - a[1].count)
  .map(([username, info]) => ({
    username,
    count: info.count,
    author: info.author
  }));

// 結果を保存
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sorted, null, 2), 'utf8');

// 動的解析用サマリログ
console.log('--------------------------------------------');
console.log('[analyze-user-likes] 動的解析サマリ');
console.log('[analyze-user-likes] ディレクトリ数 (ツイート候補):', totalDirs);
console.log('[analyze-user-likes] JSON ファイル存在数          :', totalJsonFound);
console.log('[analyze-user-likes] JSON パース成功数           :', totalParsed);
console.log('[analyze-user-likes] author.username あり        :', totalAuthorFound);
console.log('[analyze-user-likes] author/username 欠如        :', totalAuthorMissing);
console.log('[analyze-user-likes] JSON パースエラー数         :', totalParseError);
console.log('[analyze-user-likes] 集計対象ユーザー数          :', sorted.length);
console.log('ユーザーごとのいいね数と詳細情報の集計が完了しました。結果は', OUTPUT_FILE, 'に保存されました。');