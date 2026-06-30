// 颱風代理:中央氣象署 W-C0034-005(活動中熱帶氣旋過去/現在/預報路徑+暴風圈)。需 CWA_KEY。
export default async function handler(req, res) {
  const key = process.env.CWA_KEY;
  const send = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "s-maxage=600, stale-while-revalidate=1200" });
    res.end(JSON.stringify(o));
  };
  if (!key) return send(200, { ok: false, error: "CWA_KEY 未設定", typhoons: [] });
  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const quad = (c) => {
    if (!c) return null;
    const q = {}; const rs = c.QuadrantRadii?.Radius || [];
    for (const r of (Array.isArray(rs) ? rs : [rs])) q[r.dir] = n(r.value);
    q.r = n(c.Radius);
    return q;
  };
  try {
    const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005?Authorization=${key}&format=JSON`;
    const r = await fetch(url, { headers: { "User-Agent": "TaiwanPulse/0.1 (+map)" } });
    if (!r.ok) throw new Error(`CWA ${r.status}`);
    const j = await r.json();
    const tcs = j?.records?.TropicalCyclones?.TropicalCyclone || [];
    const typhoons = (Array.isArray(tcs) ? tcs : []).map((tc) => {
      const fixA = tc.AnalysisData?.Fix || [];
      const fixF = tc.ForecastData?.Fix || [];
      const analysis = (Array.isArray(fixA) ? fixA : []).map((f) => ({
        time: f.DateTime, lon: n(f.CoordinateLongitude), lat: n(f.CoordinateLatitude),
        wind: n(f.MaxWindSpeed), gust: n(f.MaxGustSpeed), pressure: n(f.Pressure),
        r15: quad(f.Circle15ms), r25: quad(f.Circle25ms),
      })).filter((p) => p.lon != null && p.lat != null);
      const forecast = (Array.isArray(fixF) ? fixF : []).map((f) => ({
        time: f.InitialTime, hour: f.ForecastHour, lon: n(f.CoordinateLongitude), lat: n(f.CoordinateLatitude),
        wind: n(f.MaxWindSpeed), pressure: n(f.Pressure), r70: n(f.Radius70PercentProbability),
      })).filter((p) => p.lon != null && p.lat != null);
      return { name: tc.CwaTyphoonName || tc.TyphoonName, enName: tc.TyphoonName, no: tc.CwaTyNo, analysis, forecast };
    }).filter((t) => t.analysis.length || t.forecast.length);
    return send(200, { ok: true, count: typhoons.length, typhoons });
  } catch (e) {
    return send(500, { ok: false, error: e.message, typhoons: [] });
  }
}
