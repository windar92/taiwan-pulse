// 錯誤回報：GET 回傳各選項被選次數（用於前三置頂）；GET ?list=1 列出近期回報供檢視；POST 新增回報。
import { addFeedback, feedbackStats, listFeedback } from "../lib/db.js";

async function readBody(req) {
  let d = ""; for await (const c of req) d += c;
  try { return JSON.parse(d || "{}"); } catch { return {}; }
}

export default async function handler(req, res) {
  const send = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(o));
  };
  try {
    if (req.method === "POST") {
      const b = await readBody(req);
      const opts = Array.isArray(b.options) ? b.options.join(",") : b.options;
      if (!opts) return send(400, { ok: false, error: "缺少回報選項" });
      await addFeedback({ event_hash: b.event_hash, event_title: b.event_title, options: opts, note: b.note });
      return send(200, { ok: true });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.searchParams.get("list")) return send(200, { ok: true, feedback: await listFeedback({ limit: 200 }) });
    return send(200, { ok: true, stats: await feedbackStats() });
  } catch (e) {
    return send(500, { ok: false, error: e.message });
  }
}
