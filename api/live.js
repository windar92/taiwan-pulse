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
    const kind = id === "E-A0015-001" ? "顯著" : "小區域";
    try {
      const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${id}?Authorization=${key}&format=JSON&limit=200`;
      const r = await fetch(url, { headers: UA });
      if (!r.ok) continue;
      const j = await r.json();
      for (const e of (j?.records?.Earthquake || [])) all.push({ ...mapEq(e), kind });
    } catch {}
  }
  all.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  const seen = new Set(), uniq = [];
  for (const q of all) { if (typeof q.lat !== "number" || typeof q.lon !== "number") continue; const k = String(q.time) + "|" + String(q.lat) + "," + String(q.lon); if (seen.has(k)) continue; seen.add(k); uniq.push(q); }
  return { ok: true, count: uniq.length, quakes: uniq.slice(0, 150) };
}

// ---- 海溫：NOAA ERDDAP 的 NASA JPL MUR SST(全球 0.01°、每日、免金鑰) ----
// 舊版用台大 ODB 的 mhw 端點,那是「月」資料(畫面上會顯示一兩個月前的日期),不是即時。
// MUR 為每日海表溫度分析,陸地為 null(天生不會蓋到陸地)。取大範圍海域 + 0.1° 取樣。
const SST_BBOX = { lon0: 112, lon1: 132, lat0: 14, lat1: 33 }; // 大範圍海域(含台灣、巴士海峽、東海、南海北部)
async function ocean() {
  // MUR 原生 0.01°，stride 10 → 約 0.1° 一點
  const q = `analysed_sst[(last)][(${SST_BBOX.lat0}):10:(${SST_BBOX.lat1})][(${SST_BBOX.lon0}):10:(${SST_BBOX.lon1})]`;
  const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json?${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`ERDDAP ${r.status}`);
  const j = await r.json();
  const cols = j?.table?.columnNames || [];
  const rows = j?.table?.rows || [];
  const iT = cols.indexOf("time"), iLat = cols.indexOf("latitude"), iLon = cols.indexOf("longitude"), iV = cols.indexOf("analysed_sst");
  if (iV < 0 || !rows.length) return { ok: true, date: null, points: [] };
  let date = null;
  const points = [];
  for (const row of rows) {
    const v = row[iV];
    if (v == null) continue; // 陸地/缺值
    let sst = Number(v);
    if (!Number.isFinite(sst)) continue;
    if (sst > 100) sst -= 273.15; // 保險：若回傳為 Kelvin
    if (sst < -5 || sst > 40) continue;
    if (date == null && iT >= 0) date = String(row[iT] || "").slice(0, 10);
    points.push({ lon: Number(row[iLon]), lat: Number(row[iLat]), sst: +sst.toFixed(2) });
  }
  return { ok: true, date, count: points.length, source: "NASA JPL MUR SST (每日) via NOAA ERDDAP", bbox: SST_BBOX, points };
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
// 官方名單(維基)：台灣百岳100、小百岳100。以山名比對 OSM 座標分類。
const BAIYUE = new Set(["玉山","雪山","玉山東峰","玉山南峰","玉山北峰","秀姑巒山","馬博拉斯山","南湖大山","東小南山","雪山北峰","中央尖山","關山","大水窟山","南湖大山東峰","東郡大山","奇萊北峰","向陽山","大劍山","雲峰","馬利加南山","奇萊主山","南湖北山","大雪山","品田山","玉山西峰","頭鷹山","南湖大山南峰","三叉山","大霸尖山","東巒大山","無明山","巴巴山","馬西山","北合歡山","合歡山東峰","小霸尖山","合歡山","南玉山","畢祿山","卓社大山","南雙頭山","奇萊南峰","能高山南峰","白姑大山","新康山","八通關山","丹大山","桃山","佳陽山","火石山","池有山","伊澤山","卑南主山","志佳陽大山","太魯閣大山","干卓萬山","轆轆山","內嶺爾山","郡大山","喀西帕南山","鈴鳴山","能高山","萬東山西峰","劍山","義西請馬至山","小關山","屏風山","無雙山","牧山","石門山","玉山前峰","塔關山","馬比杉山","達芬尖山","雪山東峰","南華山","關山嶺山","海諾南山","中雪山","閂山","甘薯峰","西合歡山","審馬陣山","喀拉業山","庫哈諾辛山","加利山","白石山","磐石山","帕托魯山","北大武山","西巒大山","立霧主山","塔芬山","光頭山","安東軍山","羊頭山","駒盆山","布拉克桑山","六順山","鹿山"]);
const XIAOBAI = new Set(["大屯山","七星山","大武崙山","槓子寮山","觀音山","基隆山","紅淡山","大崙頭山","劍潭山","五分山","姜子寮山","大尖山","南港山","大棟山","南勢角山","福德坑山","金面山","東眼山","溪洲山","石牛山","十八尖山","獅頭山","五指山","鵝公髻山","向天湖山","加里山","火炎山","關刀山","馬那邦山","鐵砧山","稍來山","聚興山","頭嵙山","三汀山","暗影山","大橫屏山","阿罩霧山","九份二山","橫山","貓囒山","集集大山","松柏坑山","後尖山","鳳凰山","金柑樹山","石壁山","梨子腳山","獨立山","大塔山","大湖尖山","紅毛埤山","崁頭山","三腳南山","西阿里關山","竹子尖山","藤枝山","刣牛湖山","鳴海山","旗尾山","尾寮山","大崗山","笠頂山","棚集山","女仍山","里龍山","大山母山","灣坑頭山","三角崙山","鵲子山","三星山","卡拉寶山","立霧山","初音山","鯉魚山","月眉山","八里灣山","萬人山","都蘭山","太麻里山","加奈美山","巴塱衛山","紅頭山","雲台山","太武山","蛇頭山","丹鳳山","瑪陵尖","虎頭山","八仙山","水社大山","文峰山","三寶山","桶頭山","大巴六九山","楠山","火燒山","龜山島山","新城山","東藤枝山","萬里得山","祖輪山"]);
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
      // 百岳全 ≥3000m(最低鹿山2981)、小百岳全 <2700m：以高度區間濾掉同名郊山誤配
      const cls2 = (BAIYUE.has(name) && ele >= 2900) ? "百岳" : (XIAOBAI.has(name) && ele <= 2800 ? "小百岳" : "");
      out.push({ name, name_en: el.tags?.["name:en"] || null, lng: el.lon, lat: el.lat, ele, tier: peakTier(ele), cls2 });
    }
    out.sort((a, b) => b.ele - a.ele);
    _peakCache = out; _peakAt = Date.now();
  }
  // 回傳：達高度門檻者，或屬百岳/小百岳者(小百岳多在1000m以下也要納入)
  const peaksOut = _peakCache.filter((p) => p.ele >= minEle || p.cls2);
  return { ok: true, count: peaksOut.length, baiyue: _peakCache.filter((p) => p.cls2 === "百岳").length, xiaobai: _peakCache.filter((p) => p.cls2 === "小百岳").length, peaks: peaksOut };
}

// ---- 河川中心線幾何(OSM 河線+河名，供水牆骨架) ----
const RIVERGEO_Q = `[out:json][timeout:90];way[waterway~"^(river|canal)$"][name](21.8,120.0,25.4,122.1);out geom;`;
let _rgCache = null, _rgAt = 0;
async function rivergeo() {
  if (!_rgCache || Date.now() - _rgAt > 24 * 3600 * 1000) {
    const j = await overpassFetch(RIVERGEO_Q);
    const out = [];
    for (const el of j.elements || []) {
      if (el.type !== "way" || !Array.isArray(el.geometry)) continue;
      const coords = el.geometry.map((g) => [Math.round(g.lon * 1e5) / 1e5, Math.round(g.lat * 1e5) / 1e5]);
      if (coords.length < 2) continue;
      out.push({ name: el.tags && el.tags.name || null, coords });
    }
    _rgCache = out; _rgAt = Date.now();
  }
  return { ok: true, count: _rgCache.length, rivers: _rgCache };
}

// ---- 堰塞湖監測(林保署 國有林堰塞湖監測系統, 免金鑰) ----
async function barrierlake() {
  const r = await fetch("https://qlakenew.forest.gov.tw/FarmlandQlakenew/Collapse/ReadData?Type=GetLake", { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) taiwan-pulse", "Accept": "application/json, text/plain, */*", "Referer": "https://qlakenew.forest.gov.tw/FarmlandQlakenew/LandslideDam", "X-Requested-With": "XMLHttpRequest" } });
  if (!r.ok) throw new Error("qlake " + r.status);
  const arr = await r.json();
  const lakes = (Array.isArray(arr) ? arr : []).filter((l) => String(l.active) === "1").map((l) => ({
    id: l.row_id, name: l.device_name, alert: l.alertlevel || "gray", warn: String(l.warning_flag) === "1", rainalert: l.rainalertvalue, upd: l.update_time,
  }));
  return { ok: true, count: lakes.length, lakes };
}

// ---- 堰塞湖即時水位(林保署儀錶板 getWST，免金鑰，需固定 SAMEGUID header) ----
// 注意：目前林保署只在「合歡溪」裝湖內水位計；「馬太鞍溪」只公開下游馬太鞍溪橋的河道水位；萬里溪無任何即時水位。
const QLAKE_GUID = "6334159a-a66d-4ab6-9dda-48fed3bb2217";
async function qlakeWST(route) {
  const r = await fetch(`https://qlakenew.forest.gov.tw/FarmlandQlakenew/${route}/getWST`, {
    headers: {
      "SAMEGUID": QLAKE_GUID,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) taiwan-pulse",
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": `https://qlakenew.forest.gov.tw/FarmlandQlakenew/${route}`,
    },
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => []);
  return (Array.isArray(j) ? j : []).map((o) => {
    const vals = String(o.Value ?? "").split(",").map((v) => parseFloat(v)).filter((v) => Number.isFinite(v));
    const cur = Number.isFinite(parseFloat(o.maxValue)) ? parseFloat(o.maxValue) : (vals.length ? vals[vals.length - 1] : null);
    return {
      id: o.StationID, name: String(o.Name || "").replace(/​/g, "").trim(),
      level: cur, time: o.maxDatetime || null,
      alertTop: Number.isFinite(parseFloat(o.alertTOP)) ? parseFloat(o.alertTOP) : null,
      series: vals.slice(-24),
    };
  }).filter((s) => s.level != null);
}
async function lakelevel() {
  const [matai, hehuan] = await Promise.all([
    qlakeWST("BarrierLake").catch(() => []),      // 馬太鞍溪橋(下游河道水位，非湖面)
    qlakeWST("BarrierLakeLiwu").catch(() => []),  // 合歡溪堰塞湖(真正的湖面水位)
  ]);
  return {
    ok: true,
    matai_bridge: matai[0] || null,   // 下游橋水位
    hehuan_lake: hehuan[0] || null,   // 湖面水位
    note: "馬太鞍溪僅有下游橋水位；合歡溪為湖面水位；萬里溪無即時水位資料",
  };
}

