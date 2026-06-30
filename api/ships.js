// 讀取最近的中國籍船舶(由 ships-collect 收集寫入)。
import { listShips, shipsRaw } from "../lib/db.js";
export default async function handler(req, res) {
  const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "s-maxage=60, stale-while-revalidate=120" }); res.end(JSON.stringify(o)); };
  try {
    const url = new URL(req.url, "http://x");
    if (url.searchParams.get("debug") === "1") {
      const raw = await shipsRaw();
      const recent = await listShips({ minutes: 4320, limit: 5 });
      return send(200, { ok: true, raw, sampleCount: recent.length, sample: recent });
    }
    const ships = await listShips({ minutes: 180, limit: 6000 });
    return send(200, { ok: true, count: ships.length, ships });
  } catch (e) {
    return send(500, { ok: false, error: e.message, ships: [] });
  }
}
