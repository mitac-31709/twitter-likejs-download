const fs = require('fs');
const path = require('path');

// 入力ファイル
const USER_LIKE_FILE = path.join(__dirname, 'user-like-count.json');
const FOLLOWING_JS_FILE = path.join(__dirname, '..', 'following.js');

// 任意: accountId → username の対応表を用意できる場合はここで読み込む
// 形式: { "1234567890": "some_user", "2345678901": "other_user", ... }
const ID_USERNAME_MAP_FILE = path.join(__dirname, 'account-id-to-username.json');

// 出力ファイル
const OUTPUT_FILE = path.join(__dirname, 'not-following-liked-users.json');

// user-like-count.json を読み込み（analyze-user-likes.js の出力）
if (!fs.existsSync(USER_LIKE_FILE)) {
  console.error('user-like-count.json が見つかりません。先に analyze-user-likes.js を実行してください。');
  process.exit(1);
}

const likedUsers = JSON.parse(fs.readFileSync(USER_LIKE_FILE, 'utf8'));

// username の集合（小文字で正規化）
const likedUsernameSet = new Set(
  likedUsers
    .map(u => u && u.username)
    .filter(Boolean)
    .map(name => name.toLowerCase())
);

// following.js を読み込んで JSON 部分だけ取り出す
if (!fs.existsSync(FOLLOWING_JS_FILE)) {
  console.error('following.js が見つかりません。Twitter のフォロー一覧エクスポートを配置してください。');
  process.exit(1);
}

const followingJsText = fs.readFileSync(FOLLOWING_JS_FILE, 'utf8');

// 例: window.YTD.following.part0 = [ ... ];
const match = followingJsText.match(/window\.YTD\.following\.part0\s*=\s*(\[\s*[\s\S]*\s*\]);?/);
if (!match) {
  console.error('following.js からフォロー情報の配列を抽出できませんでした。フォーマットを確認してください。');
  process.exit(1);
}

let followingArray;
try {
  followingArray = JSON.parse(match[1]);
} catch (e) {
  console.error('following.js 内の配列部分の JSON パースに失敗しました:', e.message);
  process.exit(1);
}

// フォローしているアカウントの accountId 集合
const followingAccountIdSet = new Set(
  followingArray
    .map(entry => entry && entry.following && entry.following.accountId)
    .filter(Boolean)
);

// accountId → username 対応表を作成
// 1) まず user-like-count.json 内の author.profileBannerUrl から自動生成
//    "https://pbs.twimg.com/profile_banners/{accountId}/..." という形式を想定
const idToUsername = {};
const bannerRegex = /profile_banners\/(\d+)\//;

for (const u of likedUsers) {
  if (!u || !u.username || !u.author || !u.author.profileBannerUrl) continue;
  const m = String(u.author.profileBannerUrl).match(bannerRegex);
  if (!m) continue;
  const accountId = m[1];
  if (!accountId) continue;

  // 既に同じ accountId に別 username が紐づいている場合は、最初のものを優先
  if (!idToUsername[accountId]) {
    idToUsername[accountId] = u.username;
  }
}

// 2) 任意の accountId → username 対応表ファイルがあれば、それで上書き・補完
if (fs.existsSync(ID_USERNAME_MAP_FILE)) {
  try {
    const manualMap = JSON.parse(fs.readFileSync(ID_USERNAME_MAP_FILE, 'utf8'));
    for (const [id, username] of Object.entries(manualMap)) {
      if (username) {
        idToUsername[id] = username;
      }
    }
  } catch (e) {
    console.warn('account-id-to-username.json の読み込みに失敗しました。対応表は無視して続行します:', e.message);
  }
}

if (Object.keys(idToUsername).length === 0) {
  console.warn(
    'profileBannerUrl から accountId ⇔ username の対応を一件も抽出できませんでした。\n' +
      'user-like-count.json の author.profileBannerUrl の形式を確認してください。'
  );
}

// 対応表から「フォローしている username 集合」を作成
const followingUsernameSet = new Set(
  Object.entries(idToUsername)
    .filter(([id]) => followingAccountIdSet.has(id))
    .map(([, username]) => username)
    .filter(Boolean)
    .map(name => name.toLowerCase())
);

// likedUsers の中から「フォローしていない（と思われる）ユーザー」を抽出
// ※対応表が空の場合は、事実上「全員フォローしていない」となってしまう点に注意
const notFollowingUsers = likedUsers.filter(user => {
  if (!user || !user.username) return false;
  const uname = user.username.toLowerCase();
  return !followingUsernameSet.has(uname);
});

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(notFollowingUsers, null, 2), 'utf8');

console.log('フォローしていない（と推定される）いいね先ユーザー一覧を出力しました。結果ファイル:', OUTPUT_FILE);


