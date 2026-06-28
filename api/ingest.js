// 排程抓取端點：由 GitHub Actions 每 30 分鐘呼叫。以 INGEST_SECRET 保護。
import { runIngest } from "../lib/ingest.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const secret = process.env.INGEST_SECRET;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const given = req.headers["x-ingest-secret"] || url.searchParams.get("key");
  if (secret && given !== secret) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }
  try {
    const result = await runIngest();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}
