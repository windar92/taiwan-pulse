// 常駐 AIS 收集器 —— 一條 WebSocket 長連線，取代「每 5 分鐘重開一次」的排程做法。
//
// 為什麼要這樣做：AISStream 是串流服務，用排程去模擬串流（每 5 分鐘開 55 秒）
// 既浪費資源（GitHub Actions 約 1,440 分鐘/天），中間還有空隙會漏船。
// 常駐一條連線資源更省、密度更高（連續無縫）。
//
// 可跑在：本機 Windows / Oracle Cloud Always Free VM / 樹莓派，行為完全相同。
//
// 需要環境變數（放在同層 .env 或系統環境變數）：
//   AISSTREAM_KEY   AISStream 金鑰
//   DATABASE_URL    Neon 連線字串（與 Vercel 上同一個）
//
// 執行：node ais-collector.mjs

import WebSocket from "ws";
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- 讀 .env（不覆蓋已存在的系統環境變數）----
const HERE = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(HERE, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
} catch { /* 沒有 .env 就用系統環境變數 */ }

const KEY = process.env.AISSTREAM_KEY;
const DB = process.env.DATABASE_URL;
if (!KEY) { console.error("[fatal] 缺少 AISSTREAM_KEY"); process.exit(1); }
if (!DB) { console.error("[fatal] 缺少 DATABASE_URL"); process.exit(1); }

const sql = neon(DB);

// 與 api/ships.js 完全一致的設定
const BOXES = [[[5, 108], [30, 128]], [[30, 117], [46, 145]]];
const FLUSH_MS = 60_000;   // 每分鐘寫一次資料庫（批次寫，省連線）
const PRUNE_MS = 3_600_000; // 每小時清一次過期資料

const isCN = (m) => { const p = String(m || "").slice(0, 3); return p === "412" || p === "413" || p === "414"; };
function shipClass(t) {
  if (t == null) return null;
  if (t === 30) return "漁船";
  if (t === 31 || t === 32 || t === 52) return "拖船作業";
  if (t >= 60 && t <= 69) return "客船";
  if (t >= 70 && t <= 79) return "貨船";
  if (t >= 80 && t <= 89) return "油輪/化學船";
  if (t >= 40 && t <= 49) return "高速船";
  if (t === 35) return "軍事";
  return "其他";
}

// ---- 資料庫（與 lib/db.js 同結構，獨立實作以免相依 Vercel 專案）----
async function ensureTables() {
  await sql`CREATE TABLE IF NOT EXISTS ships (
    mmsi TEXT PRIMARY KEY, name TEXT, shiptype INTEGER, cls TEXT,
    lng DOUBLE PRECISION, lat DOUBLE PRECISION, sog DOUBLE PRECISION,
    cog DOUBLE PRECISION, navstat INTEGER, updated_at TIMESTAMPTZ DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS ships_upd_idx ON ships (updated_at DESC)`;
}
async function upsertShips(items) {
  let n = 0;
  for (const s of items) {
    try {
      await sql`INSERT INTO ships (mmsi,name,shiptype,cls,lng,lat,sog,cog,navstat,updated_at)
        VALUES (${s.mmsi},${s.name || null},${s.shiptype ?? null},${s.cls || null},${s.lng},${s.lat},${s.sog ?? null},${s.cog ?? null},${s.navstat ?? null}, now())
        ON CONFLICT (mmsi) DO UPDATE SET
          name = COALESCE(EXCLUDED.name, ships.name), shiptype = COALESCE(EXCLUDED.shiptype, ships.shiptype),
          cls = COALESCE(EXCLUDED.cls, ships.cls), lng = EXCLUDED.lng, lat = EXCLUDED.lat,
          sog = EXCLUDED.sog, cog = EXCLUDED.cog, navstat = EXCLUDED.navstat, updated_at = now()`;
      n++;
    } catch (e) { console.error("[db] upsert 失敗", s.mmsi, e.message); }
  }
  return n;
}
async function appendTracks(items) {
  let n = 0;
  for (const s of items) {
    try {
      await sql`INSERT INTO ship_tracks (mmsi,lng,lat,sog,cog,ts) VALUES (${s.mmsi},${s.lng},${s.lat},${s.sog ?? null},${s.cog ?? null}, now())`;
      n++;
    } catch { /* ship_tracks 由主專案建立；不存在就略過 */ }
  }
  return n;
}

