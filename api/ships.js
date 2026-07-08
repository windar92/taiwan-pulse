// 船舶 AIS 整併：?action=read(預設) 讀取中國籍船舶 / ?action=collect 連 AISStream 收集寫入。
// collect 由排程(GitHub Actions)觸發，需環境變數 AISSTREAM_KEY。
import WebSocket from "ws";
import { listShips, shipsRaw, upsertShips, pruneShips, appendShipTracks, listShipTracks, shipTracksRaw, pruneShipTracks } from "../lib/db.js";

export const config = { maxDuration: 60 };

const send = (res, s, o, cache) => { res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache }); res.end(JSON.stringify(o)); };

function shipClass(t) {
  if (t == null) return null;
  if (t === 30) return "漁船";
  if (t === 31 || t === 32 || t === 52) return "拖船作業";
  if (t >= 60 && t <= 69) return "客船";
  if (t >= 70 && t <= 79) return "貨船";
  if (t >= 80 && t <= 89) return "油輪/化學船";
  if (t >= 40 && t <= 49) return "高速船";
  if (t === 35) return "軍事";
  return "其他";
}

async function readHandler(req, res, url) {
  try {
    if (url.searchParams.get("debug") === "1") {
      const raw = await shipsRaw();
      const recent = await listShips({ minutes: 4320, limit: 5 });
      return send(res, 200, { ok: true, raw, sampleCount: recent.length, sample: recent }, "no-store");
    }
    const ships = await listShips({ minutes: 180, limit: 6000 });
    return send(res, 200, { ok: true, count: ships.length, ships }, "s-maxage=60, stale-while-revalidate=120");
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message, ships: [] }, "no-store");
  }
}

async function collectHandler(req, res, url) {
  const key = process.env.AISSTREAM_KEY;
  if (!key) return send(res, 200, { ok: false, error: "AISSTREAM_KEY 未設定" }, "no-store");
  const ships = new Map();
  const isCN = (m) => { const p = String(m || "").slice(0, 3); return p === "412" || p === "413" || p === "414"; };
  const winMs = Math.min(Math.max(Number(url.searchParams.get("ms")) || 38000, 3000), 55000);
  const debug = url.searchParams.get("debug") === "1";
  const diag = { total: 0, cn: 0, errors: [], opened: false };
  await new Promise((resolve) => {
    let ws, done = false;
    const finish = () => { if (done) return; done = true; try { ws && ws.close(); } catch {} resolve(); };
    const timer = setTimeout(finish, winMs);
    try {
      ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
      ws.on("open", () => {
        diag.opened = true;
        ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[5, 108], [30, 128]], [[30, 117], [46, 145]]], FilterMessageTypes: ["PositionReport", "ShipStaticData"] }));
      });
      ws.on("message", (buf) => {
        let m; try { m = JSON.parse(buf.toString()); } catch { return; }
        diag.total++;
        if (m.error || m.Error) { if (diag.errors.length < 3) diag.errors.push(m.error || m.Error); return; }
        const mmsi = m?.MetaData?.MMSI; if (!isCN(mmsi)) return;
        diag.cn++;
        const id = String(mmsi);
        const cur = ships.get(id) || { mmsi: id };
        if (m.MessageType === "PositionReport") {
          const p = m.Message?.PositionReport || {};
          if (typeof p.Latitude === "number") { cur.lat = p.Latitude; cur.lng = p.Longitude; }
          if (typeof p.Sog === "number") cur.sog = p.Sog;
          if (typeof p.Cog === "number") cur.cog = p.Cog;
          if (typeof p.NavigationalStatus === "number") cur.navstat = p.NavigationalStatus;
          if (m.MetaData?.ShipName) cur.name = String(m.MetaData.ShipName).trim();
        } else if (m.MessageType === "ShipStaticData") {
          const sd = m.Message?.ShipStaticData || {};
          if (typeof sd.Type === "number") { cur.shiptype = sd.Type; cur.cls = shipClass(sd.Type); }
          cur.name = String(sd.Name || m.MetaData?.ShipName || cur.name || "").trim() || cur.name;
        }
        ships.set(id, cur);
      });
      ws.on("error", finish);
      ws.on("close", () => { clearTimeout(timer); finish(); });
    } catch { finish(); }
  });
  const list = [...ships.values()].filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
  let inserted = 0, tracked = 0;
  try {
    inserted = await upsertShips(list);
    tracked = await appendShipTracks(list).catch(() => 0);
    await pruneShips(24).catch(() => {});
    await pruneShipTracks(7).catch(() => {});
  } catch (e) { return send(res, 500, { ok: false, error: e.message, collected: list.length, diag }, "no-store"); }
  return send(res, 200, { ok: true, collected: list.length, upserted: inserted, tracked, ...(debug ? { diag } : {}) }, "no-store");
}

