// 即時影像攝影機(多類別)唯讀代理：整併多個「keyless(免金鑰)」政府開放資料來源
// 統一輸出：{ ok, count, sources:[{cat,name,count,ok,error?}], cams:[{id,lon,lat,cat,name,desc,img,src}] }
//
// ============================= 已驗證並納入的來源 =============================
// [highway] 省道 CCTV — 交通部公路局「公路即時影像」開放資料
//   端點：https://cctv-maintain.thb.gov.tw/opendataCCTVs.xml (XML，免金鑰)
//   欄位：CCTVID / PositionLon / PositionLat / RoadName / RoadDirection / LocationMile / VideoImageURL(快照JPEG)
//   備註：與 api/live.js 的 cctv() 為同一來源，本檔獨立重新抓取(不呼叫 live.js)以保持模組互相獨立。
//         已於正式站證實 <img src=VideoImageURL> 可直接顯示，無 referer 限制。
//
// [river]   水利/河川防災影像(含縣市政府與水利署合建之路口淹水攝影機) — 經濟部水利署
//   端點：https://sta.colife.org.tw/STA_WaterResource_v2/v1.0/Datastreams
//         （「民生公共物聯網 Civil IoT Taiwan」資料服務平台之 OGC SensorThings API，免金鑰）
//         舊網址 sta.ci.taiwan.gov.tw 已停用，正確網址為 sta.colife.org.tw（2026-07-13 實測確認）。
//   查法：篩選 Datastream name = "視訊監測影格照片"，並 $expand=Thing($expand=Locations) 一次取得座標。
//         影像網址規則固定為 https://iapi.wra.gov.tw/v3/api/Image/{Datastream_id}
//         （Datastream_id 需從 description 欄位以正規表示式解析），已實測回傳 200 + image/jpeg。
//   規模：2026-07-13 實測 name="視訊監測影格照片" 共 3887 筆(水利署自建 371 站 + 與縣市合建 607 站 為官方
//         首頁列出的「站」數，Datastream 筆數更多，一站可能不只一支攝影機/一個影格資料流)。
//   備註：authority_type 有「水利署」(河川分署自建，河岸/水閘) 與「水利署（與縣市政府合建）」(多為都會區
//         路口淹水感測攝影機，實質上也涵蓋不少「市區道路」路口影像)，本檔統一歸類為 cat="river"。
//
// ============================= 研究過但「找不到/未納入」的來源（誠實記錄，不硬湊） =============================
// [freeway 國道] 高速公路局 TISVCloud 交通資料庫
//   已由政府資料開放平臺 metadata API 查得官方端點：
//     https://tisvcloud.freeway.gov.tw/history/motc20/CCTV.xml
//     （data.gov.tw dataset 37665《CCTV 靜態資訊(v2.0)》，欄位含 CCTVID/VideoStreamURL/PositionLon/PositionLat，
//      每日更新、免金鑰、resourceQualityCheckTime 顯示近期仍在正常品質檢測中）
//   未納入原因：(1) 本次研究環境對 tisvcloud.freeway.gov.tw / 1968.freeway.gov.tw 網域的連線持續失敗(多次重試皆
//       無回應，推測該網域有額外的邊界防護)，無法用 WebFetch 實際取得一筆即時資料驗證欄位內容；
//       (2) 第三方社群文件(GitHub Gist「台灣公路 CCTV 列表」)顯示 VideoStreamURL 對應的其實是
//       「https://cctvs.freeway.gov.tw/live-view/mjpg/video.cgi?camera=NNN」這類 MJPEG 直播流，理論上仍可用
//       <img src> 顯示，但欄位確切內容與是否所有站台皆為此格式，未能實測confirm，依規則寧缺勿濫先不寫入。
//       建議：部署到 Vercel(該環境對外連線不受此限)後，手動呼叫一次上述 CCTV.xml 確認 VideoStreamURL 實際格式，
//       確認後可仿照 highway() 的寫法新增 freeway() 來源。
//
// [city 市區道路(獨立於水利署合建路口以外的一般市區路口影像)]
//   查到臺中市政府交通局「臺中市交通即時道路影像/交通影像靜態資訊」開放資料集(945 支攝影機，欄位含
//   cctvid/roadsection/px/py/url/status)，資料集頁面亦有使用者留言確認「網址置於網址列可正常看到影像」。
//   未納入原因：本次研究環境無法從資料集頁面(JS 動態渲染)取得實際 JSON/CSV 下載網址(CKAN 慣用 API 路徑
//   在此網域行不通)，且不確定 px/py 座標系統是否為 WGS84 經緯度，故未列入 cams.js 以免寫入未驗證的猜測網址。
//   （水利署合建站已涵蓋不少都會路口淹水攝影機，可視為部分替代）
//
// [scenic/coast 旅遊景點/風景區/國家公園/海岸港口]
//   查無 keyless 且已實測可用的官方即時影像 API（觀光署/國家風景區管理處/國家公園多僅提供網頁內嵌
//   YouTube 直播或需登入之系統，非可批次取用經緯度+快照圖 URL 的開放資料）。誠實回報：找不到。
//
export const config = { maxDuration: 60 };

