// routeで絞ってから、さらにORIGIN→DESTを通るtripに絞って JSON 出力
import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

const BASE = "gtfs_static";

// ---- 環境変数（ワークフローから渡せる）----
const ROUTE_ID_LIST = (process.env.ROUTE_ID_LIST || "")
  .split(",").map(s => s.trim()).filter(Boolean);         // 例: ["1001","1002"]
const ROUTE_SHORT_NAME_REGEX = process.env.ROUTE_SHORT_NAME_REGEX
  ? new RegExp(process.env.ROUTE_SHORT_NAME_REGEX) : null; // 例: /^(溝口|たいら)$/

const ORIGIN_STOP_ID = process.env.ORIGIN_STOP_ID || "";   // 例: "260_1"
const DEST_STOP_ID   = process.env.DEST_STOP_ID   || "";   // 例: "434_5"
// ---------------------------------------------

function readCsv(file) {
  const text = fs.readFileSync(path.join(BASE, file), "utf8");
  return parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true });
}

function main() {
  console.log("Reading GTFS CSVs...");
  const stops     = readCsv("stops.txt");
  const trips     = readCsv("trips.txt");
  const routes    = readCsv("routes.txt");
  const stopTimes = readCsv("stop_times.txt");

  // 1) routeの許可集合を作成
  let allowedRouteIds = new Set();

  if (ROUTE_ID_LIST.length) {
    for (const id of ROUTE_ID_LIST) allowedRouteIds.add(id);
  }
  if (ROUTE_SHORT_NAME_REGEX) {
    for (const r of routes) {
      const short = (r.route_short_name || "").trim();
      if (ROUTE_SHORT_NAME_REGEX.test(short)) allowedRouteIds.add(r.route_id);
    }
  }

  // 何も指定されなければ全route許可（あとで起点/終点でスリム化）
  if (!ROUTE_ID_LIST.length && !ROUTE_SHORT_NAME_REGEX) {
    for (const r of routes) allowedRouteIds.add(r.route_id);
  }

  console.log(`Allowed routes: ${allowedRouteIds.size}`);

  // 2) 許可routeに属するtripのみ保持
  const tripsFiltered = trips.filter(t => allowedRouteIds.has(t.route_id));
  const tripIdAllowed = new Set(tripsFiltered.map(t => t.trip_id));

  // 3) stop_times を tripごとにまとめ＆シーケンス順
  /** @type {Map<string, any[]>} */
  const stopTimesByTrip = new Map();
  for (const st of stopTimes) {
    if (!tripIdAllowed.has(st.trip_id)) continue;
    st.stop_sequence = Number(st.stop_sequence);
    (stopTimesByTrip.get(st.trip_id) ?? stopTimesByTrip.set(st.trip_id, []).get(st.trip_id)).push(st);
  }
  for (const arr of stopTimesByTrip.values()) arr.sort((a,b)=>a.stop_sequence-b.stop_sequence);

  // 4) ORIGIN→DEST 指定があれば、その区間を通るtripだけさらに抽出
  let finalTripIds = new Set(stopTimesByTrip.keys());
  if (ORIGIN_STOP_ID && DEST_STOP_ID) {
    const keep = new Set();
    for (const [tripId, arr] of stopTimesByTrip) {
      let originIdx = -1, destIdx = -1;
      for (let i=0; i<arr.length; i++) {
        if (arr[i].stop_id === ORIGIN_STOP_ID && originIdx === -1) originIdx = i;
        if (arr[i].stop_id === DEST_STOP_ID) { destIdx = i; break; }
      }
      if (originIdx !== -1 && destIdx !== -1 && destIdx > originIdx) keep.add(tripId);
    }
    finalTripIds = keep;
  }
  console.log(`Trips after filters: ${finalTripIds.size}`);

  // 5) 最終セットで JSON を作る
  const slimTrips  = tripsFiltered.filter(t => finalTripIds.has(t.trip_id));
  const slimRoutes = routes.filter(r => slimTrips.some(t => t.route_id === r.route_id));

  const slimStopTimes = [];
  const keepStops = new Set();
  for (const t of slimTrips) {
    const arr = stopTimesByTrip.get(t.trip_id) || [];
    for (const st of arr) {
      slimStopTimes.push({
        trip_id: t.trip_id,
        arrival_time: st.arrival_time,
        departure_time: st.departure_time,
        stop_id: st.stop_id,
        stop_sequence: st.stop_sequence
      });
      keepStops.add(st.stop_id);
    }
  }
  const slimStops = stops.filter(s => keepStops.has(s.stop_id));

  // 6) docs に出力
  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync("docs/stops.json", JSON.stringify(slimStops), "utf8");
  fs.writeFileSync("docs/trips.json", JSON.stringify(slimTrips), "utf8");
  fs.writeFileSync("docs/stop_times.json", JSON.stringify(slimStopTimes), "utf8");
  fs.writeFileSync("docs/routes.json", JSON.stringify(slimRoutes), "utf8");

  for (const f of ["docs/stops.json","docs/trips.json","docs/stop_times.json","docs/routes.json"]) {
    const mb = (fs.statSync(f).size/1024/1024).toFixed(2);
    console.log(`${f}: ${mb} MB`);
  }
}

main();
