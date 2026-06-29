// 地震代理：抓中央氣象署顯著有感地震報告(E-A0015-001)。需環境變數 CWA_KEY。
// 回傳最近地震的震央資訊；最近 3 顆附逐站震度(控制體積)。
export default async function handler(req, res) {
  const key = process.env.CWA_KEY;
  const send = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "s-maxage=120, stale-while-revalidate=300" });
    res.end(JSON.stringify(o));
  };
  if (!key) return send(200, { ok: false, error: "CWA_KEY 未設定", quakes: [] });
  const intNum = (s) => { const m = String(s || "").match(/(\d)/); let n = m ? parseInt(m[1]) : 0; if (String(s).includes("強")) n += 0.5; return n; };
  try {
    const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001?Authorization=${key}&format=JSON&limit=20`;
    const r = await fetch(url, { headers: { "User-Agent": "TaiwanPulse/0.1 (+map)" } });
    if (!r.ok) throw new Error(`CWA ${r.status}`);
    const j = await r.json();
    const eqs = j?.records?.Earthquake || [];
    const quakes = eqs.map((e, idx) => {
      const info = e.EarthquakeInfo || {};
      const ep = info.Epicenter || {};
      const stations = [];
      if (idx < 3) {
        for (const area of (e.Intensity?.ShakingArea || [])) {
          for (const st of (area.EqStation || [])) {
            const lat = st.StationLatitude, lon = st.StationLongitude;
            if (typeof lat !== "number" || typeof lon !== "number") continue;
            const intv = intNum(st.SeismicIntensity);
            if (intv <= 0) continue;
            stations.push({ name: st.StationName, lon, lat, int: intv, intLabel: st.SeismicIntensity });
          }
        }
      }
      return {
        no: e.EarthquakeNo, time: info.OriginTime,
        mag: info.EarthquakeMagnitude?.MagnitudeValue, depth: info.FocalDepth,
        lat: ep.EpicenterLatitude, lon: ep.EpicenterLongitude, location: ep.Location,
        color: e.ReportColor, content: e.ReportContent, web: e.Web, stations,
      };
    }).filter((q) => typeof q.lat === "number" && typeof q.lon === "number");
    return send(200, { ok: true, count: quakes.length, quakes });
  } catch (e) {
    return send(500, { ok: false, error: e.message, quakes: [] });
  }
}
