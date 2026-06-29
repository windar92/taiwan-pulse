// 即時雨量代理：抓中央氣象署自動雨量站(O-A0002-001)，轉成精簡測站陣列。
// 需在 Vercel 設定環境變數 CWA_KEY = 你的氣象署開放資料授權碼。
export default async function handler(req, res) {
  const key = process.env.CWA_KEY;
  const send = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "s-maxage=300, stale-while-revalidate=600" });
    res.end(JSON.stringify(o));
  };
  if (!key) return send(200, { ok: false, error: "CWA_KEY 未設定", stations: [] });
  try {
    const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${key}&format=JSON`;
    const r = await fetch(url, { headers: { "User-Agent": "TaiwanPulse/0.1 (+map)" } });
    if (!r.ok) throw new Error(`CWA ${r.status}`);
    const j = await r.json();
    const arr = j?.records?.Station || [];
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    const pos = (v) => { const n = num(v); return n != null && n >= 0 ? n : 0; }; // 負值(-990等)= 無資料 → 0
    const stations = [];
    for (const s of arr) {
      const coords = s.GeoInfo?.Coordinates || [];
      const wgs = coords.find((c) => c.CoordinateName === "WGS84") || coords[0];
      const lon = num(wgs?.StationLongitude), lat = num(wgs?.StationLatitude);
      if (lon == null || lat == null) continue;
      const re = s.RainfallElement || {};
      stations.push({
        name: s.StationName, lon, lat,
        alt: num(s.GeoInfo?.StationAltitude),
        county: s.GeoInfo?.CountyName, town: s.GeoInfo?.TownName,
        r1: pos(re.Past1hr?.Precipitation),
        now: pos(re.Now?.Precipitation),
        r3: pos(re.Past3hr?.Precipitation),
        r24: pos(re.Past24hr?.Precipitation),
      });
    }
    return send(200, { ok: true, time: arr[0]?.ObsTime?.DateTime || null, count: stations.length, stations });
  } catch (e) {
    return send(500, { ok: false, error: e.message, stations: [] });
  }
}
