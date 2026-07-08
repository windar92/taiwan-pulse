// 中國軍事/灰色地帶入侵紀錄 router：?action=read|seed|collect
//   read   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD 回傳區間內事件(供時間軸密度圖)
//   seed   GET/POST 種入策展的真實事件(重大軍演 + 灰色地帶)，冪等
//   collect POST 由排程觸發，抓國防部即時軍事動態每日共機/共艦(往後累積真實每日資料)
import { listIncursions, upsertIncursions, incursionsRaw, clearIncursionsByType } from "../lib/db.js";

export const config = { maxDuration: 60 };

const send = (res, s, o, cache) => { res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache || "no-store" }); res.end(JSON.stringify(o)); };

// 區域代表座標
const ZONE = {
  西南空域: [119.5, 21.8], 台海中線: [120.0, 24.2], 北部空域: [121.6, 25.6], 東部海空域: [122.8, 23.8],
  金門: [118.35, 24.43], 東沙: [116.72, 20.70], 台澎海纜: [119.4, 23.5], 基隆外海: [122.0, 25.35],
  台灣海峽: [120.0, 23.5], 高雄: [120.3, 22.6], 巴士海峽: [121.0, 21.3],
};

// 策展的真實、有日期、可查證事件(軍事演習 + 海上灰色地帶)
function seedEvents() {
  const E = [];
  const add = (ev_date, type, zone, cnt, detail, source, url) => {
    const [lng, lat] = ZONE[zone] || [121, 23.5];
    E.push({ ev_date, type, zone, lng, lat, cnt, detail, source, url, uniq: `${ev_date}|${type}|${zone}|${(detail || "").slice(0, 18)}` });
  };
  // —— 空中/軍演(重大、廣泛報導) ——
  add("2020-09-18", "air", "西南空域", 1, "PLA 大規模擾台，臺海周邊空域侵擾自此制度化(國防部即時軍事動態起點)", "國防部");
  add("2021-10-04", "air", "西南空域", 56, "單日 56 架次共機進入西南空域，創當時單日紀錄", "國防部/媒體");
  add("2022-08-04", "drill", "台灣海峽", 1, "裴洛西訪台後圍台軍演；彈道飛彈飛越台灣上空，共機逾越中線自此常態化", "國防部/媒體");
  add("2023-04-08", "drill", "台灣海峽", 1, "『聯合利劍』圍台軍演(報復蔡英文-麥卡錫會晤)", "東部戰區/媒體");
  add("2024-05-23", "drill", "台灣海峽", 1, "『聯合利劍-2024A』圍台演習(賴清德就職後)", "東部戰區/媒體");
  add("2024-10-14", "drill", "東部海空域", 153, "『聯合利劍-2024B』，單日偵獲約 153 架次共機，創單日新高", "國防部/媒體");
  add("2025-04-01", "drill", "台灣海峽", 1, "『海峽雷霆-2025A』圍台演習", "東部戰區/媒體");
  // —— 海上灰色地帶(2026 臺灣海洋國際論壇，花蓮海巡隊長楊献璋簡報) ——
  add("2024-01-01", "coastguard", "金門", 121, "2024–2026/6 金門海域記錄 121 次中國海警重大侵入；海巡採一比一應對(監控、廣播、驅離)", "楊献璋簡報(2026臺灣海洋國際論壇)");
  add("2025-01-15", "coastguard", "東沙", 42, "2025 至今東沙 42 次侵入、涉 12 艘海警船；曾一次滯留逾 6 天製造管轄假象", "楊献璋簡報(2026臺灣海洋國際論壇)");
  add("2026-06-01", "coastguard", "東部海空域", 1, "中國海警與海事局於台灣東部外海協同『專項海上執法行動』(6/1–6/10)，6 日起加派；截至 6 月東部巡邏已常態化", "楊献璋簡報(2026臺灣海洋國際論壇)");
  add("2025-01-01", "cable", "基隆外海", 1, "『順興39』於北部海域逗留約一個月後，切斷連接台美日韓的國際海纜", "楊献璋簡報(2026臺灣海洋國際論壇)");
  add("2025-06-01", "cable", "台澎海纜", 1, "『宏泰58』切斷台澎海纜後遭 3 艘海巡艦艇攔截；船長被判 3 年(里程碑判例)", "楊献璋簡報(2026臺灣海洋國際論壇)");
  add("2025-12-01", "drill", "高雄", 1, "軍演想定：模擬攔檢載運美援裝備之長榮貨輪；模擬打擊部署於高雄、基隆的海馬斯系統", "楊献璋簡報(2026臺灣海洋國際論壇)");
  add("2024-06-01", "survey", "巴士海峽", 41, "ISW：41 艘中國科研船 2023–2025 測繪，範圍自台灣東部、巴士海峽延伸至第二三島鏈、北極、大西洋；水文供反介入(A2/AD)戰略", "楊献璋簡報/ISW");
  // —— 共機 ADIZ 年總量(國防部年度統計/媒體彙整；以年總量均分至各月，呈現真實量級的月密度) ——
  const ANNUAL_AIR = { 2020: 380, 2021: 961, 2022: 1738, 2023: 1703, 2024: 3070 };
  for (const y of Object.keys(ANNUAL_AIR)) {
    const yr = Number(y), startM = yr === 2020 ? 9 : 1, nM = 12 - startM + 1;
    const per = Math.round(ANNUAL_AIR[y] / nM);
    const [lng, lat] = ZONE["西南空域"];
    for (let mo = startM; mo <= 12; mo++) {
      const mm = String(mo).padStart(2, "0");
      E.push({ ev_date: `${yr}-${mm}-15`, type: "air", zone: "西南空域", lng, lat, cnt: per, detail: `${yr} 年共機擾台約 ${ANNUAL_AIR[y]} 架次(年總量均分至各月示意；國防部年度統計/媒體彙整)`, source: "國防部年度統計/媒體彙整", uniq: `${yr}-${mm}|air-annual` });
    }
  }
  return E;
}

