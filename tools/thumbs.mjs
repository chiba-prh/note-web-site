// サムネイル（サイトのスクリーンショット）を作る。ページは thumbs/<id>.png を表示する。
//
//   まず Chrome の中の最新データを bookmarks-raw.json に取り込む（ページの自動保存が止まっていても拾えるように）。
//   そのサイトを、このPCの Chrome（無ければ Edge）で画面を出さずに開いて撮る。
//   撮るのは「まだ無いもの」と「URLが変わったもの」だけ。消したサイトの画像は片付ける。
//   3回続けて撮れなかったサイトは、それ以上は自動では試さない（--retry で試し直す）。
//   画像は公開しない（.gitignore 済み）。毎日12時の publish.mjs の最後に実行される。
//
//   node tools/thumbs.mjs          足りない分だけ撮る
//   node tools/thumbs.mjs --retry  撮れなかったサイトも試し直す
//   node tools/thumbs.mjs --all    全部撮り直す

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { stripTracking } from './url.mjs';
import { syncRawFromBrowser } from './browser-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'bookmarks-raw.json');
const DIR = join(ROOT, 'thumbs');
const INDEX = join(DIR, 'index.json');
const LOG = join(ROOT, 'tools', 'publish.log');
const FAILED = join(DIR, 'failed.json');
const ALL = process.argv.includes('--all');
const RETRY = ALL || process.argv.includes('--retry');
const MAX_TRIES = 3;

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function log(msg) {
  const line = `${new Date().toLocaleString('ja-JP')} サムネイル ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

function shoot(browser, url, out) {
  const profile = mkdtempSync(join(tmpdir(), 'bookmarks-thumb-'));
  const tmp = out.replace(/\.png$/, '.tmp.png');   // Chrome は拡張子で画像形式を決めるので .png で終える
  try {
    spawnSync(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--mute-audio',
      '--window-size=1280,800', '--force-device-scale-factor=0.75',   // 1280×800 の画面を 960×600 の画像に
      '--virtual-time-budget=8000',                                    // 表示アニメーションが終わるまで待つ
      `--user-data-dir=${profile}`, `--screenshot=${tmp}`, url,
    ], { timeout: 60000, windowsHide: true, stdio: 'ignore' });
    if (!existsSync(tmp) || statSync(tmp).size < 1000) return false;
    renameSync(tmp, out);
    return true;
  } finally {
    rmSync(tmp, { force: true });
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
}

function main() {
  try {
    const r = syncRawFromBrowser();
    if (r.changed) log(r.note);
    else if (r.note) console.log(r.note);
  } catch (e) { log('Chrome の中のデータを取り込めませんでした: ' + e.message); }

  if (!existsSync(RAW)) { log('元データ bookmarks-raw.json がありません'); return; }
  const browser = BROWSERS.find(existsSync);
  if (!browser) { log('Chrome も Edge も見つかりません'); process.exitCode = 1; return; }

  const raw = JSON.parse(readFileSync(RAW, 'utf8'));
  mkdirSync(DIR, { recursive: true });
  const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : {};
  const fails = existsSync(FAILED) ? JSON.parse(readFileSync(FAILED, 'utf8')) : {};   // id → { url, count }

  let made = 0, failed = 0;
  for (const i of raw.items) {
    if (!/^[a-z0-9]+$/i.test(i.id) || !/^https?:/i.test(i.url)) continue;
    const url = stripTracking(i.url);   // 広告クリックIDなどを付けたまま開かない
    const out = join(DIR, i.id + '.png');
    if (!ALL && existsSync(out) && index[i.id] === url) continue;
    const f = fails[i.id] && fails[i.id].url === url ? fails[i.id] : { url, count: 0 };
    if (!RETRY && f.count >= MAX_TRIES) continue;
    if (shoot(browser, url, out)) { index[i.id] = url; delete fails[i.id]; made++; }
    else {
      f.count++; fails[i.id] = f; failed++;
      log(`撮れませんでした：${i.title || url}${f.count >= MAX_TRIES ? `（${MAX_TRIES}回失敗したので自動では試しません。node tools/thumbs.mjs --retry で試し直せます）` : ''}`);
    }
  }

  // 消したサイトの画像を片付ける
  const live = new Set(raw.items.map(i => i.id));
  for (const f of readdirSync(DIR)) {
    if (f.endsWith('.png') && !live.has(f.slice(0, -4))) rmSync(join(DIR, f));
  }
  for (const id of Object.keys(index)) if (!live.has(id)) delete index[id];
  for (const id of Object.keys(fails)) if (!live.has(id)) delete fails[id];
  writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n');
  if (Object.keys(fails).length) writeFileSync(FAILED, JSON.stringify(fails, null, 2) + '\n');
  else rmSync(FAILED, { force: true });

  if (made || failed) log(`${made} 件作成${failed ? ` / ${failed} 件失敗` : ''}`);
  else console.log('サムネイルは全部そろっています');
}

try { main(); }
catch (e) { log('エラー: ' + e.message); process.exitCode = 1; }
