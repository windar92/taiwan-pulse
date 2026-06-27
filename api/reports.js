// Vercel serverless function：/api/reports
// GET  ?lat=&lng=&radius=&days=  → 列出附近的群眾回報（跨使用者共享）
// POST {lat,lng,place,kind,title,body,verdict} → 新增一筆回報
import { listReports, addReport } from "../lib/db.js";

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function radiusToKm(radius) {
  if (!radius) return 5;
  if (radius === "全國" || String(radius).toLowerCase() === "nationwide") return 9999;
  const m = String(radius).match(/[\d.]+/);
  return m ? Number(m[0]) : 5;
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  if (!data) return {};
  try { return JSON.parse(data); } catch { return {}; }
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const b = await readBody(req);
      if (!b.title || !b.body) return send(res, 400, { ok: false, error: "title 與 body 為必填" });
      const row = await addReport(b);
      return send(res, 200, { ok: true, report: row });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const lat = Number(url.searchParams.get("lat"));
    const lng = Number(url.searchParams.get("lng"));
    const radiusKm = radiusToKm(url.searchParams.get("radius"));
    const days = Number(url.searchParams.get("days")) || 7;
    const reports = await listReports({ lat, lng, radiusKm, days });
    return send(res, 200, { ok: true, reports });
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message });
  }
}
