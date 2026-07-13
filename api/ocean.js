// 海溫(SST)代理：NASA JPL MUR SST(全球 0.01°、每日) via NOAA ERDDAP，免金鑰。
// 舊版用台大 ODB 的 mhw(0.25° 月網格)，那是「月」資料，畫面上會顯示一兩個月前的日期，不是即時。
// MUR 為每日海表溫度分析；陸地回傳 null(天生不會蓋到陸地)。取大範圍海域 + 0.1° 取樣。
const BBOX = { lon0: 112, lon1: 132, lat0: 14, lat1: 33 }; // 含台灣、台灣海峽、巴士海峽、東海、南海北部

export default async function handler(req, res) {
  const send = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "s-maxage=10800, stale-while-revalidate=43200" });
    res.end(JSON.stringify(o));
  };
  try {
    // MUR 原生 0.01°，stride 10 → 約 0.1° 一點
    const q = `analysed_sst[(last)][(${BBOX.lat0}):10:(${BBOX.lat1})][(${BBOX.lon0}):10:(${BBOX.lon1})]`;
    const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json?${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { "User-Agent": "TaiwanPulse/0.1 (+map)" } });
    if (!r.ok) throw new Error(`ERDDAP ${r.status}`);
    const j = await r.json();
    const cols = j?.table?.columnNames || [];
    const rows = j?.table?.rows || [];
    const iT = cols.indexOf("time"), iLat = cols.indexOf("latitude"), iLon = cols.indexOf("longitude"), iV = cols.indexOf("analysed_sst");
    if (iV < 0 || !rows.length) return send(200, { ok: true, date: null, points: [] });

    let date = null;
    const points = [];
    for (const row of rows) {
      const v = row[iV];
      if (v == null) continue; // 陸地/缺值
      let sst = Number(v);
      if (!Number.isFinite(sst)) continue;
      if (sst > 100) sst -= 273.15; // 保險：若來源為 Kelvin
      if (sst < -5 || sst > 40) continue;
      if (date == null && iT >= 0) date = String(row[iT] || "").slice(0, 10);
      points.push({ lon: Number(row[iLon]), lat: Number(row[iLat]), sst: +sst.toFixed(2) });
    }
    return send(200, {
      ok: true, date, count: points.length,
      source: "NASA JPL MUR SST（每日）via NOAA ERDDAP",
      bbox: BBOX, points,
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message, points: [] });
  }
}
