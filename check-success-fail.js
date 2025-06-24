const fs = require('fs-extra');
const path = require('path');

// processed-tweets.jsonの読み込み
const processedPath = path.join(__dirname, 'processed-tweets.json');
const processed = fs.readJSONSync(processedPath);
const successful = processed.successful || {};

const downloadsDir = path.join(__dirname, 'downloads');
const allDownloadIds = fs.readdirSync(downloadsDir).filter(f => fs.statSync(path.join(downloadsDir, f)).isDirectory());

const notFound = [];
const newlyAdded = [];

function existsTweetJson(tweetId) {
  const tweetDir = path.join(downloadsDir, tweetId);
  const tweetDataPath = path.join(tweetDir, 'tweet-data.json');
  const tweetIdJsonPath = path.join(tweetDir, tweetId + '.json');
  return fs.existsSync(tweetDataPath) || fs.existsSync(tweetIdJsonPath);
}

for (const tweetId of Object.keys(successful)) {
  const tweetDir = path.join(downloadsDir, tweetId);
  if (!existsTweetJson(tweetId)) {
    notFound.push(tweetId);
    // ディレクトリ削除
    try {
      fs.removeSync(tweetDir);
      console.log(`削除: ${tweetDir}`);
    } catch (e) {
      console.log(`削除失敗: ${tweetDir} (${e.message})`);
    }
    // processed-tweets.jsonからも削除
    delete processed.successful[tweetId];
  }
}

// 逆に、tweet-data.jsonまたは{TweetID}.jsonが存在するのにsuccessfulに記録されていないものを追加
for (const tweetId of allDownloadIds) {
  if (existsTweetJson(tweetId) && !successful[tweetId]) {
    processed.successful[tweetId] = new Date().toISOString();
    newlyAdded.push(tweetId);
    console.log(`追加: ${tweetId}`);
  }
}

// processed-tweets.jsonを上書き保存
fs.writeJSONSync(processedPath, processed, { spaces: 2 });

if (notFound.length === 0) {
  console.log('全ての成功ツイートにtweet-data.jsonまたは{TweetID}.jsonが存在します。');
} else {
  console.log('成功となっているがtweet-data.jsonまたは{TweetID}.jsonが存在しないツイートID:');
  notFound.forEach(id => console.log(id));
  console.log(`合計: ${notFound.length}件`);
}

if (newlyAdded.length > 0) {
  console.log('tweet-data.jsonまたは{TweetID}.jsonが存在するがJSONに記録されていなかったツイートID:');
  newlyAdded.forEach(id => console.log(id));
  console.log(`追加合計: ${newlyAdded.length}件`);
} 