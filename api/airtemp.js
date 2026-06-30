// 自動氣象站(O-A0001-001)：回傳逐站氣溫等觀測。供「氣溫柱」與「氣象站」圖層共用。需 CWA_KEY。
export default async function handler(req, res) {
  const key = process.env.CWA_KEY;
  const send = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "s-maxage=300, stale-while-revalidate=600" });
    res.end(JSON.stringify(o));
  };
  if (!key) return send(200, { ok: false, error: "CWA_KEY 未設定", stations: [] });
  try {
    const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001?Authorization=${key}&format=JSON`;
    const r = await fetch(url, { headers: { "User-Agent": "TaiwanPulse/0.1 (+map)" } });
    if (!r.ok) throw new Error(`CWA ${r.status}`);
    const j = await r.json();
    const arr = j?.records?.Station || [];
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    const stations = [];
    for (const s of arr) {
      const coords = s.GeoInfo?.Coordinates || [];
      const wgs = coords.find((c) => c.CoordinateName === "WGS84") || coords[0];
      const lon = num(wgs?.StationLongitude), lat = num(wgs?.StationLatitude);
      if (lon == null || lat == null) continue;
      const w = s.WeatherElement || {};
      const t = num(w.AirTemperature);
      stations.push({
        name: s.StationName, lon, lat,
        county: s.GeoInfo?.CountyName, town: s.GeoInfo?.TownName, alt: num(s.GeoInfo?.StationAltitude),
        temp: (t != null && t > -50) ? t : null,
        weather: w.Weather, wind: num(w.WindSpeed), humidity: num(w.RelativeHumidity),
        pressure: num(w.AirPressure), rain: num(w.Now?.Precipitation),
      });
    }
    return send(200, { ok: true, time: arr[0]?.ObsTime?.DateTime || null, count: stations.length, stations });
  } catch (e) {
    return send(500, { ok: false, error: e.message, stations: [] });
  }
}
