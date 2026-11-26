// ページが Chrome の中（localStorage）に持っている最新データを、このPCの Chrome の保存領域から直接読む。
//
//   ページの「ファイルへ自動保存」は、ブラウザの許可が切れると止まり、bookmarks-raw.json が古いままになる。
//   そこで、定期実行のたびにここから最新を読んで bookmarks-raw.json を合わせる。
//   読むだけで、Chrome の保存領域には一切書き込まない。Chrome を開いたままでも動く。
//
//   node tools/browser-data.mjs    読めた内容と、bookmarks-raw.json との差を表示（書き込みはしない）

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'bookmarks-raw.json');
const STORAGE_KEY = 'fun-sites-v1';                 // bookmarks.html の KEY と同じ
const PROFILE = process.env.BOOKMARKS_CHROME_PROFILE || 'Default';
const DB_DIR = join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', PROFILE, 'Local Storage', 'leveldb');

/* ---------- LevelDB（Chrome の保存形式）を読む最小限の実装 ---------- */
function varint(buf, pos) {
  let v = 0, shift = 0;
  for (;;) {
    const b = buf[pos++];
    v += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [v, pos];
    shift += 7;
  }
}

function unsnappy(src) {
  let [len, p] = varint(src, 0);
  const out = Buffer.alloc(len);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++], kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) { const bytes = n - 59; n = src.readUIntLE(p, bytes); p += bytes; }
      n += 1;
      src.copy(out, o, p, p + n); p += n; o += n;
      continue;
    }
    let n, off;
    if (kind === 1) { n = 4 + ((tag >> 2) & 7); off = ((tag >> 5) << 8) | src[p]; p += 1; }
    else if (kind === 2) { n = (tag >> 2) + 1; off = src.readUInt16LE(p); p += 2; }
    else { n = (tag >> 2) + 1; off = src.readUInt32LE(p); p += 4; }
    if (off === 0 || off > o) throw new Error('snappy の中身が壊れています');
    for (let i = 0; i < n; i++, o++) out[o] = out[o - off];   // 重なりがあるので1バイトずつ
  }
  if (o !== len) throw new Error('snappy の長さが合いません');
  return out;
}

function readBlock(file, offset, size) {
  const body = file.subarray(offset, offset + size);
  const type = file[offset + size];
  if (type === 0) return body;
  if (type === 1) return unsnappy(body);
  throw new Error('未対応の圧縮形式: ' + type);
}

// ブロックの中の (キー, 値) を順に返す
function* blockEntries(block) {
  const restarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - restarts * 4;
  let p = 0, key = Buffer.alloc(0);
  while (p < end) {
    let shared, unshared, vlen;
    [shared, p] = varint(block, p);
    [unshared, p] = varint(block, p);
    [vlen, p] = varint(block, p);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(p, p + unshared)]);
    p += unshared;
    yield [key, block.subarray(p, p + vlen)];
    p += vlen;
  }
}

// .ldb（整理済みのデータ）→ {key, seq, del, value}
function* tableEntries(file) {
  if (file.length < 48) return;
  let p = file.length - 48, o, s;
  [o, p] = varint(file, p); [s, p] = varint(file, p);     // メタ情報の位置（使わない）
  [o, p] = varint(file, p); [s, p] = varint(file, p);     // 目次の位置
  for (const [, handle] of blockEntries(readBlock(file, o, s))) {
    const [bo, q] = varint(handle, 0);
    const [bs] = varint(handle, q);
    for (const [ikey, value] of blockEntries(readBlock(file, bo, bs))) {
      if (ikey.length < 8) continue;
      const tail = ikey.readBigUInt64LE(ikey.length - 8);
      yield { key: ikey.subarray(0, ikey.length - 8), seq: tail >> 8n, del: (tail & 0xffn) === 0n, value };
    }
  }
}

// .log（まだ整理されていない直近の書き込み）→ {key, seq, del, value}
function* logEntries(file) {
  const BLOCK = 32768;
  let p = 0, parts = [];
  while (p + 7 <= file.length) {
    const left = BLOCK - (p % BLOCK);
    if (left < 7) { p += left; continue; }
    const len = file.readUInt16LE(p + 4), type = file[p + 6];
    if (type === 0 && len === 0) { p += left; continue; }   // 未使用の領域
    const data = file.subarray(p + 7, p + 7 + len);
    p += 7 + len;
    if (data.length < len) return;                           // 書きかけの末尾
    if (type === 1) parts = [data];
    else if (type === 2) { parts = [data]; continue; }
    else if (type === 3) { parts.push(data); continue; }
    else if (type === 4) parts.push(data);
    else { parts = []; continue; }
    const rec = Buffer.concat(parts); parts = [];
    if (rec.length < 12) continue;
    let seq = rec.readBigUInt64LE(0), q = 12;
    const count = rec.readUInt32LE(8);
    for (let i = 0; i < count && q < rec.length; i++, seq++) {
      const tag = rec[q++];
      let klen, vlen = 0;
      [klen, q] = varint(rec, q);
      const key = rec.subarray(q, q + klen); q += klen;
      if (tag === 1) { [vlen, q] = varint(rec, q); }
      const value = rec.subarray(q, q + vlen); q += vlen;
      yield { key, seq, del: tag !== 1, value };
    }
  }
}