const UA = { "User-Agent": "TaiwanPulse/0.1 (+map)" };
// 台灣本島+離島範圍；含金門(約118.3E)、馬祖(約119.9E)
const BBOX = { lon0: 118, lon1: 123.5, lat0: 21, lat1: 26.5 };

function send(res, status, obj, cache) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache });
  res.end(JSON.stringify(obj));
}
function inBBox(lon, lat) {
  return Number.isFinite(lon) && Number.isFinite(lat) &&
    lon >= BBOX.lon0 && lon <= BBOX.lon1 && lat >= BBOX.lat0 && lat <= BBOX.lat1;
}

// ---- [highway] 省道 CCTV：公路局開放資料 XML ----
async function highway() {
  const r = await fetch("https://cctv-maintain.thb.gov.tw/opendataCCTVs.xml", { headers: UA });
  if (!r.ok) throw new Error("thb cctv " + r.status);
  const xml = await r.text();
  const pick = (b, tag) => { const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ""; };
  const cams = [];
  const re = /<CCTV>([\s\S]*?)<\/CCTV>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const lon = parseFloat(pick(b, "PositionLon")), lat = parseFloat(pick(b, "PositionLat"));
    if (!inBBox(lon, lat)) continue;
    const img = pick(b, "VideoImageURL");
    if (!img) continue;
    const road = pick(b, "RoadName"), dir = pick(b, "RoadDirection"), mile = pick(b, "LocationMile");
    cams.push({
      id: "thb-" + pick(b, "CCTVID"),
      lon, lat,
      cat: "highway",
      name: [road, dir].filter(Boolean).join(" ") || "省道CCTV",
      desc: [road, mile, dir].filter(Boolean).join(" "),
      img,
      src: "公路局(省道CCTV開放資料)",
    });
  }
  return cams;
}

