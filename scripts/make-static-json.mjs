// scripts/make-static-json.mjs
// Node 18+ (ESM) 前提。外部パッケージ不要。
// 使い方:
//   node scripts/make-static-json.mjs --zip path/to/gtfs.zip [--routes 10000,10054]
//   # または環境変数 GTFS_STATIC_ZIP / GTFS_STATIC_ZIP_URL / ROUTE_IDS を使用

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------- 設定（必要に応じて調整） ----------
const DOCS_DIR = process.env.DOCS_DIR || "docs";
const STOP_TIMES_OUT_DIR = path.join(DOCS_DIR, "stop_times/by_route");

// 保存する列（軽量化）
const KEEP = {
  stops: ["stop_id", "stop_name", "stop_lat", "stop_lon"],
  routes: ["route_id", "route_short_name", "route_long_name"],
  trips: ["trip_id", "route_id", "service_id", "trip_headsign", "direction_id"],
  stop_times: ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
};

// ---------- 引数・環境変数 ----------
const args = new Map(process.argv.slice(2).map((a, i, arr) => {
  if (a.startsWith("--")) {
    const k = a.replace(/^--/, "");
    const v = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true;
    return [k, v];
  }
  return [a, true];
}));
let zipPath = args.get("zip") || process.env.GTFS_STATIC_ZIP || "";
const zipUrl = process.env.GTFS_STATIC_ZIP_URL || "";
const routeFilterStr = args.get("routes") || process.env.ROUTE_IDS || "";
const routeFilter = new Set(
  routeFilterStr ? routeFilterStr.split(",").map(s => s.trim()).filter(Boolean) : []
);

