// 即時環境資料唯讀代理(整併)：?ds=rain|temp|typhoon|quake (中央氣象署, 需 CWA_KEY)
//                                 |ocean (台大 ODB 海溫, 免金鑰)
//                                 |peaks (OSM Overpass 山岳, 多用於產生靜態檔)
export const config = { maxDuration: 60 };

import { listRiverStations, riverRaw } from "../lib/db.js";

const UA = { "User-Agent": "TaiwanPulse/0.1 (+map)" };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

function send(res, status, obj, cache) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache });
  res.end(JSON.stringify(obj));
}

// ---- 雨量 O-A0002-001 ----
async function rain(key) {
  const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${key}&format=JSON`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`CWA ${r.status}`);
  const j = await r.json();
  const arr = j?.records?.Station || [];
  const pos = (v) => { const n = num(v); return n != null && n >= 0 ? n : 0; };
  const stations = [];
  for (const s of arr) {
    const coords = s.GeoInfo?.Coordinates || [];
    const wgs = coords.find((c) => c.CoordinateName === "WGS84") || coords[0];
    const lon = num(wgs?.StationLongitude), lat = num(wgs?.StationLatitude);
    if (lon == null || lat == null) continue;
    const re = s.RainfallElement || {};
    stations.push({ name: s.StationName, lon, lat, alt: num(s.GeoInfo?.StationAltitude), county: s.GeoInfo?.CountyName, town: s.GeoInfo?.TownName, r1: pos(re.Past1hr?.Precipitation), now: pos(re.Now?.Precipitation), r3: pos(re.Past3hr?.Precipitation), r24: pos(re.Past24hr?.Precipitation) });
  }
  return { ok: true, time: arr[0]?.ObsTime?.DateTime || null, count: stations.length, stations };
}

// ---- 氣溫/氣象站 O-A0001-001 ----
async function temp(key) {
  const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001?Authorization=${key}&format=JSON`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`CWA ${r.status}`);
  const j = await r.json();
  const arr = j?.records?.Station || [];
  const stations = [];
  for (const s of arr) {
    const coords = s.GeoInfo?.Coordinates || [];
    const wgs = coords.find((c) => c.CoordinateName === "WGS84") || coords[0];
    const lon = num(wgs?.StationLongitude), lat = num(wgs?.StationLatitude);
    if (lon == null || lat == null) continue;
    const w = s.WeatherElement || {};
    const t = num(w.AirTemperature);
    stations.push({ name: s.StationName, lon, lat, county: s.GeoInfo?.CountyName, town: s.GeoInfo?.TownName, alt: num(s.GeoInfo?.StationAltitude), temp: (t != null && t > -50) ? t : null, weather: w.Weather, wind: num(w.WindSpeed), humidity: num(w.RelativeHumidity), pressure: num(w.AirPressure), rain: num(w.Now?.Precipitation) });
  }
  return { ok: true, time: arr[0]?.ObsTime?.DateTime || null, count: stations.length, stations };
}

// ---- 颱風 W-C0034-005 ----
async function typhoon(key) {
  const quad = (c) => { if (!c) return null; const q = {}; const rs = c.QuadrantRadii?.Radius || []; for (const r of (Array.isArray(rs) ? rs : [rs])) q[r.dir] = num(r.value); q.r = num(c.Radius); return q; };
  const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005?Authorization=${key}&format=JSON`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`CWA ${r.status}`);
  const j = await r.json();
  const tcs = j?.records?.TropicalCyclones?.TropicalCyclone || [];
  const typhoons = (Array.isArray(tcs) ? tcs : []).map((tc) => {
    const fixA = tc.AnalysisData?.Fix || [];
    const fixF = tc.ForecastData?.Fix || [];
    const analysis = (Array.isArray(fixA) ? fixA : []).map((f) => ({ time: f.DateTime, lon: num(f.CoordinateLongitude), lat: num(f.CoordinateLatitude), wind: num(f.MaxWindSpeed), gust: num(f.MaxGustSpeed), pressure: num(f.Pressure), r15: quad(f.Circle15ms), r25: quad(f.Circle25ms) })).filter((p) => p.lon != null && p.lat != null);
    const forecast = (Array.isArray(fixF) ? fixF : []).map((f) => ({ time: f.InitialTime, hour: f.ForecastHour, lon: num(f.CoordinateLongitude), lat: num(f.CoordinateLatitude), wind: num(f.MaxWindSpeed), pressure: num(f.Pressure), r70: num(f.Radius70PercentProbability) })).filter((p) => p.lon != null && p.lat != null);
    return { name: tc.CwaTyphoonName || tc.TyphoonName, enName: tc.TyphoonName, no: tc.CwaTyNo, analysis, forecast };
  }).filter((t) => t.analysis.length || t.forecast.length);
  return { ok: true, count: typhoons.length, typhoons };
}

// ---- 地震 E-A0015 + E-A0016 ----
async function quake(key) {
  const intNum = (s) => { const m = String(s || "").match(/(\d)/); let n = m ? parseInt(m[1]) : 0; if (String(s).includes("強")) n += 0.5; return n; };
  const mapEq = (e) => {
    const info = e.EarthquakeInfo || {}, ep = info.Epicenter || {};
    const stations = [];
    for (const area of (e.Intensity?.ShakingArea || [])) for (const st of (area.EqStation || [])) {
      const lat = st.StationLatitude, lon = st.StationLongitude;
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      const intv = intNum(st.SeismicIntensity); if (intv <= 0) continue;
      stations.push({ name: st.StationName, lon, lat, int: intv, intLabel: st.SeismicIntensity });
    }
    return { no: e.EarthquakeNo, time: info.OriginTime, mag: info.EarthquakeMagnitude?.MagnitudeValue, depth: info.FocalDepth, lat: ep.EpicenterLatitude, lon: ep.EpicenterLongitude, location: ep.Location, color: e.ReportColor, content: e.ReportContent, web: e.Web, stations };
  };
  const all = [];
  for (const id of ["E-A0015-001", "E-A0016-001"]) {
    try {
      const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${id}?Authorization=${key}&format=JSON&limit=50`;
      const r = await fetch(url, { headers: UA });
      if (!r.ok) continue;
      const j = await r.json();
      for (const e of (j?.records?.Earthquake || [])) all.push(mapEq(e));
    } catch {}
  }
  all.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  const seen = new Set(), uniq = [];
  for (const q of all) { if (typeof q.lat !== "number" || typeof q.lon !== "number") continue; const k = String(q.time); if (seen.has(k)) continue; seen.add(k); uniq.push(q); }
  return { ok: true, count: uniq.length, quakes: uniq.slice(0, 40) };
}