// ---- [freeway] 國道 CCTV：高公局 TISVCloud ----
// 注意：2026-07-13 實測 tisvcloud.freeway.gov.tw 連線逾時(ERR_CONNECTION_TIMED_OUT，連台灣本地
// 瀏覽器亦不通)，研判官方服務當時中斷。此處仍保留實作，靠 Promise.allSettled 讓它失敗時
// 不影響其他來源；等官方恢復即會自動生效(前端會看到 freeway 類別的點自己冒出來)。
async function freeway() {
  const r = await fetch("https://tisvcloud.freeway.gov.tw/history/motc20/CCTV.xml", {
    headers: UA, signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error("tisv " + r.status);
  const xml = await r.text();
  const pick = (b, tag) => { const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ""; };
  const cams = [];
  const re = /<CCTV>([\s\S]*?)<\/CCTV>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const lon = parseFloat(pick(b, "PositionLon")), lat = parseFloat(pick(b, "PositionLat"));
    if (!inBBox(lon, lat)) continue;
    const img = pick(b, "VideoImageURL") || pick(b, "VideoStreamURL");
    if (!img) continue;
    cams.push({
      id: "nfb-" + pick(b, "CCTVID"),
      lon, lat,
      cat: "freeway",
      name: pick(b, "RoadName") || "國道CCTV",
      desc: [pick(b, "RoadName"), pick(b, "LocationMile"), pick(b, "RoadDirection")].filter(Boolean).join(" "),
      img,
      src: "高速公路局 TISVCloud",
    });
  }
  return cams;
}

// ---- [river / flood] 水利防災影像：水利署 SensorThings API(民生公共物聯網 sta.colife.org.tw) ----
// 資料結構（2026-07-13 實測）：
//   Datastreams?$filter=name eq '視訊監測影格照片'  → 共 3887 筆
//   座標在 Thing→Locations[0].location.coordinates ([lon,lat])
//   站名/機關在 Thing.properties: { stationName, authority, authority_type, stationCode }
//   ★影像網址在「最新一筆 Observation 的 result」(字串)，形如
//     https://iapi.wra.gov.tw/v3/api/Image/<uuid>
//     ——不是 Datastream 的 id，別搞錯。已實測 <img> 可直接載入(400x300 / 480x360)、無 referer 防盜連。
// 分類：authority_type = "水利署" → 河川分署自建(河岸/水閘) → cat "river"
//       authority_type = "水利署（與縣市政府合建）" → 多為都會區路口淹水攝影機 → cat "flood"
const STA_BASE = "https://sta.colife.org.tw/STA_WaterResource_v2/v1.0";
async function wraCams() {
  const cams = [];
  const q = "$filter=" + encodeURIComponent("name eq '視訊監測影格照片'") +
    "&$expand=" + encodeURIComponent("Thing($expand=Locations),Observations($top=1)") +
    "&$top=1000";
  let url = `${STA_BASE}/Datastreams?${q}`;
  let guard = 0;
  while (url && guard < 8) { // 約 3900 筆 / 1000 筆一頁 ≈ 4 頁；guard 防上游分頁異常無窮迴圈
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("wra sta " + r.status);
    const j = await r.json();
    for (const d of (j.value || [])) {
      const th = d.Thing || {};
      const coords = th.Locations && th.Locations[0] && th.Locations[0].location && th.Locations[0].location.coordinates;
      const lon = coords && Number(coords[0]), lat = coords && Number(coords[1]);
      if (!inBBox(lon, lat)) continue;
      const ob = (d.Observations || [])[0];
      const img = ob && typeof ob.result === "string" ? ob.result : "";
      if (!/^https?:\/\//.test(img)) continue; // 沒有可用影像網址就跳過
      const p = th.properties || {};
      const joint = String(p.authority_type || "").includes("縣市");
      cams.push({
        id: "wra-" + (p.stationCode || d["@iot.id"]),
        lon, lat,
        cat: joint ? "flood" : "river",
        name: p.stationName || "水利防災影像",
        desc: [p.authority, p.stationCode].filter(Boolean).join(" · "),
        img,
        src: "水利署 水利防災影像(民生公共物聯網 SensorThings API)",
      });
    }
    url = j["@iot.nextLink"] || null;
    guard++;
  }
  return cams;
}

// ---- 去重 ----
// 路口/河川鏡頭：同座標(4位小數≈11公尺)視為同一支，只留第一筆。
// 景點鏡頭(scenic)：不做座標去重——多支鏡頭常共用同一個「概略座標」(例：角板山思親亭/生態池/梅園
// 都只能定位到「角板山」)，若照座標去重會把不同鏡頭誤刪。改以 id 去重，並把重疊點做微小偏移以利點選。
function dedupe(cams) {
  const seenPos = new Set(), seenId = new Set(), out = [];
  const posCount = new Map();
  for (let c of cams) { // 注意：下面會對 c 重新賦值(散開重疊點)，故用 let
    if (c.cat === "scenic") {
      if (seenId.has(c.id)) continue;
      seenId.add(c.id);
      const k = c.lon.toFixed(4) + "," + c.lat.toFixed(4);
      const n = posCount.get(k) || 0;
      posCount.set(k, n + 1);
      if (n > 0) { // 同座標第 2 支以後，繞小圓散開約 120 公尺，避免完全疊住點不到
        const ang = (n * 2 * Math.PI) / 6, r = 0.0011;
        c = { ...c, lon: +(c.lon + r * Math.cos(ang)).toFixed(6), lat: +(c.lat + r * Math.sin(ang)).toFixed(6) };
      }
      out.push(c);
      continue;
    }
    const k = c.lon.toFixed(4) + "," + c.lat.toFixed(4);
    if (seenPos.has(k)) continue;
    seenPos.add(k);
    out.push(c);
  }
  return out;
}

// ---- [scenic] 觀光景點直播：交通部觀光署「即時影像 Live Taiwan」 ----
// 各國家風景區管理處/觀光署在 YouTube 發布的官方直播(62 支)。清單為靜態檔 public/scenic-cams.json，
// 由觀光署官方頁 https://www.taiwan.net.tw/m1.aspx?sNo=0042331 整理、座標以 OSM Nominatim 反查。
// 快照直接用 YouTube 的「直播即時縮圖」https://i.ytimg.com/vi/<id>/hqdefault_live.jpg
//   → 已實測 480x360、隨直播更新、無 referer 防盜連，等同其他鏡頭的快照 UX。
// p="approx" 者座標僅為概略推估(只能定位到母地標或行政區)，前端會標註可能有偏差。
import { readFile } from "node:fs/promises";
async function scenic(req) {
  let raw;
  try {
    raw = await readFile(new URL("../public/scenic-cams.json", import.meta.url), "utf8");
  } catch {
    // Vercel 打包時若拿不到檔案，改用 HTTP 取同專案的 public 靜態檔
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    const r = await fetch(`${proto}://${host}/scenic-cams.json`);
    if (!r.ok) throw new Error("scenic json " + r.status);
    raw = await r.text();
  }
  const j = JSON.parse(raw);
  return (j.cams || [])
    .filter((c) => inBBox(c.lon, c.lat))
    .map((c) => ({
      id: "yt-" + c.yt,
      lon: c.lon, lat: c.lat,
      cat: "scenic",
      name: c.name,
      desc: c.city + (c.p === "approx" ? "　※此點位為概略推估，實際鏡頭位置可能有偏差" : ""),
      img: `https://i.ytimg.com/vi/${c.yt}/hqdefault_live.jpg`,
      link: `https://www.youtube.com/watch?v=${c.yt}`,
      approx: c.p === "approx",
      src: "交通部觀光署 即時影像(YouTube 官方直播)",
    }));
}

// 每個 fetcher 各自獨立(Promise.allSettled)；wraCams 一次抓完再依 authority_type 拆 river/flood(不重複抓)
const FETCHERS = [
  { key: "thb", name: "省道 CCTV(公路局)", fn: highway },
  { key: "nfb", name: "國道 CCTV(高公局 TISVCloud)", fn: freeway },
  { key: "wra", name: "水利防災影像(水利署)", fn: wraCams },
  { key: "tour", name: "觀光景點直播(觀光署)", fn: scenic },
];
const CAT_LABEL = { freeway: "國道", highway: "省道/快速道路", river: "河川/水利", flood: "路口淹水", scenic: "觀光景點" };

export default async function handler(req, res) {
  const settled = await Promise.allSettled(FETCHERS.map((s) => s.fn(req)));
  let cams = [];
  const feeds = settled.map((r, i) => {
    const s = FETCHERS[i];
    if (r.status === "fulfilled") {
      cams = cams.concat(r.value);
      return { key: s.key, name: s.name, count: r.value.length, ok: true };
    }
    return { key: s.key, name: s.name, count: 0, ok: false, error: String((r.reason && r.reason.message) || r.reason) };
  });
  cams = dedupe(cams);
  const byCat = {};
  for (const c of cams) byCat[c.cat] = (byCat[c.cat] || 0) + 1;
  const cats = Object.keys(byCat).map((k) => ({ cat: k, label: CAT_LABEL[k] || k, count: byCat[k] }));
  return send(res, 200, { ok: true, count: cams.length, cats, feeds, cams }, "s-maxage=600, stale-while-revalidate=1800");
}
