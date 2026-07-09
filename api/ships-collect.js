// 爆發式 AIS 收集器：連 AISStream websocket ~38 秒，過濾中國籍(MMSI 412/413/414)，寫入 ships 表。
// 由排程(GitHub Actions)每幾分鐘觸發。需環境變數 AISSTREAM_KEY。
import WebSocket from "ws";
import { upsertShips, pruneShips, appendShipTracks, pruneShipTracks } from "../lib/db.js";

export const config = { maxDuration: 60 };

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

export default async function handler(req, res) {
  const key = process.env.AISSTREAM_KEY;
  const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
  if (!key) return send(200, { ok: false, error: "AISSTREAM_KEY 未設定" });

  const ships = new Map();
  const isCN = (m) => { const p = String(m || "").slice(0, 3); return p === "412" || p === "413" || p === "414"; };
  const url = new URL(req.url, "http://x");
  const winMs = Math.min(Math.max(Number(url.searchParams.get("ms")) || 38000, 3000), 55000);
  const debug = url.searchParams.get("debug") === "1";
  const diag = { total: 0, cn: 0, errors: [], opened: false };

  await new Promise((resolve) => {
    let ws, done = false;
    const finish = () => { if (done) return; done = true; try { ws && ws.close(); } catch {} resolve(); };
    const timer = setTimeout(finish, winMs);
    try {
      ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
      ws.on("open", () => {
        diag.opened = true;
        ws.send(JSON.stringify({
          APIKey: key,
          BoundingBoxes: [[[5, 108], [30, 128]], [[30, 117], [46, 145]]], // 南海+台/菲/東海 ; 黃渤海+日本海
          FilterMessageTypes: ["PositionReport", "ShipStaticData"],
        }));
      });
      ws.on("message", (buf) => {
        let m; try { m = JSON.parse(buf.toString()); } catch { return; }
        diag.total++;
        if (m.error || m.Error) { if (diag.errors.length < 3) diag.errors.push(m.error || m.Error); return; }
        const mmsi = m?.MetaData?.MMSI; if (!isCN(mmsi)) return;
        diag.cn++;
        const id = String(mmsi);
        const cur = ships.get(id) || { mmsi: id };
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
        ships.set(id, cur);
      });
      ws.on("error", finish);
      ws.on("close", () => { clearTimeout(timer); finish(); });
    } catch { finish(); }
  });

  const list = [...ships.values()].filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
  let inserted = 0, tracked = 0;
  try { inserted = await upsertShips(list); await pruneShips(168).catch(() => {}); } catch (e) { return send(500, { ok: false, error: e.message, collected: list.length, diag }); }
  // 持續存檔航跡(近 7 天),讓航跡歷史不斷累積
  try { tracked = await appendShipTracks(list); await pruneShipTracks(7).catch(() => {}); } catch {}
  return send(200, { ok: true, collected: list.length, upserted: inserted, tracked, ...(debug ? { diag } : {}) });
}
