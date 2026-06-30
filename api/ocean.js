// 海溫(SST)代理:台大 ODB 海洋熱浪 API(eco.odb.ntu.edu.tw/api/mhw),免金鑰，0.25° 月網格。
export default async function handler(req, res) {
  const send = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "s-maxage=21600, stale-while-revalidate=43200" });
    res.end(JSON.stringify(o));
  };
  try {
    const now = new Date();
    const first = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    const back = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const url = `https://eco.odb.ntu.edu.tw/api/mhw?lon0=117&lon1=124&lat0=20&lat1=27&start=${first(back)}&end=${first(now)}&append=sst,sst_anomaly,level`;
    const r = await fetch(url, { headers: { "User-Agent": "TaiwanPulse/0.1 (+map)" } });
    if (!r.ok) throw new Error(`ODB ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return send(200, { ok: true, date: null, points: [] });
    // 取最新有資料的月份
    let latest = "";
    for (const p of arr) if (p.date > latest) latest = p.date;
    const points = arr.filter((p) => p.date === latest && p.sst != null).map((p) => ({ lon: p.lon, lat: p.lat, sst: p.sst, anom: p.sst_anomaly, level: p.level }));
    return send(200, { ok: true, date: latest, count: points.length, points });
  } catch (e) {
    return send(500, { ok: false, error: e.message, points: [] });
  }
}
