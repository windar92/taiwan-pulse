// 海溫(SST)代理：NASA JPL MUR SST(全球 0.01°、每日) via NOAA ERDDAP，免金鑰。
// 舊版用台大 ODB 的 mhw(0.25° 月網格)，那是「月」資料，不是即時。
// MUR 為每日海表溫度分析；陸地回傳 null(天生不會蓋到陸地)。
//
// 兩段解析度：
//   coarse 大範圍 0.2°(西至柬埔寨、東至日本最東、北至日本最北、南至澳洲最北)
//   fine   台灣近海 0.1°(細節)
// 回傳「壓縮網格陣列」而非逐點物件，避免 JSON 爆量。
const COARSE = { lon0: 102, lon1: 154, lat0: -11, lat1: 46, stride: 20, step: 0.2 };
const FINE = { lon0: 116, lon1: 126, lat0: 19, lat1: 28, stride: 10, step: 0.1 };

async function grid(box) {
  const q = `analysed_sst[(last)][(${box.lat0}):${box.stride}:(${box.lat1})][(${box.lon0}):${box.stride}:(${box.lon1})]`;
  const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json?${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "User-Agent": "TaiwanPulse/0.1 (+map)" } });
  if (!r.ok) throw new Error(`ERDDAP ${r.status}`);
  const j = await r.json();
  const cols = j?.table?.columnNames || [];
  const rows = j?.table?.rows || [];
  const iT = cols.indexOf("time"), iLat = cols.indexOf("latitude"), iLon = cols.indexOf("longitude"), iV = cols.indexOf("analysed_sst");
  const nx = Math.round((box.lon1 - box.lon0) / box.step) + 1;
  const ny = Math.round((box.lat1 - box.lat0) / box.step) + 1;
  const vals = new Array(nx * ny).fill(null); // index = j*nx + i (j 由南往北)
  let date = null;
  for (const row of rows) {
    if (date == null && iT >= 0) date = String(row[iT] || "").slice(0, 10);
    const v = row[iV];
    if (v == null) continue; // 陸地/缺值
    let sst = Number(v);
    if (!Number.isFinite(sst)) continue;
    if (sst > 100) sst -= 273.15; // 保險：若來源為 Kelvin
    if (sst < -5 || sst > 40) continue;
    const i = Math.round((Number(row[iLon]) - box.lon0) / box.step);
    const jj = Math.round((Number(row[iLat]) - box.lat0) / box.step);
    if (i < 0 || i >= nx || jj < 0 || jj >= ny) continue;
    vals[jj * nx + i] = +sst.toFixed(1);
  }
  return { lon0: box.lon0, lon1: box.lon1, lat0: box.lat0, lat1: box.lat1, step: box.step, nx, ny, vals, date };
}

export default async function handler(req, res) {
  const send = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "s-maxage=10800, stale-while-revalidate=43200" });
    res.end(JSON.stringify(o));
  };
  try {
    const [coarse, fine] = await Promise.all([grid(COARSE), grid(FINE)]);
    return send(200, {
      ok: true,
      date: coarse.date || fine.date,
      source: "NASA JPL MUR SST（每日 1km）via NOAA ERDDAP",
      coarse, fine,
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message });
  }
}
