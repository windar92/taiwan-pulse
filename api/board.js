// Neon 資料庫整併 router：?res=events|reports|feedback|ingest
//   events  GET  近 N 天策展事件
//   reports GET 附近群眾回報 / POST 新增回報
//   feedback GET 統計(或 ?list=1) / POST 新增錯誤回報
//   ingest  POST 由 GitHub Actions 觸發抓取(以 INGEST_SECRET 保護)
import { listEvents, listReports, addReport, addFeedback, feedbackStats, listFeedback } from "../lib/db.js";
import { runIngest } from "../lib/ingest.js";

export const config = { maxDuration: 60 };

function send(res, status, obj, cache = "no-store") {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  let d = ""; for await (const c of req) d += c;
  if (!d) return {};
  try { return JSON.parse(d); } catch { return {}; }
}
function radiusToKm(radius) {
  if (!radius) return 5;
  if (radius === "全國" || String(radius).toLowerCase() === "nationwide") return 9999;
  const m = String(radius).match(/[\d.]+/);
  return m ? Number(m[0]) : 5;
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "x"}`);
  const resType = url.searchParams.get("res") || "";
  try {
    if (resType === "events") {
      const days = Number(url.searchParams.get("days")) || 7;
      const events = await listEvents({ days, limit: 600 });
      return send(res, 200, { ok: true, events }, "public, s-maxage=120, stale-while-revalidate=600");
    }
    if (resType === "reports") {
      if (req.method === "POST") {
        const b = await readBody(req);
        if (!b.title || !b.body) return send(res, 400, { ok: false, error: "title 與 body 為必填" });
        const row = await addReport(b);
        return send(res, 200, { ok: true, report: row });
      }
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      const radiusKm = radiusToKm(url.searchParams.get("radius"));
      const days = Number(url.searchParams.get("days")) || 7;
      const reports = await listReports({ lat, lng, radiusKm, days });
      return send(res, 200, { ok: true, reports });
    }
    if (resType === "feedback") {
      if (req.method === "POST") {
        const b = await readBody(req);
        const opts = Array.isArray(b.options) ? b.options.join(",") : b.options;
        if (!opts) return send(res, 400, { ok: false, error: "缺少回報選項" });
        await addFeedback({ event_hash: b.event_hash, event_title: b.event_title, options: opts, note: b.note });
        return send(res, 200, { ok: true });
      }
      if (url.searchParams.get("list")) return send(res, 200, { ok: true, feedback: await listFeedback({ limit: 200 }) });
      return send(res, 200, { ok: true, stats: await feedbackStats() });
    }
    if (resType === "ingest") {
      const secret = process.env.INGEST_SECRET;
      const given = req.headers["x-ingest-secret"] || url.searchParams.get("key");
      if (secret && given !== secret) return send(res, 401, { ok: false, error: "unauthorized" });
      const result = await runIngest();
      return send(res, 200, { ok: true, ...result });
    }
    return send(res, 400, { ok: false, error: "未知 res，需 events|reports|feedback|ingest" });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
}