// —— 國防部即時軍事動態：抓每日共機/共艦(往後累積真實每日資料) ——
// 列表頁只有日期+連結，實際架次在各日詳情頁(plaact/<id>)。日期為民國格式 115.07.07。
const MND_BASE = "https://www.mnd.gov.tw/";
async function collectMND(pages = 1, max = 40) {
  const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) taiwan-pulse", "Accept": "text/html,application/xhtml+xml" };
  const entries = [];
  for (let pg = 1; pg <= pages; pg++) {
    let html = "";
    try { const r = await fetch(`${MND_BASE}news/plaactlist?page=${pg}`, { headers: UA }); html = await r.text(); } catch { break; }
    const re = /plaact\/(\d+)"[\s\S]{0,160}?(\d{3})\.(\d{2})\.(\d{2})/g;
    let m; while ((m = re.exec(html)) !== null) {
      const y = 1911 + Number(m[2]);
      entries.push({ id: m[1], ev_date: `${y}-${m[3]}-${m[4]}` });
    }
  }
  const seen = new Set();
  const uniq = entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).slice(0, max);
  const items = [];
  for (let i = 0; i < uniq.length; i += 6) {
    const chunk = uniq.slice(i, i + 6);
    const res = await Promise.all(chunk.map(async (e) => {
      try {
        const h = await fetch(`${MND_BASE}news/plaact/${e.id}`, { headers: UA }).then((r) => r.text());
        const txt = h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        const air = txt.match(/共機\s*(\d+)\s*架次/); const mid = txt.match(/逾越中線[^0-9]{0,24}?(\d+)\s*架次/); const sea = txt.match(/共艦\s*(\d+)\s*艘/);
        return { e, air: air ? Number(air[1]) : null, mid: mid ? Number(mid[1]) : null, sea: sea ? Number(sea[1]) : null };
      } catch { return null; }
    }));
    for (const r of res) {
      if (!r) continue; const { e, air, mid, sea } = r;
      if (air != null) items.push({ ev_date: e.ev_date, type: "air", zone: "西南空域", lng: ZONE["西南空域"][0], lat: ZONE["西南空域"][1], cnt: air, detail: `共機 ${air} 架次${mid != null ? `(逾中線 ${mid})` : ""}${sea != null ? `、共艦 ${sea} 艘` : ""}`, source: "國防部即時軍事動態", url: `${MND_BASE}news/plaact/${e.id}`, uniq: `${e.ev_date}|air|mnd` });
      if (sea != null) items.push({ ev_date: e.ev_date, type: "sea", zone: "台海中線", lng: ZONE["台海中線"][0], lat: ZONE["台海中線"][1], cnt: sea, detail: `共艦 ${sea} 艘(次)`, source: "國防部即時軍事動態", url: `${MND_BASE}news/plaact/${e.id}`, uniq: `${e.ev_date}|sea|mnd` });
    }
  }
  const upserted = await upsertIncursions(items);
  return { ok: true, entries: uniq.length, parsed: items.length, upserted, sample: items.slice(0, 3) };
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const action = url.searchParams.get("action") || "read";
  try {
    if (action === "seed") {
      const n = await upsertIncursions(seedEvents());
      return send(res, 200, { ok: true, seeded: n });
    }
    if (action === "collect") return send(res, 200, await collectMND(Math.min(Number(url.searchParams.get("pages")) || 1, 8), Math.min(Number(url.searchParams.get("max")) || 40, 90)));
    if (action === "raw") return send(res, 200, { ok: true, raw: await incursionsRaw() });
    // read
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    const rows = await listIncursions({ from, to });
    return send(res, 200, { ok: true, count: rows.length, incursions: rows }, "s-maxage=120, stale-while-revalidate=600");
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
}