// ---- 海溫 台大 ODB ----
async function ocean() {
  const now = new Date();
  const first = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  const back = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const url = `https://eco.odb.ntu.edu.tw/api/mhw?lon0=117&lon1=124&lat0=20&lat1=27&start=${first(back)}&end=${first(now)}&append=sst,sst_anomaly,level`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`ODB ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr) || !arr.length) return { ok: true, date: null, points: [] };
  let latest = ""; for (const p of arr) if (p.date > latest) latest = p.date;
  const points = arr.filter((p) => p.date === latest && p.sst != null).map((p) => ({ lon: p.lon, lat: p.lat, sst: p.sst, anom: p.sst_anomaly, level: p.level }));
  return { ok: true, date: latest, count: points.length, points };
}

// ---- 山岳 OSM Overpass(主要供產生 public/peaks.json) ----
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// 依序試各鏡像，帶正確標頭(Accept/User-Agent)避免 406/被擋
async function overpassFetch(query) {
  let lastErr = "";
  for (const base of OVERPASS_MIRRORS) {
    try {
      const r = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "User-Agent": "taiwan-pulse/1.0 (https://taiwan-pulse-five.vercel.app)" },
        body: "data=" + encodeURIComponent(query),
      });
      if (r.ok) return await r.json();
      lastErr = base + " " + r.status;
    } catch (e) { lastErr = base + " " + e.message; }
  }
  throw new Error("overpass all failed: " + lastErr);
}
const PEAKS_Q = `[out:json][timeout:50];
(node[natural=peak][name][ele](21.8,120.0,25.4,122.1);
 node[natural=peak][name]["ele:local"](21.8,120.0,25.4,122.1););
out;`;
const peakTier = (e) => e >= 3000 ? "百岳級" : e >= 2000 ? "高山" : e >= 1000 ? "中級山" : "郊山";
let _peakCache = null, _peakAt = 0;
async function peaks(minEle) {
  if (!_peakCache || Date.now() - _peakAt > 6 * 3600 * 1000) {
    const j = await overpassFetch(PEAKS_Q);
    const seen = new Set(), out = [];
    for (const el of j.elements || []) {
      const name = el.tags?.name; if (!name) continue;
      const ele = Math.round(parseFloat(String(el.tags?.ele ?? el.tags?.["ele:local"]).replace(/[^\d.\-]/g, "")));
      if (!Number.isFinite(ele) || ele <= 0 || ele > 4200) continue; // 台灣最高玉山 3952m，超過視為髒資料
      if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
      const k = name + "@" + el.lat.toFixed(3); if (seen.has(k)) continue; seen.add(k);
      out.push({ name, name_en: el.tags?.["name:en"] || null, lng: el.lon, lat: el.lat, ele, tier: peakTier(ele) });
    }
    out.sort((a, b) => b.ele - a.ele);
    _peakCache = out; _peakAt = Date.now();
  }
  const peaksOut = _peakCache.filter((p) => p.ele >= minEle);
  return { ok: true, count: peaksOut.length, peaks: peaksOut };
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const ds = url.searchParams.get("ds") || "";
  const key = process.env.CWA_KEY;
  try {
    switch (ds) {
      case "rain": if (!key) return send(res, 200, { ok: false, error: "CWA_KEY 未設定", stations: [] }, "no-store"); return send(res, 200, await rain(key), "s-maxage=300, stale-while-revalidate=600");
      case "temp": if (!key) return send(res, 200, { ok: false, error: "CWA_KEY 未設定", stations: [] }, "no-store"); return send(res, 200, await temp(key), "s-maxage=300, stale-while-revalidate=600");
      case "typhoon": if (!key) return send(res, 200, { ok: false, error: "CWA_KEY 未設定", typhoons: [] }, "no-store"); return send(res, 200, await typhoon(key), "s-maxage=600, stale-while-revalidate=1200");
      case "quake": if (!key) return send(res, 200, { ok: false, error: "CWA_KEY 未設定", quakes: [] }, "no-store"); return send(res, 200, await quake(key), "s-maxage=120, stale-while-revalidate=300");
      case "ocean": return send(res, 200, await ocean(), "s-maxage=21600, stale-while-revalidate=43200");
      case "peaks": return send(res, 200, await peaks(Number(url.searchParams.get("min")) || 1000), "s-maxage=86400, stale-while-revalidate=604800");
      case "river": {
        if (url.searchParams.get("debug") === "1") return send(res, 200, { ok: true, raw: await riverRaw() }, "no-store");
        const stations = await listRiverStations();
        return send(res, 200, { ok: true, count: stations.length, stations }, "s-maxage=120, stale-while-revalidate=300");
      }
      default: return send(res, 400, { ok: false, error: "未知 ds，需 rain|temp|typhoon|quake|ocean|peaks" }, "no-store");
    }
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message }, "no-store");
  }
}
