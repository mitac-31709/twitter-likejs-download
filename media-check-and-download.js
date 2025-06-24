const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const downloadsDir = path.join(__dirname, 'downloads');

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

async function processTweetDir(tweetId) {
  const tweetDir = path.join(downloadsDir, tweetId);
  const tweetDataPath = path.join(tweetDir, 'tweet-data.json');
  const tweetIdJsonPath = path.join(tweetDir, tweetId + '.json');
  let jsonPath = null;
  if (fs.existsSync(tweetDataPath)) {
    jsonPath = tweetDataPath;
  } else if (fs.existsSync(tweetIdJsonPath)) {
    jsonPath = tweetIdJsonPath;
  } else {
    return; // JSONがなければスキップ
  }
  let data;
  try {
    data = fs.readJSONSync(jsonPath);
  } catch (e) {
    console.log(`JSON読み込み失敗: ${jsonPath}`);
    return;
  }
  if (!data.media || !Array.isArray(data.media)) return;
  for (const media of data.media) {
    if (media.type === 'photo' && media.image) {
      const filename = getFilenameFromUrl(media.image);
      if (!filename) continue;
      const filePath = path.join(tweetDir, filename);
      if (!fs.existsSync(filePath)) {
        console.log(`ダウンロード: ${media.image} → ${filePath}`);
        try {
          await downloadFile(media.image, filePath);
        } catch (e) {
          console.log(`失敗: ${media.image}`);
        }
      }
    } else if (media.type === 'video' && Array.isArray(media.videos)) {
      // 一番高画質の動画を選ぶ
      const sorted = media.videos.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (sorted.length > 0) {
        const url = sorted[0].url;
        const filename = getFilenameFromUrl(url);
        if (!filename) continue;
        const filePath = path.join(tweetDir, filename);
        if (!fs.existsSync(filePath)) {
          console.log(`ダウンロード: ${url} → ${filePath}`);
          try {
            await downloadFile(url, filePath);
          } catch (e) {
            console.log(`失敗: ${url}`);
          }
        }
      }
      // サムネイルも保存
      if (media.cover) {
        const coverName = getFilenameFromUrl(media.cover);
        if (coverName) {
          const coverPath = path.join(tweetDir, coverName);
          if (!fs.existsSync(coverPath)) {
            console.log(`ダウンロード: ${media.cover} → ${coverPath}`);
            try {
              await downloadFile(media.cover, coverPath);
            } catch (e) {
              console.log(`失敗: ${media.cover}`);
            }
          }
        }
      }
    }
  }
}

async function main() {
  const tweetIds = fs.readdirSync(downloadsDir).filter(f => fs.statSync(path.join(downloadsDir, f)).isDirectory());
  for (const tweetId of tweetIds) {
    await processTweetDir(tweetId);
  }
  console.log('完了');
}

main(); 