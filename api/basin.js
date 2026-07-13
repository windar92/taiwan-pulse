// 集水區面積雨量：流域多邊形 + 即時雨量站 → 每個流域的面積平均雨量(Thiessen 網格法)
//
// 流域圖資：public/tw-basins.geojson（26 條中央管河川流域，WGS84 經緯度、已簡化）
//   來源：MERIT-Hydro / MERIT-Basins 水文地形（Yamazaki et al. 2019）經 mghydro.com
//   Global Watersheds API 以各河口為出水口逐條劃分，再以 Douglas-Peucker(≈400m) 簡化。
//   ※ 水利署官方「河川流域範圍圖」(data.gov.tw #9823) 只提供 SHP/KML 壓縮檔，
//     且 gic/maps.wra.gov.tw 對外連線不穩(常 connection reset)，不適合執行期抓取。
//
// 雨量站：中央氣象署 O-A0002-001（與 /api/weather 同源，約 1300 站、10 分鐘更新）
//   r1 = 近 1 小時累積雨量(mm)、r24 = 近 24 小時累積雨量(mm)
//
// 面積平均演算法：
//   1. 在流域外框以固定間距(預設 0.01°≈1.1km)鋪網格，只留落在多邊形內的網格點
//   2. 每個網格點取「最近的雨量站」的雨量 → 等權重平均
//      （等同 Thiessen 多邊形面積權重法的離散近似）
//   3. 若流域內完全沒有網格點(理論上不會)或找不到站 → r1/r24 = null
//   另外回報 nStations = 落在該流域多邊形內的測站數（0 代表全靠鄰近站外推，僅供參考）
export const config = { maxDuration: 60 };

import fs from "node:fs";
import path from "node:path";

const UA = { "User-Agent": "TaiwanPulse/0.1 (+map)" };
const GRID = 0.01;        // 網格間距(度)
const NEAR_BUF = 0.25;    // 取候選測站時，流域外框往外擴的緩衝(度)

function send(res, status, obj, cache) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache });
  res.end(JSON.stringify(obj));
}

// ---- 流域多邊形(模組層快取；serverless 熱啟動時免重讀) ----
let _basins = null;
const BASIN_FILES = [
  path.join(process.cwd(), "public", "tw-basins.geojson"),
  path.join(process.cwd(), "tw-basins.geojson"),
];
async function loadBasins(req) {
  if (_basins) return _basins;
  let raw = null;
  for (const p of BASIN_FILES) {
    try { if (fs.existsSync(p)) { raw = fs.readFileSync(p, "utf8"); break; } } catch {}
  }
  if (!raw) {
    // 打包時沒帶到檔案 → 從自己的靜態資源抓(public/ 會被當成 static asset 部署)
    const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host;
    const proto = req?.headers?.["x-forwarded-proto"] || "https";
    if (!host) throw new Error("找不到 tw-basins.geojson");
    const r = await fetch(`${proto}://${host}/tw-basins.geojson`, { headers: UA });
    if (!r.ok) throw new Error(`tw-basins.geojson ${r.status}`);
    raw = await r.text();
  }
  const gj = JSON.parse(raw);
  _basins = (gj.features || []).map((f) => {
    // 統一成 MultiPolygon 的外環陣列：rings = [[ [lng,lat], ... ], ...]
    const g = f.geometry || {};
    const polys = g.type === "Polygon" ? [g.coordinates] : (g.type === "MultiPolygon" ? g.coordinates : []);
    const rings = polys.map((p) => p[0]).filter((r) => Array.isArray(r) && r.length > 3);
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    for (const r of rings) for (const [x, y] of r) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return {
      name: f.properties?.name || "",
      area_km2: f.properties?.area_km2 ?? null,
      outlet: f.properties?.outlet || null,
      rings, bbox: [minX, minY, maxX, maxY],
      geometry: g,
    };
  }).filter((b) => b.name && b.rings.length);
  return _basins;
}

