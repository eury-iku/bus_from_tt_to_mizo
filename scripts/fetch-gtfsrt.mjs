// scripts/fetch-gtfsrt.mjs
import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import fs from "fs/promises";

async function main() {
  const url = process.env.GTFSRT_URL;
  if (!url) {
    throw new Error("GTFSRT_URL env is required (set it via GitHub Secrets).");
  }

  const res = await fetch(url, { timeout: 30000 });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);

  // index2.html が想定している形に合わせて整形
  const out = {
    generated_at: new Date().toISOString(),
    entity: (feed.entity || [])
      .filter(e => e.tripUpdate)
      .map(e => ({
        id: e.id,
        tripUpdate: {
          trip: {
            tripId: e.tripUpdate?.trip?.tripId,
            routeId: e.tripUpdate?.trip?.routeId,
            directionId: e.tripUpdate?.trip?.directionId,
            startDate: e.tripUpdate?.trip?.startDate,
          },
          stopTimeUpdate: (e.tripUpdate?.stopTimeUpdate || []).map(u => ({
            stopId: u.stopId,
            stopSequence: u.stopSequence,
            arrival: u.arrival
              ? { time: Number(u.arrival.time), delay: Number(u.arrival.delay) }
              : undefined,
            departure: u.departure
              ? { time: Number(u.departure.time), delay: Number(u.departure.delay) }
              : undefined,
            scheduleRelationship: u.scheduleRelationship,
          })),
          scheduleRelationship: e.tripUpdate?.scheduleRelationship,
          timestamp: e.tripUpdate?.timestamp
            ? Number(e.tripUpdate.timestamp)
            : undefined,
        },
      })),
  };

  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(
    "docs/realtime_tripupdates.json",
    JSON.stringify(out),
    "utf8"
  );
  console.log("Wrote docs/realtime_tripupdates.json");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
