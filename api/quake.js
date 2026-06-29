// 地震代理：合併中央氣象署「顯著有感地震」(E-A0015) + 「小區域有感地震」(E-A0016)。
// 需環境變數 CWA_KEY。回傳最近 15 筆(含逐站震度)。
export default async function handler(req, res) {
  const key = process.env.CWA_KEY;
  const send = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "s-maxage=120, stale-while-revalidate=300" });
    res.end(JSON.stringify(o));
  };
  if (!key) return send(200, { ok: false, error: "CWA_KEY 未設定", quakes: [] });
  const intNum = (s) => { const m = String(s || "").match(/(\d)/); let n = m ? parseInt(m[1]) : 0; if (String(s).includes("強")) n += 0.5; return n; };
  const mapEq = (e) => {
    const info = e.EarthquakeInfo || {}, ep = info.Epicenter || {};
    const stations = [];
    for (const area of (e.Intensity?.ShakingArea || [])) {
      for (const st of (area.EqStation || [])) {
        const lat = st.StationLatitude, lon = st.StationLongitude;
        if (typeof lat !== "number" || typeof lon !== "number") continue;
        const intv = intNum(st.SeismicIntensity);
        if (intv <= 0) continue;
        stations.push({ name: st.StationName, lon, lat, int: intv, intLabel: st.SeismicIntensity });
      }
    }
    return {
      no: e.EarthquakeNo, time: info.OriginTime,
      mag: info.EarthquakeMagnitude?.MagnitudeValue, depth: info.FocalDepth,
      lat: ep.EpicenterLatitude, lon: ep.EpicenterLongitude, location: ep.Location,
      color: e.ReportColor, content: e.ReportContent, web: e.Web, stations,
    };
  };
  try {
    const all = [];
    for (const id of ["E-A0015-001", "E-A0016-001"]) {
      try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${id}?Authorization=${key}&format=JSON&limit=20`;
        const r = await fetch(url, { headers: { "User-Agent": "TaiwanPulse/0.1 (+map)" } });
        if (!r.ok) continue;
        const j = await r.json();
        for (const e of (j?.records?.Earthquake || [])) all.push(mapEq(e));
      } catch {}
    }
    all.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    const seen = new Set(), uniq = [];
    for (const q of all) {
      if (typeof q.lat !== "number" || typeof q.lon !== "number") continue;
      const k = String(q.time); if (seen.has(k)) continue; seen.add(k); uniq.push(q);
    }
    return send(200, { ok: true, count: uniq.length, quakes: uniq.slice(0, 15) });
  } catch (e) {
    return send(500, { ok: false, error: e.message, quakes: [] });
  }
}