// ---- 收集狀態 ----
const buf = new Map();          // mmsi -> 最新一筆
let stat = { msgs: 0, cn: 0, flushes: 0, upserts: 0, reconnects: 0, since: new Date() };

function connect() {
  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
  let alive = false;

  ws.on("open", () => {
    alive = true;
    ws.send(JSON.stringify({ APIKey: KEY, BoundingBoxes: BOXES, FilterMessageTypes: ["PositionReport", "ShipStaticData"] }));
    console.log(`[${ts()}] 已連線 AISStream，開始接收`);
  });

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    stat.msgs++;
    if (m.error || m.Error) { console.error(`[${ts()}] AISStream 回報錯誤：`, m.error || m.Error); return; }
    const mmsi = m?.MetaData?.MMSI;
    if (!isCN(mmsi)) return;
    stat.cn++;
    const id = String(mmsi);
    const cur = buf.get(id) || { mmsi: id };
    if (m.MessageType === "PositionReport") {
      const p = m.Message?.PositionReport || {};
      if (typeof p.Latitude === "number") { cur.lat = p.Latitude; cur.lng = p.Longitude; }
      if (typeof p.Sog === "number") cur.sog = p.Sog;
      if (typeof p.Cog === "number") cur.cog = p.Cog;
      if (typeof p.NavigationalStatus === "number") cur.navstat = p.NavigationalStatus;
      if (m.MetaData?.ShipName) cur.name = String(m.MetaData.ShipName).trim();
    } else if (m.MessageType === "ShipStaticData") {
      const sd = m.Message?.ShipStaticData || {};
      if (typeof sd.Type === "number") { cur.shiptype = sd.Type; cur.cls = shipClass(sd.Type); }
      cur.name = String(sd.Name || m.MetaData?.ShipName || cur.name || "").trim() || cur.name;
    }
    buf.set(id, cur);
  });

  const retry = (why) => {
    if (!ws._retried) {
      ws._retried = true;
      const wait = alive ? 3000 : 15000; // 連上過就快速重連；連不上則退避
      stat.reconnects++;
      console.error(`[${ts()}] 連線中斷(${why})，${wait / 1000}s 後重連`);
      setTimeout(connect, wait);
    }
  };
  ws.on("error", (e) => retry(e.message));
  ws.on("close", () => retry("close"));
}

async function flush() {
  const list = [...buf.values()].filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
  buf.clear();
  if (!list.length) return;
  try {
    const n = await upsertShips(list);
    await appendTracks(list);
    stat.flushes++; stat.upserts += n;
    console.log(`[${ts()}] 寫入 ${n} 艘（累計訊息 ${stat.msgs}／中國籍 ${stat.cn}ｏ重連 ${stat.reconnects}）`);
  } catch (e) {
    console.error(`[${ts()}] 寫入失敗：`, e.message);
  }
}

async function prune() {
  try {
    await sql`DELETE FROM ships WHERE updated_at < now() - interval '24 hours'`;
    await sql`DELETE FROM ship_tracks WHERE ts < now() - interval '7 days'`.catch(() => {});
  } catch { /* ignore */ }
}

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

process.on("SIGINT", async () => { console.log("\n收到中斷，最後寫入一次…"); await flush(); process.exit(0); });
process.on("SIGTERM", async () => { await flush(); process.exit(0); });
process.on("unhandledRejection", (e) => console.error("[unhandled]", e?.message || e));

await ensureTables();
console.log(`[${ts()}] AIS 常駐收集器啟動（每 ${FLUSH_MS / 1000}s 寫入一次）`);
connect();
setInterval(flush, FLUSH_MS);
setInterval(prune, PRUNE_MS);
