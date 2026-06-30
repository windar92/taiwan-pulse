// 台灣山岳圖層：從 OSM Overpass 取得「有名稱且有標高」的山峰，依標高分級。
// 百岳基本上是台灣最高的 100 座（最低鹿山 2981m），故 ele>=3000 近似百岳級；
// 2000-3000 為高山、1000-2000 為中級山。座標與標高皆來自 OSM，不杜撰。
// 由 Vercel 伺服器端抓 Overpass（無沙箱網路限制），重度快取。
const OVERPASS = "https://overpass-api.de/api/interpreter";
const Q = `[out:json][timeout:90];
(node[natural=peak][name][ele](21.8,120.0,25.4,122.1);
 node[natural=peak][name]["ele:local"](21.8,120.0,25.4,122.1););
out;`;

function tier(ele) {
  if (ele >= 3000) return "百岳級";
  if (ele >= 2000) return "高山";
  if (ele >= 1000) return "中級山";
  return "郊山";
}

let _cache = null, _cacheAt = 0;

export default async function handler(req, res) {
  const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800" }); res.end(JSON.stringify(o)); };
  const url = new URL(req.url, "http://x");
  const minEle = Number(url.searchParams.get("min")) || 1000;
  try {
    // 記憶體快取 6 小時（同一函式實例）
    if (_cache && Date.now() - _cacheAt < 6 * 3600 * 1000) {
      const peaks = _cache.filter((p) => p.ele >= minEle);
      return send(200, { ok: true, count: peaks.length, peaks });
    }
    const r = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(Q),
    });
    if (!r.ok) return send(502, { ok: false, error: "overpass " + r.status, peaks: [] });
    const j = await r.json();
    const seen = new Set();
    const peaks = [];
    for (const el of j.elements || []) {
      const name = el.tags?.name; if (!name) continue;
      const eleRaw = el.tags?.ele ?? el.tags?.["ele:local"];
      const ele = Math.round(parseFloat(String(eleRaw).replace(/[^\d.\-]/g, "")));
      if (!Number.isFinite(ele) || ele <= 0) continue;
      if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
      const key = name + "@" + el.lat.toFixed(3);
      if (seen.has(key)) continue; seen.add(key);
      peaks.push({ name, name_en: el.tags?.["name:en"] || null, lng: el.lon, lat: el.lat, ele, tier: tier(ele) });
    }
    peaks.sort((a, b) => b.ele - a.ele);
    _cache = peaks; _cacheAt = Date.now();
    const out = peaks.filter((p) => p.ele >= minEle);
    return send(200, { ok: true, count: out.length, peaks: out });
  } catch (e) {
    return send(500, { ok: false, error: e.message, peaks: [] });
  }
}