// ---- 公路即時影像 CCTV(公路局開放資料，免金鑰；含經緯度與即時快照 JPEG) ----
async function cctv() {
  const r = await fetch("https://cctv-maintain.thb.gov.tw/opendataCCTVs.xml", { headers: UA });
  if (!r.ok) throw new Error("thb cctv " + r.status);
  const xml = await r.text();
  const pick = (b, tag) => { const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ""; };
  const cams = [];
  const re = /<CCTV>([\s\S]*?)<\/CCTV>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const lon = parseFloat(pick(b, "PositionLon")), lat = parseFloat(pick(b, "PositionLat"));
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < 118 || lon > 123 || lat < 21 || lat > 26.5) continue;
    cams.push({ id: pick(b, "CCTVID"), lon, lat, road: pick(b, "RoadName"), dir: pick(b, "RoadDirection"), mile: pick(b, "LocationMile"), desc: pick(b, "SurveillanceDescription"), img: pick(b, "VideoImageURL") });
  }
  return { ok: true, count: cams.length, source: "公路局 公路即時影像(開放資料)", cams };
}

// ---- 海流(NRT 地轉流) via NOAA AOML ERDDAP(免金鑰，u/v m/s，0.2°) ----
async function currents() {
  const box = { lon0: 105, lon1: 145, lat0: 5, lat1: 40, stride: 1, step: 0.2 };
  const q = `u_current[(last)][(${box.lat0}):${box.stride}:(${box.lat1})][(${box.lon0}):${box.stride}:(${box.lon1})],v_current[(last)][(${box.lat0}):${box.stride}:(${box.lat1})][(${box.lon0}):${box.stride}:(${box.lon1})]`;
  const url = `https://cwcgom.aoml.noaa.gov/erddap/griddap/miamicurrents.json?${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`AOML ${r.status}`);
  const j = await r.json();
  const cols = j?.table?.columnNames || [], rows = j?.table?.rows || [];
  const iT = cols.indexOf("time"), iLat = cols.indexOf("latitude"), iLon = cols.indexOf("longitude"), iU = cols.indexOf("u_current"), iV = cols.indexOf("v_current");
  const vecs = [];
  let date = null;
  for (const row of rows) {
    if (date == null && iT >= 0) date = String(row[iT] || "").slice(0, 10);
    const u = Number(row[iU]), v = Number(row[iV]);
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    const spd = Math.hypot(u, v);
    if (spd < 0.03) continue; // 太弱不畫
    vecs.push({ lon: +Number(row[iLon]).toFixed(2), lat: +Number(row[iLat]).toFixed(2), u: +u.toFixed(3), v: +v.toFixed(3), s: +spd.toFixed(3) });
  }
  return { ok: true, date, count: vecs.length, source: "Near Real Time Geostrophic Currents · NOAA AOML CoastWatch", vecs };
}

// ---- 解放軍基地及設施(uMap 社群資料層，公開 GeoJSON；非官方 OSINT) + 東海油氣平台(官方/AMTI) ----
// 依中文名稱關鍵字分類；順序由「最具體」到「最一般」，先命中者為準。
function plaCatOf(name) {
  const n = String(name || "");
  if (/海警|海監|海事局|漁政|海巡/.test(n)) return "海警";
  if (/陸戰|兩棲/.test(n)) return "海軍陸戰";
  if (/火箭軍|戰略|洲際|核|彈道|導彈旅|飛彈旅/.test(n)) return "火箭軍";
  if (/防空|地空|紅旗|HQ-|S-?300|S-?400|SAM/.test(n)) return "防空飛彈";
  if (/飛彈|導彈|反艦|岸置|發射/.test(n)) return "飛彈";
  if (/雷達|OTH|表面波|超視距|預警/.test(n)) return "雷達/預警";
  if (/機場|空軍|空基|航空兵|戰機|轟|殲|運-|直升機|飛/.test(n)) return "軍機場/空軍";
  if (/海軍|海航|軍港|艦隊|潛艇|潛艦|驅逐|護衛|登陸艦|艦|軍碼頭|港/.test(n)) return "海軍/軍港";
  if (/電子|通信|通訊|測控|情報|信號|偵聽/.test(n)) return "電子/通信";
  if (/集團軍|合成旅|裝甲|砲兵|炮兵|步兵|陸軍/.test(n)) return "陸軍";
  if (/基地|營區|訓練|指揮|靶場/.test(n)) return "基地/指揮";
  return "其他";
}

async function pla(req) {
  // 1) 社群 OSINT 設施點
  const r = await fetch("https://umap.openstreetmap.fr/en/datalayer/77487/087d8925-d506-4be4-ba0e-fa36b05c171d/", { headers: UA });
  if (!r.ok) throw new Error("umap " + r.status);
  const j = await r.json();
  const pts = [];
  for (const f of (j.features || [])) {
    const g = f.geometry; if (!g || g.type !== "Point") continue;
    const [lon, lat] = g.coordinates || [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const name = (f.properties && f.properties.name) || "";
    if (/^\d{4}\s*年/.test(name)) continue; // 略過作者放的紀念點
    pts.push({ lon: +lon.toFixed(5), lat: +lat.toFixed(5), name, cat: plaCatOf(name), src: "osint" });
  }
  // 2) 東海油氣平台(日本外務省確認 + CSIS AMTI 座標)——另成一類，來源可信度較高
  let platformCount = 0;
  try {
    let raw;
    try {
      const { readFile } = await import("node:fs/promises");
      raw = await readFile(new URL("../public/ecs-platforms.json", import.meta.url), "utf8");
    } catch {
      const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host;
      const proto = req?.headers?.["x-forwarded-proto"] || "https";
      const rr = await fetch(`${proto}://${host}/ecs-platforms.json`);
      if (rr.ok) raw = await rr.text();
    }
    if (raw) {
      const pj = JSON.parse(raw);
      for (const p of (pj.platforms || [])) {
        if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
        pts.push({
          lon: +Number(p.lon).toFixed(5), lat: +Number(p.lat).toFixed(5),
          name: p.name, cat: "油氣平台",
          note: p.note || "", approx: p.p === "approx", src: "amti",
        });
        platformCount++;
      }
    }
  } catch { /* 平台檔拿不到就只回 OSINT 設施 */ }
  return {
    ok: true, count: pts.length, platformCount,
    source: "設施點：社群整理(uMap by 溫約瑟)·非官方 OSINT；油氣平台：日本外務省確認+CSIS AMTI 座標",
    pts,
  };
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
      case "rivergeo": return send(res, 200, await rivergeo(), "s-maxage=86400, stale-while-revalidate=604800");
      case "barrierlake": return send(res, 200, await barrierlake(), "s-maxage=300, stale-while-revalidate=900");
      case "lakelevel": return send(res, 200, await lakelevel(), "s-maxage=300, stale-while-revalidate=600");
      case "cctv": return send(res, 200, await cctv(), "s-maxage=1800, stale-while-revalidate=3600");
      case "currents": return send(res, 200, await currents(), "s-maxage=10800, stale-while-revalidate=43200");
      case "pla": return send(res, 200, await pla(req), "s-maxage=86400, stale-while-revalidate=604800");
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