// ---------- ユーティリティ ----------
async function ensureZipPath() {
  if (zipPath && fs.existsSync(zipPath)) return zipPath;
  if (!zipUrl) throw new Error("GTFS ZIP の場所が不明です。--zip か GTFS_STATIC_ZIP, または GTFS_STATIC_ZIP_URL を指定してください。");
  const tmp = path.join(os.tmpdir(), `gtfs-${Date.now()}.zip`);
  const res = await fetch(zipUrl);
  if (!res.ok) throw new Error(`ZIP ダウンロード失敗: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmp, buf);
  zipPath = tmp;
  return zipPath;
}

// ZIP からファイルを取り出してテキストで返す（外部コマンド不要）
async function readFromZip(zipFile, wantNames) {
  // すごく小さな ZIP リーダ（中央ディレクトリ探索）:
  // 実装簡素化のため、unzip コマンド無しで "必要なファイル名だけ" を抽出する。
  // 参考: ZIP EOCD シグネチャ 0x06054b50
  const fd = fs.openSync(zipFile, "r");
  const stat = fs.fstatSync(fd);
  const size = stat.size;

  // EOCD を後方から探索
  const EOCD_SIG = 0x06054b50;
  const maxComment = 0xffff; // 仕様上の最大
  const readTail = Math.min(size, 22 + maxComment);
  const tail = Buffer.alloc(readTail);
  fs.readSync(fd, tail, 0, readTail, size - readTail);

  let eocdOffset = -1;
  for (let i = readTail - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocdOffset = size - readTail + i; break; }
  }
  if (eocdOffset < 0) throw new Error("ZIP: EOCD が見つかりません");

  // EOCD から中央ディレクトリ位置とサイズを得る
  const cdSize = readUInt32LE(zipFile, fd, eocdOffset + 12);
  const cdOffset = readUInt32LE(zipFile, fd, eocdOffset + 16);
  const cdBuf = Buffer.alloc(cdSize);
  fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

  // 中央ディレクトリを走査して対象エントリを特定
  const CEN_SIG = 0x02014b50;
  const entries = []; // {name, localHeaderOffset, compSize, uncompSize, method}
  let p = 0;
  while (p + 46 <= cdBuf.length) {
    if (cdBuf.readUInt32LE(p) !== CEN_SIG) break;
    const method = cdBuf.readUInt16LE(p + 10);
    const compSize = cdBuf.readUInt32LE(p + 20);
    const uncompSize = cdBuf.readUInt32LE(p + 24);
    const nameLen = cdBuf.readUInt16LE(p + 28);
    const extraLen = cdBuf.readUInt16LE(p + 30);
    const commLen = cdBuf.readUInt16LE(p + 32);
    const localHdrOff = cdBuf.readUInt32LE(p + 42);
    const name = cdBuf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, localHdrOff, compSize, uncompSize, method });
    p += 46 + nameLen + extraLen + commLen;
  }

  // 名前マッチ（大小無視 & サブディレクトリ考慮）
  const wantSet = new Set(wantNames.map(n => n.toLowerCase()));
  const pick = entries.filter(e => {
    const base = path.basename(e.name).toLowerCase();
    return wantSet.has(base);
  });

  const out = {};
  for (const e of pick) {
    out[path.basename(e.name)] = await extractEntryAsText(fd, e);
  }
  fs.closeSync(fd);
  return out;
}

function readUInt32LE(zipFile, fd, pos) {
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, pos);
  return b.readUInt32LE(0);
}

async function extractEntryAsText(fd, e) {
  // ローカルヘッダ: 0x04034b50
  const LOCAL_SIG = 0x04034b50;
  const header = Buffer.alloc(30);
  fs.readSync(fd, header, 0, 30, e.localHdrOff);
  if (header.readUInt32LE(0) !== LOCAL_SIG) throw new Error("ZIP: local header broken");

  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  const dataStart = e.localHdrOff + 30 + nameLen + extraLen;

  const data = Buffer.alloc(e.compSize);
  fs.readSync(fd, data, 0, e.compSize, dataStart);

  let raw;
  if (e.method === 0) {
    raw = data; // stored
  } else if (e.method === 8) {
    // deflate
    const zlib = await import("node:zlib");
    raw = zlib.inflateRawSync(data);
  } else {
    throw new Error(`圧縮方式 ${e.method} は未対応です（deflateのみ対応）`);
  }
  return raw.toString("utf8");
}

// CSV パース（引用符対応・高速寄りの簡易実装）
function parseCsv(text) {
  const lines = text.replace(/\uFEFF/, "").split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length === 1 && cols[0] === "") continue;
    const row = {};
    header.forEach((h, j) => { row[h] = cols[j] ?? ""; });
    out.push(row);
  }
  return out;
}
function splitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (ch === "," && !inQ) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// 必要列だけに絞る & 型調整
function projectRows(rows, keepCols, numericCols = []) {
  return rows.map(r => {
    const o = {};
    for (const k of keepCols) o[k] = r[k] ?? "";
    for (const nk of numericCols) if (o[nk] !== "") o[nk] = Number(o[nk]);
    return o;
  });
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, v) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(v)); }

// ---------- メイン ----------
(async () => {
  await ensureZipPath();

  // 基本3表（stops/routes/trips）は一括読み
  const base = await readFromZip(zipPath, ["stops.txt", "routes.txt", "trips.txt"]);
  if (!base["stops.txt"] || !base["routes.txt"] || !base["trips.txt"]) {
    throw new Error("stops.txt / routes.txt / trips.txt のいずれかが見つかりません");
  }

  const stopsCsv = parseCsv(base["stops.txt"]);
  const routesCsv = parseCsv(base["routes.txt"]);
  const tripsCsv = parseCsv(base["trips.txt"]);

  // 軽量 JSON へ
  const stops = projectRows(stopsCsv, KEEP.stops);
  const routes = projectRows(routesCsv, KEEP.routes);
  const trips = projectRows(tripsCsv, KEEP.trips, ["direction_id"]);

  // 書き出し
  ensureDir(DOCS_DIR);
  writeJson(path.join(DOCS_DIR, "stops.json"), stops);
  writeJson(path.join(DOCS_DIR, "routes.json"), routes);
  writeJson(path.join(DOCS_DIR, "trips.json"), trips);

  // trip_id -> route_id の辞書（stop_times 分割用）
  const tripToRoute = new Map(trips.map(t => [t.trip_id, t.route_id]));

  // ルート絞り込み（任意）
  const routeAllowed = routeFilter.size ? routeFilter : null;

  // stop_times を route_id ごとに分割書き出し
  const stText = (await readFromZip(zipPath, ["stop_times.txt"]))["stop_times.txt"];
  if (!stText) throw new Error("stop_times.txt が見つかりません");
  const stRows = parseCsv(stText);

  // まず必要列に絞る + 型
  const slim = projectRows(stRows, KEEP.stop_times, ["stop_sequence"]);

  // route_id 付与 → グループ化
  /** @type {Record<string, any[]>} */
  const byRoute = {};
  for (const r of slim) {
    const rid = tripToRoute.get(r.trip_id);
    if (!rid) continue; // 孤立データは無視
    if (routeAllowed && !routeAllowed.has(String(rid))) continue;
    (byRoute[rid] ||= []).push(r);
  }

  // 各ルートファイルを書き出し（時刻昇順＆trip_idで安定ソート）
  ensureDir(STOP_TIMES_OUT_DIR);
  for (const [rid, arr] of Object.entries(byRoute)) {
    arr.sort((a, b) => {
      // HH:MM:SS を比較
      const aT = (a.departure_time || a.arrival_time || "00:00:00").split(":").map(Number);
      const bT = (b.departure_time || b.arrival_time || "00:00:00").split(":").map(Number);
      const aS = aT[0] * 3600 + aT[1] * 60 + (aT[2] || 0);
      const bS = bT[0] * 3600 + bT[1] * 60 + (bT[2] || 0);
      if (aS !== bS) return aS - bS;
      if (a.trip_id !== b.trip_id) return String(a.trip_id).localeCompare(String(b.trip_id));
      return a.stop_sequence - b.stop_sequence;
    });
    const outPath = path.join(STOP_TIMES_OUT_DIR, `${rid}.json`);
    writeJson(outPath, arr);
  }

  // 軽いサマリ
  const routeCount = Object.keys(byRoute).length;
  const rowCount = Object.values(byRoute).reduce((s, a) => s + a.length, 0);
  console.log(`[make-static-json] routes=${routes.length}, trips=${trips.length}, stops=${stops.length}`);
  console.log(`[make-static-json] stop_times: ${rowCount} rows -> ${routeCount} files in ${STOP_TIMES_OUT_DIR}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
