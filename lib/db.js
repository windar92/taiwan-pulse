// 群眾辯證牆的後端儲存：Neon Postgres（跨使用者共享、取代原本的 localStorage）。
// 連線字串來自 Vercel 連接 Neon 時自動注入的 DATABASE_URL。
import { neon } from "@neondatabase/serverless";

let _sql = null;
function db() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("DATABASE_URL 未設定");
  _sql = neon(url);
  return _sql;
}

let _ready = false;
async function ensureTable() {
  if (_ready) return;
  const sql = db();
  await sql`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      place TEXT,
      kind TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      verdict TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS reports_created_idx ON reports (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS reports_geo_idx ON reports (lat, lng)`;
  _ready = true;
}

// 列出某座標附近、某時間範圍內的群眾回報。
// 用簡單經緯度方框近似（無 PostGIS）：1 緯度≈111km；經度依緯度收斂。
export async function listReports({ lat, lng, radiusKm = 5, days = 7, limit = 50 }) {
  await ensureTable();
  const sql = db();
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const nationwide = !Number.isFinite(lat) || !Number.isFinite(lng) || radiusKm >= 9999;
  const rows = nationwide
    ? await sql`SELECT id, lat, lng, place, kind, title, body, verdict, created_at
                FROM reports WHERE created_at >= ${since}
                ORDER BY created_at DESC LIMIT ${limit}`
    : await sql`SELECT id, lat, lng, place, kind, title, body, verdict, created_at
                FROM reports
                WHERE created_at >= ${since}
                  AND lat BETWEEN ${lat - latDelta} AND ${lat + latDelta}
                  AND lng BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}
                ORDER BY created_at DESC LIMIT ${limit}`;
  return rows;
}

export async function addReport({ lat, lng, place, kind, title, body, verdict }) {
  await ensureTable();
  const sql = db();
  const clean = (v, max) => String(v ?? "").slice(0, max);
  const rows = await sql`
    INSERT INTO reports (lat, lng, place, kind, title, body, verdict)
    VALUES (${Number(lat) || 0}, ${Number(lng) || 0}, ${clean(place, 120)},
            ${clean(kind, 40)}, ${clean(title, 200)}, ${clean(body, 4000)}, ${clean(verdict, 40)})
    RETURNING id, lat, lng, place, kind, title, body, verdict, created_at`;
  return rows[0];
}
