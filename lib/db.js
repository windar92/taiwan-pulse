// Neon Postgres：群眾回報(reports) + 策展事件(events)。
import { neon } from "@neondatabase/serverless";

let _sql = null;
function db() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("DATABASE_URL 未設定");
  _sql = neon(url);
  return _sql;
}

// ---------- 群眾回報牆 ----------
let _reportsReady = false;
async function ensureReports() {
  if (_reportsReady) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
    place TEXT, kind TEXT, title TEXT NOT NULL, body TEXT NOT NULL, verdict TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  _reportsReady = true;
}
export async function listReports({ lat, lng, radiusKm = 5, days = 7, limit = 50 }) {
  await ensureReports();
  const sql = db();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const nationwide = !Number.isFinite(lat) || !Number.isFinite(lng) || radiusKm >= 9999;
  if (nationwide) {
    return sql`SELECT id,lat,lng,place,kind,title,body,verdict,created_at FROM reports
               WHERE created_at >= ${since} ORDER BY created_at DESC LIMIT ${limit}`;
  }
  const latD = radiusKm / 111, lngD = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return sql`SELECT id,lat,lng,place,kind,title,body,verdict,created_at FROM reports
             WHERE created_at >= ${since} AND lat BETWEEN ${lat - latD} AND ${lat + latD}
               AND lng BETWEEN ${lng - lngD} AND ${lng + lngD}
             ORDER BY created_at DESC LIMIT ${limit}`;
}
export async function addReport({ lat, lng, place, kind, title, body, verdict }) {
  await ensureReports();
  const sql = db();
  const cut = (v, n) => String(v ?? "").slice(0, n);
  const rows = await sql`INSERT INTO reports (lat,lng,place,kind,title,body,verdict)
    VALUES (${Number(lat) || 0},${Number(lng) || 0},${cut(place, 120)},${cut(kind, 40)},${cut(title, 200)},${cut(body, 4000)},${cut(verdict, 40)})
    RETURNING id,lat,lng,place,kind,title,body,verdict,created_at`;
  return rows[0];
}

// ---------- 策展事件（新聞/公告） ----------
let _eventsReady = false;
async function ensureEvents() {
  if (_eventsReady) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    hash TEXT UNIQUE,
    source TEXT, source_name TEXT,
    categories TEXT,
    title TEXT, summary TEXT, url TEXT,
    lng DOUBLE PRECISION, lat DOUBLE PRECISION,
    place TEXT, county TEXT,
    published_at TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS events_pub_idx ON events (published_at DESC)`;
  _eventsReady = true;
}
export async function upsertEvents(items) {
  await ensureEvents();
  const sql = db();
  let inserted = 0;
  for (const e of items) {
    try {
      const r = await sql`INSERT INTO events (hash,source,source_name,categories,title,summary,url,lng,lat,place,county,published_at)
        VALUES (${e.hash},${e.source},${e.source_name},${e.categories},${e.title},${e.summary},${e.url},${e.lng},${e.lat},${e.place},${e.county},${e.published_at})
        ON CONFLICT (hash) DO NOTHING RETURNING id`;
      if (r.length) inserted++;
    } catch {}
  }
  return inserted;
}
export async function listEvents({ days = 7, limit = 600 }) {
  await ensureEvents();
  const sql = db();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return sql`SELECT source_name,categories,title,summary,url,lng,lat,place,county,published_at
             FROM events WHERE published_at >= ${since} ORDER BY published_at DESC LIMIT ${limit}`;
}
export async function pruneEvents(days = 30) {
  await ensureEvents();
  const sql = db();
  const cut = new Date(Date.now() - days * 86400000).toISOString();
  await sql`DELETE FROM events WHERE published_at < ${cut}`;
}