// ---- 雨量站 ----
async function loadStations(req) {
  const key = process.env.CWA_KEY;
  if (key) {
    const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${key}&format=JSON`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`CWA ${r.status}`);
    const j = await r.json();
    const arr = j?.records?.Station || [];
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    const pos = (v) => { const n = num(v); return n != null && n >= 0 ? n : 0; };
    const stations = [];
    for (const s of arr) {
      const coords = s.GeoInfo?.Coordinates || [];
      const wgs = coords.find((c) => c.CoordinateName === "WGS84") || coords[0];
      const lon = num(wgs?.StationLongitude), lat = num(wgs?.StationLatitude);
      if (lon == null || lat == null) continue;
      const re = s.RainfallElement || {};
      stations.push({ name: s.StationName, lon, lat, r1: pos(re.Past1hr?.Precipitation), r24: pos(re.Past24hr?.Precipitation) });
    }
    return { time: arr[0]?.ObsTime?.DateTime || null, stations };
  }
  // 沒有金鑰時退回打自己的 /api/weather（本機開發用）
  const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host;
  const proto = req?.headers?.["x-forwarded-proto"] || "https";
  if (!host) throw new Error("CWA_KEY 未設定");
  const r = await fetch(`${proto}://${host}/api/weather`, { headers: UA });
  const j = await r.json();
  if (!j?.ok) throw new Error(j?.error || "weather 失敗");
  return { time: j.time || null, stations: (j.stations || []).map((s) => ({ name: s.name, lon: s.lon, lat: s.lat, r1: s.r1 ?? 0, r24: s.r24 ?? 0 })) };
}

// ---- 幾何 ----
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inBasin(x, y, b) {
  const [minX, minY, maxX, maxY] = b.bbox;
  if (x < minX || x > maxX || y < minY || y > maxY) return false;
  for (const r of b.rings) if (inRing(x, y, r)) return true;
  return false;
}
// 經緯度近似平面距離平方(緯度 24° 附近，1° 經度 ≈ 0.91° 緯度)
const KX = Math.cos(24 * Math.PI / 180);
function d2(x1, y1, x2, y2) { const dx = (x1 - x2) * KX, dy = y1 - y2; return dx * dx + dy * dy; }

// ---- 面積雨量 ----
function areaRain(b, stations) {
  const [minX, minY, maxX, maxY] = b.bbox;
  const cand = stations.filter((s) =>
    s.lon >= minX - NEAR_BUF && s.lon <= maxX + NEAR_BUF && s.lat >= minY - NEAR_BUF && s.lat <= maxY + NEAR_BUF);
  if (!cand.length) return { r1: null, r24: null, nStations: 0, nCells: 0 };

  const nStations = cand.filter((s) => inBasin(s.lon, s.lat, b)).length;

  let cells = 0, s1 = 0, s24 = 0;
  const used = new Set();
  for (let y = Math.ceil(minY / GRID) * GRID; y <= maxY; y += GRID) {
    for (let x = Math.ceil(minX / GRID) * GRID; x <= maxX; x += GRID) {
      if (!inBasin(x, y, b)) continue;
      let best = null, bd = Infinity;
      for (const s of cand) { const d = d2(x, y, s.lon, s.lat); if (d < bd) { bd = d; best = s; } }
      if (!best) continue;
      cells++; s1 += best.r1; s24 += best.r24; used.add(best.name);
    }
  }
  if (!cells) {
    // 極小流域可能沒抓到網格點 → 退回「離出水口最近的站」
    const p = b.outlet || [(minX + maxX) / 2, (minY + maxY) / 2];
    let best = null, bd = Infinity;
    for (const s of cand) { const d = d2(p[0], p[1], s.lon, s.lat); if (d < bd) { bd = d; best = s; } }
    if (!best) return { r1: null, r24: null, nStations, nCells: 0 };
    return { r1: +best.r1.toFixed(1), r24: +best.r24.toFixed(1), nStations, nCells: 0, nUsed: 1, method: "nearest" };
  }
  return { r1: +(s1 / cells).toFixed(1), r24: +(s24 / cells).toFixed(1), nStations, nCells: cells, nUsed: used.size, method: "thiessen" };
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const withGeo = url.searchParams.get("geo") === "1";
  try {
    const [basins, wx] = await Promise.all([loadBasins(req), loadStations(req)]);
    const out = basins.map((b) => {
      const r = areaRain(b, wx.stations);
      const o = {
        id: b.name, name: b.name, area_km2: b.area_km2,
        r1: r.r1, r24: r.r24,
        nStations: r.nStations, nUsed: r.nUsed || 0, method: r.method || "none",
      };
      if (withGeo) o.polygon = b.geometry;
      return o;
    });
    out.sort((a, b) => (b.r24 ?? -1) - (a.r24 ?? -1));
    return send(res, 200, {
      ok: true,
      time: wx.time,
      count: out.length,
      stationCount: wx.stations.length,
      source: "流域範圍：MERIT-Basins(靜態 /tw-basins.geojson)；雨量：中央氣象署 O-A0002-001",
      basins: out,
    }, "s-maxage=300, stale-while-revalidate=600");
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message, basins: [] }, "no-store");
  }
}
