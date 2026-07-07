// Neon 資料庫整併 router：?res=events|reports|feedback|ingest
//   events  GET  近 N 天策展事件
//   reports GET 附近群眾回報 / POST 新增回報
//   feedback GET 統計(或 ?list=1) / POST 新增錯誤回報
//   ingest  POST 由 GitHub Actions 觸發抓取(以 INGEST_SECRET 保護)
import { listEvents, listReports, addReport, addFeedback, feedbackStats, listFeedback, upsertRiverMeta, upsertRiverLevel } from "../lib/db.js";
import { runIngest } from "../lib/ingest.js";

export const config = { maxDuration: 60 };

// ---- 河川水位收集(水利署免金鑰開放資料) ----
const RIVER_STATION_URL = "https://opendata.wra.gov.tw/api/v2/c4acc691-7416-40ca-9464-292c0c00da92?format=JSON";
const RIVER_LEVEL_URL = "https://opendata.wra.gov.tw/api/v2/73c4c3de-4045-4765-abeb-89f9f9cd5ff0?format=JSON";
// TWD97 TM2 (EPSG:3826) -> WGS84 lon/lat（已用 round-trip 驗證）
function twd97ToWgs84(E, N) {
  const a = 6378137.0, f = 1 / 298.257222101, e2 = 2 * f - f * f, k0 = 0.9999, lon0 = 121 * Math.PI / 180, FE = 250000, FN = 0;
  const ep2 = e2 / (1 - e2), M = (N - FN) / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2), T1 = Math.tan(phi1) ** 2, C1 = ep2 * Math.cos(phi1) ** 2;
  const R1 = a * (1 - e2) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5, D = (E - FE) / (N1 * k0);
  const lat = phi1 - (N1 * Math.tan(phi1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(phi1);
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}
function rnum(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function lcKeys(o) { const m = {}; for (const k in o) m[k.toLowerCase()] = o[k]; return m; }
// 由座標字串自動判斷 E/N（E≈13萬~38萬, N≈150萬~300萬），避免欄位順序猜錯
function parseTwd97(s) {
  const nums = (String(s == null ? "" : s).match(/-?\d+(\.\d+)?/g) || []).map(Number);
  let E = null, N = null;
  for (const v of nums) { if (v >= 1.5e6 && v <= 3e6) N = v; else if (v >= 1e5 && v <= 4e5) E = v; }
  if (E == null || N == null) return [null, null];
  const [lng, lat] = twd97ToWgs84(E, N);
  if (lng < 118 || lng > 123 || lat < 21 || lat > 26.5) return [null, null];
  return [lng, lat];
}
function asArray(j) { return Array.isArray(j) ? j : (j?.responseData || j?.result?.records || j?.records || j?.data || []); }
async function riverCollect() {
  const UA = { "User-Agent": "TaiwanPulse/0.1 (+map)" };
  const [sRes, lRes] = await Promise.all([fetch(RIVER_STATION_URL, { headers: UA }), fetch(RIVER_LEVEL_URL, { headers: UA })]);
  const sJson = await sRes.json(), lJson = await lRes.json();
  const stations = asArray(sJson).map(lcKeys).map((r) => {
    const [lng, lat] = parseTwd97(r.locationbytwd97_xy);
    return { id: r.observatoryidentifier, name: r.observatoryname, river: r.rivername, lng, lat, warn1: rnum(r.alertlevel1), warn2: rnum(r.alertlevel2), warn3: rnum(r.alertlevel3), zero_elev: rnum(r.elevationofwaterlevelzeropoint) };
  }).filter((s) => s.id);
  const levels = asArray(lJson).map(lcKeys).map((r) => ({ id: r.observatoryidentifier || r.stationid, level: rnum(r.waterlevel), time: r.datetime || r.recordtime || r.time || null })).filter((r) => r.id && typeof r.level === "number");
  const metaUpserted = await upsertRiverMeta(stations);
  const levelUpserted = await upsertRiverLevel(levels);
  return { ok: true, stations: stations.length, withCoord: stations.filter((s) => s.lng != null).length, metaUpserted, levels: levels.length, levelUpserted, sampleStation: stations.find((s) => s.lng != null) || null, sampleLevel: levels[0] || null };
}

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
    if (resType === "river-collect") {
      return send(res, 200, await riverCollect());
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
