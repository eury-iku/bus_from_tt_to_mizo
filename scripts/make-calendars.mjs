// scripts/make-calendars.mjs
// 使い方:
//   node scripts/make-calendars.mjs --zip path/to/gtfs.zip
//   # または GTFS_STATIC_ZIP / GTFS_STATIC_ZIP_URL

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 出力先
const DOCS_DIR = process.env.DOCS_DIR || "docs";

// 引数
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

// ZIP 取得
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

// ZIP 読み（deflate対応の簡易実装）
async function readFromZip(zipFile, wantNames) {
  const fd = fs.openSync(zipFile, "r");
  const stat = fs.fstatSync(fd);
  const size = stat.size;
  const EOCD_SIG = 0x06054b50;

  const maxComment = 0xffff;
  const readTail = Math.min(size, 22 + maxComment);
  const tail = Buffer.alloc(readTail);
  fs.readSync(fd, tail, 0, readTail, size - readTail);
  let eocdOffset = -1;
  for (let i = readTail - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocdOffset = size - readTail + i; break; }
  }
  if (eocdOffset < 0) throw new Error("ZIP: EOCD が見つかりません");

  const cdSize = readUInt32LE(fd, eocdOffset + 12);
  const cdOffset = readUInt32LE(fd, eocdOffset + 16);
  const cdBuf = Buffer.alloc(cdSize);
  fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

  const CEN_SIG = 0x02014b50;
  const entries = [];
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

  const wantSet = new Set(wantNames.map(n => n.toLowerCase()));
  const pick = entries.filter(e => wantSet.has(path.basename(e.name).toLowerCase()));

  const out = {};
  for (const e of pick) {
    out[path.basename(e.name)] = await extractEntryAsText(fd, e);
  }
  fs.closeSync(fd);
  return out;
}
function readUInt32LE(fd, pos) {
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, pos);
  return b.readUInt32LE(0);
}
async function extractEntryAsText(fd, e) {
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
  if (e.method === 0) raw = data;
  else if (e.method === 8) {
    const zlib = await import("node:zlib");
    raw = zlib.inflateRawSync(data);
  } else throw new Error(`圧縮方式 ${e.method} は未対応です`);
  return raw.toString("utf8");
}

// CSV
function parseCsv(text) {
  const lines = text.replace(/\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length === 1 && cols[0] === "") continue;
    const row = {};
    header.forEach((h, j) => row[h] = cols[j] ?? "");
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
    } else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, v) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(v)); }

(async () => {
  await ensureZipPath();

  // calendar / calendar_dates を読み込み（存在しない場合は空配列）
  const found = await readFromZip(zipPath, ["calendar.txt", "calendar_dates.txt"]);
  const calCsv = found["calendar.txt"] ? parseCsv(found["calendar.txt"]) : [];
  const datesCsv = found["calendar_dates.txt"] ? parseCsv(found["calendar_dates.txt"]) : [];

  // そのまま出力（軽量化のため数値化する列のみ型変換）
  const calendar = calCsv.map(r => ({
    service_id: r.service_id,
    monday: Number(r.monday||0), tuesday: Number(r.tuesday||0), wednesday: Number(r.wednesday||0),
    thursday: Number(r.thursday||0), friday: Number(r.friday||0), saturday: Number(r.saturday||0),
    sunday: Number(r.sunday||0),
    start_date: r.start_date, end_date: r.end_date
  }));

  const calendar_dates = datesCsv.map(r => ({
    service_id: r.service_id,
    date: r.date,
    exception_type: Number(r.exception_type||0)
  }));

  ensureDir(DOCS_DIR);
  writeJson(path.join(DOCS_DIR, "calendar.json"), calendar);
  writeJson(path.join(DOCS_DIR, "calendar_dates.json"), calendar_dates);

  console.log(`[make-calendars] calendar=${calendar.length}, calendar_dates=${calendar_dates.length}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
