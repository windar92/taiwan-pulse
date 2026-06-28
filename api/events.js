// 地圖讀取端點：回傳近 N 天的策展事件。
import { listEvents } from "../lib/db.js";

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const days = Number(url.searchParams.get("days")) || 7;
    const events = await listEvents({ days, limit: 600 });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, s-maxage=120, stale-while-revalidate=600",
    });
    res.end(JSON.stringify({ ok: true, events }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}