/* ---------- 本体 ---------- */
// Chrome の中の最新データを返す。読めなければ null（理由は reason に入れて返す）
export function readBrowserState() {
  if (!existsSync(DB_DIR)) return { state: null, reason: 'Chrome の保存領域が見つかりません' };
  // ローカルHTML（file://）の localStorage は「_file://」＋区切り＋キー名 で入っている
  const isOurs = k => k.subarray(0, 8).toString('latin1') === '_file://' && k.toString('latin1').endsWith(STORAGE_KEY);
  let best = null, broken = 0;
  for (const name of readdirSync(DB_DIR)) {
    const isLog = name.endsWith('.log'), isTable = name.endsWith('.ldb');
    if (!isLog && !isTable) continue;
    try {
      const file = readFileSync(join(DB_DIR, name));
      for (const e of (isLog ? logEntries(file) : tableEntries(file))) {
        if (!isOurs(e.key)) continue;
        if (!best || e.seq > best.seq) best = { seq: e.seq, del: e.del, value: Buffer.from(e.value) };
      }
    } catch { broken++; }   // Chrome が整理中で消えた・書きかけ、など。次回また読む
  }
  if (!best) return { state: null, reason: `Chrome の中に保存データが見つかりません${broken ? `（読めなかったファイル ${broken} 個）` : ''}` };
  if (best.del) return { state: null, reason: 'Chrome の中の保存データは消されています' };
  try {
    // 先頭1バイトが文字の入れ方（0 = UTF-16、1 = Latin-1）
    const text = best.value[0] === 0 ? best.value.subarray(1).toString('utf16le') : best.value.subarray(1).toString('latin1');
    const s = JSON.parse(text);
    if (!s || !Array.isArray(s.items) || !Array.isArray(s.groups)) throw new Error('形式が違います');
    return { state: s, reason: '' };
  } catch (e) {
    return { state: null, reason: 'Chrome の中の保存データを読み解けませんでした: ' + e.message };
  }
}

// bookmarks-raw.json を Chrome の中の最新データに合わせる。変えたら説明の文字列、変えなければ '' を返す。
export function syncRawFromBrowser({ write = true } = {}) {
  const { state, reason } = readBrowserState();
  if (!state) return { changed: false, note: reason };
  const next = JSON.stringify(state, null, 2);
  let prev = null;
  try { prev = JSON.parse(readFileSync(RAW, 'utf8')); } catch {}
  if (prev && JSON.stringify(prev, null, 2) === next) return { changed: false, note: '' };
  // 中身が空になる方向の上書きはしない（ブラウザのデータを消してしまった場合に、ファイル側を残すため）
  if (prev && Array.isArray(prev.items) && prev.items.length && !state.items.length) {
    return { changed: false, note: 'Chrome の中が0件なので、bookmarks-raw.json は上書きしませんでした' };
  }
  const before = new Set((prev && prev.items || []).map(i => i.id)), after = new Set(state.items.map(i => i.id));
  const added = state.items.filter(i => !before.has(i.id)).map(i => i.title || i.url);
  const removed = [...before].filter(id => !after.has(id)).length;
  if (write) writeFileSync(RAW, next);
  const parts = [];
  if (added.length) parts.push(`追加 ${added.length} 件（${added.join('、')}）`);
  if (removed) parts.push(`削除 ${removed} 件`);
  if (!parts.length) parts.push('内容の変更');
  return { changed: true, note: `Chrome の中の最新データを取り込みました：${parts.join(' / ')}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { state, reason } = readBrowserState();
  if (!state) { console.log(reason); process.exitCode = 1; }
  else {
    console.log(`Chrome の中：${state.items.length} 件 / グループ ${state.groups.length} 個`);
    const r = syncRawFromBrowser({ write: false });
    console.log(r.changed ? '（確認のみ）' + r.note : r.note || 'bookmarks-raw.json と同じです');
  }
}