// ---- 近 7 天航跡 + 異常分析 ----
function haversineKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLng = (b[0] - a[0]) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function analyzeTrack(pts) {
  // pts: [[lng,lat,tsMs,sog],...] 已依時間排序
  if (pts.length < 3) return { flag: "normal", reason: "點數不足", pathKm: 0, dispKm: 0, spanKm: 0, hours: 0, avgSog: null };
  let pathKm = 0;
  for (let i = 1; i < pts.length; i++) pathKm += haversineKm(pts[i - 1], pts[i]);
  const dispKm = haversineKm(pts[0], pts[pts.length - 1]);
  let minLng = 1e9, maxLng = -1e9, minLat = 1e9, maxLat = -1e9, sog = 0, sogN = 0;
  for (const p of pts) { minLng = Math.min(minLng, p[0]); maxLng = Math.max(maxLng, p[0]); minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]); if (typeof p[3] === "number") { sog += p[3]; sogN++; } }
  const spanKm = haversineKm([minLng, minLat], [maxLng, maxLat]);
  const hours = (pts[pts.length - 1][2] - pts[0][2]) / 3600000;
  const avgSog = sogN ? sog / sogN : null;
  const ratio = pathKm / Math.max(dispKm, 0.15);
  let flag = "normal", reason = "正常進出/航行";
  if (spanKm < 6 && hours > 3 && ((avgSog != null && avgSog < 2) || pathKm < 4)) { flag = "loiter"; reason = `逗留：${hours.toFixed(1)}h 內活動範圍僅約 ${spanKm.toFixed(1)}km`; }
  else if (dispKm > 8 && ratio > 2.2 && hours > 1) { flag = "detour"; reason = `繞行/折返：航跡 ${pathKm.toFixed(0)}km 但淨位移僅 ${dispKm.toFixed(0)}km`; }
  return { flag, reason, pathKm: +pathKm.toFixed(1), dispKm: +dispKm.toFixed(1), spanKm: +spanKm.toFixed(1), hours: +hours.toFixed(1), avgSog: avgSog == null ? null : +avgSog.toFixed(1) };
}
async function tracksHandler(req, res, url) {
  try {
    if (url.searchParams.get("debug") === "1") return send(res, 200, { ok: true, raw: await shipTracksRaw() }, "no-store");
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 7);
    const rows = await listShipTracks({ days });
    const meta = new Map();
    try { for (const s of await listShips({ minutes: 7 * 24 * 60, limit: 8000 })) meta.set(String(s.mmsi), { name: s.name, cls: s.cls }); } catch {}
    const byShip = new Map();
    for (const r of rows) {
      const id = String(r.mmsi);
      let a = byShip.get(id); if (!a) { a = []; byShip.set(id, a); }
      a.push([r.lng, r.lat, new Date(r.ts).getTime(), r.sog]);
    }
    const vessels = [], counts = { loiter: 0, detour: 0, normal: 0 };
    for (const [mmsi, ptsRaw] of byShip) {
      if (ptsRaw.length < 2) continue; // 單點無法成軌跡
      let pts = ptsRaw;
      if (pts.length > 240) { const step = Math.ceil(pts.length / 240); pts = pts.filter((_, i) => i % step === 0 || i === ptsRaw.length - 1); }
      const stat = analyzeTrack(pts);
      counts[stat.flag]++;
      const mt = meta.get(mmsi) || {};
      vessels.push({ mmsi, name: mt.name || null, cls: mt.cls || null, ...stat, points: pts });
    }
    // 異常者排前面
    vessels.sort((x, y) => (x.flag === "normal" ? 1 : 0) - (y.flag === "normal" ? 1 : 0) || y.pathKm - x.pathKm);
    return send(res, 200, { ok: true, days, vessels: vessels.length, counts, tracks: vessels }, "s-maxage=120, stale-while-revalidate=300");
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message, tracks: [] }, "no-store");
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const action = url.searchParams.get("action") || "read";
  if (action === "collect") return collectHandler(req, res, url);
  if (action === "tracks") return tracksHandler(req, res, url);
  return readHandler(req, res, url);
}
