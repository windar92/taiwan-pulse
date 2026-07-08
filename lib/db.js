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
      // 衝突時更新分類與座標，讓規則調整能套用到舊資料（xmax=0 代表這次是新插入）
      const r = await sql`INSERT INTO events (hash,source,source_name,categories,title,summary,url,lng,lat,place,county,published_at)
        VALUES (${e.hash},${e.source},${e.source_name},${e.categories},${e.title},${e.summary},${e.url},${e.lng},${e.lat},${e.place},${e.county},${e.published_at})
        ON CONFLICT (hash) DO UPDATE SET
          categories = EXCLUDED.categories, title = EXCLUDED.title, summary = EXCLUDED.summary,
          lng = EXCLUDED.lng, lat = EXCLUDED.lat, place = EXCLUDED.place, county = EXCLUDED.county
        RETURNING (xmax = 0) AS inserted`;
      if (r.length && r[0].inserted) inserted++;
    } catch {}
  }
  return inserted;
}
export async function listEvents({ days = 7, limit = 600 }) {
  await ensureEvents();
  const sql = db();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return sql`SELECT hash,source_name,categories,title,summary,url,lng,lat,place,county,published_at
             FROM events WHERE published_at >= ${since} ORDER BY published_at DESC LIMIT ${limit}`;
}
export async function pruneEvents(days = 30) {
  await ensureEvents();
  const sql = db();
  const cut = new Date(Date.now() - days * 86400000).toISOString();
  await sql`DELETE FROM events WHERE published_at < ${cut}`;
}

// ---------- 錯誤回報 ----------
let _fbReady = false;
async function ensureFeedback() {
  if (_fbReady) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS feedback (
    id BIGSERIAL PRIMARY KEY, event_hash TEXT, event_title TEXT,
    options TEXT, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  _fbReady = true;
}
export async function addFeedback({ event_hash, event_title, options, note }) {
  await ensureFeedback();
  const sql = db();
  const cut = (v, n) => String(v ?? "").slice(0, n);
  await sql`INSERT INTO feedback (event_hash,event_title,options,note)
    VALUES (${cut(event_hash, 80)},${cut(event_title, 240)},${cut(options, 400)},${cut(note, 500)})`;
  return true;
}
export async function feedbackStats() {
  await ensureFeedback();
  const sql = db();
  const rows = await sql`SELECT options FROM feedback LIMIT 5000`;
  const tally = {};
  for (const r of rows) for (const o of String(r.options || "").split(",")) {
    const k = o.trim(); if (k) tally[k] = (tally[k] || 0) + 1;
  }
  return tally;
}
export async function listFeedback({ limit = 200 } = {}) {
  await ensureFeedback();
  const sql = db();
  return sql`SELECT event_title,options,note,created_at FROM feedback ORDER BY created_at DESC LIMIT ${limit}`;
}

// ---------- 船舶 AIS ----------
let _shipsReady = false;
async function ensureShips() {
  if (_shipsReady) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS ships (
    mmsi TEXT PRIMARY KEY, name TEXT, shiptype INTEGER, cls TEXT,
    lng DOUBLE PRECISION, lat DOUBLE PRECISION, sog DOUBLE PRECISION, cog DOUBLE PRECISION,
    navstat INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS ships_upd_idx ON ships (updated_at DESC)`;
  _shipsReady = true;
}
export async function upsertShips(items) {
  await ensureShips();
  const sql = db();
  let n = 0;
  for (const s of items) {
    try {
      await sql`INSERT INTO ships (mmsi,name,shiptype,cls,lng,lat,sog,cog,navstat,updated_at)
        VALUES (${s.mmsi},${s.name || null},${s.shiptype ?? null},${s.cls || null},${s.lng},${s.lat},${s.sog ?? null},${s.cog ?? null},${s.navstat ?? null}, now())
        ON CONFLICT (mmsi) DO UPDATE SET
          name = COALESCE(EXCLUDED.name, ships.name), shiptype = COALESCE(EXCLUDED.shiptype, ships.shiptype),
          cls = EXCLUDED.cls, lng = EXCLUDED.lng, lat = EXCLUDED.lat, sog = EXCLUDED.sog, cog = EXCLUDED.cog,
          navstat = EXCLUDED.navstat, updated_at = now()`;
      n++;
    } catch {}
  }
  return n;
}
export async function listShips({ minutes = 120, limit = 5000 } = {}) {
  await ensureShips();
  const sql = db();
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  return sql`SELECT mmsi,name,shiptype,cls,lng,lat,sog,cog,navstat,updated_at FROM ships
             WHERE updated_at >= ${since} ORDER BY updated_at DESC LIMIT ${limit}`;
}
export async function shipsRaw() {
  await ensureShips();
  const sql = db();
  const c = await sql`SELECT count(*)::int AS n, max(updated_at) AS latest, min(updated_at) AS earliest FROM ships`;
  return c[0];
}
export async function pruneShips(hours = 24) {
  await ensureShips();
  const sql = db();
  const cut = new Date(Date.now() - hours * 3600000).toISOString();
  await sql`DELETE FROM ships WHERE updated_at < ${cut}`;
}

// ---- 中國船歷史航跡(附加式，累積成近 7 天軌跡) ----
let _trkReady = false;
async function ensureTracks() {
  if (_trkReady) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS ship_tracks (
    id BIGSERIAL PRIMARY KEY, mmsi TEXT NOT NULL,
    lng DOUBLE PRECISION, lat DOUBLE PRECISION, sog DOUBLE PRECISION, cog DOUBLE PRECISION,
    navstat INTEGER, ts TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS ship_tracks_mmsi_ts ON ship_tracks (mmsi, ts)`;
  await sql`CREATE INDEX IF NOT EXISTS ship_tracks_ts ON ship_tracks (ts)`;
  _trkReady = true;
}
// 每次收集後附加一批目前位置點(每船一點/批)
export async function appendShipTracks(items) {
  await ensureTracks();
  const sql = db();
  let n = 0;
  for (const s of items) {
    if (typeof s.lat !== "number" || typeof s.lng !== "number") continue;
    try {
      await sql`INSERT INTO ship_tracks (mmsi,lng,lat,sog,cog,navstat) VALUES (${s.mmsi},${s.lng},${s.lat},${s.sog ?? null},${s.cog ?? null},${s.navstat ?? null})`;
      n++;
    } catch {}
  }
  return n;
}
// 回傳近 N 天各船軌跡點(依 mmsi、時間排序)
export async function listShipTracks({ days = 7, limit = 60000 } = {}) {
  await ensureTracks();
  const sql = db();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return sql`SELECT mmsi,lng,lat,sog,cog,navstat,ts FROM ship_tracks
             WHERE ts >= ${since} ORDER BY mmsi, ts ASC LIMIT ${limit}`;
}
export async function shipTracksRaw() {
  await ensureTracks();
  const sql = db();
  const c = await sql`SELECT count(*)::int AS n, count(DISTINCT mmsi)::int AS vessels, max(ts) AS latest, min(ts) AS earliest FROM ship_tracks`;
  return c[0];
}
export async function pruneShipTracks(days = 7) {
  await ensureTracks();
  const sql = db();
  const cut = new Date(Date.now() - days * 86400000).toISOString();
  await sql`DELETE FROM ship_tracks WHERE ts < ${cut}`;
}

// ---------- 河川水位站(水牆) ----------
let _riverReady = false;
async function ensureRiver() {
  if (_riverReady) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS river_stations (
    id TEXT PRIMARY KEY, name TEXT, river TEXT,
    lng DOUBLE PRECISION, lat DOUBLE PRECISION,
    warn1 DOUBLE PRECISION, warn2 DOUBLE PRECISION, warn3 DOUBLE PRECISION,
    zero_elev DOUBLE PRECISION,
    cur_level DOUBLE PRECISION, cur_time TIMESTAMPTZ,
    sum_level DOUBLE PRECISION NOT NULL DEFAULT 0,
    cnt_level INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  _riverReady = true;
}
// 寫入/更新測站基本資料(座標、河名、警戒水位)。不動水位累積欄位。
export async function upsertRiverMeta(items) {
  await ensureRiver();
  const sql = db();
  let n = 0;
  for (const s of items) {
    if (!s.id) continue;
    try {
      await sql`INSERT INTO river_stations (id,name,river,lng,lat,warn1,warn2,warn3,zero_elev)
        VALUES (${s.id},${s.name || null},${s.river || null},${s.lng ?? null},${s.lat ?? null},${s.warn1 ?? null},${s.warn2 ?? null},${s.warn3 ?? null},${s.zero_elev ?? null})
        ON CONFLICT (id) DO UPDATE SET
          name = COALESCE(EXCLUDED.name, river_stations.name),
          river = COALESCE(EXCLUDED.river, river_stations.river),
          lng = COALESCE(EXCLUDED.lng, river_stations.lng),
          lat = COALESCE(EXCLUDED.lat, river_stations.lat),
          warn1 = EXCLUDED.warn1, warn2 = EXCLUDED.warn2, warn3 = EXCLUDED.warn3,
          zero_elev = COALESCE(EXCLUDED.zero_elev, river_stations.zero_elev)`;
      n++;
    } catch {}
  }
  return n;
}
// 寫入即時水位並累積平均(同一觀測時間不重複計入)。
export async function upsertRiverLevel(items) {
  await ensureRiver();
  const sql = db();
  let n = 0;
  for (const r of items) {
    if (!r.id || typeof r.level !== "number") continue;
    try {
      await sql`INSERT INTO river_stations (id,cur_level,cur_time,sum_level,cnt_level)
        VALUES (${r.id},${r.level},${r.time || null},${r.level},1)
        ON CONFLICT (id) DO UPDATE SET
          sum_level = river_stations.sum_level + CASE WHEN river_stations.cur_time IS DISTINCT FROM EXCLUDED.cur_time THEN EXCLUDED.cur_level ELSE 0 END,
          cnt_level = river_stations.cnt_level + CASE WHEN river_stations.cur_time IS DISTINCT FROM EXCLUDED.cur_time THEN 1 ELSE 0 END,
          cur_level = EXCLUDED.cur_level, cur_time = EXCLUDED.cur_time, updated_at = now()`;
      n++;
    } catch {}
  }
  return n;
}
export async function listRiverStations() {
  await ensureRiver();
  const sql = db();
  return sql`SELECT id,name,river,lng,lat,warn1,warn2,warn3,zero_elev,cur_level,cur_time,cnt_level,
             CASE WHEN cnt_level > 0 THEN sum_level / cnt_level ELSE NULL END AS avg_level
             FROM river_stations WHERE lng IS NOT NULL AND lat IS NOT NULL`;
}
export async function clearRiver() {
  await ensureRiver();
  const sql = db();
  await sql`DELETE FROM river_stations`;
}
export async function riverRaw() {
  await ensureRiver();
  const sql = db();
  const c = await sql`SELECT count(*)::int AS n, count(cur_level)::int AS with_level, count(lng)::int AS with_coord, max(cnt_level) AS max_cnt FROM river_stations`;
  return c[0];
}

// ---------- 中國軍事/灰色地帶 入侵紀錄(incursions) ----------
let _incReady = false;
async function ensureIncursions() {
  if (_incReady) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS incursions (
    id BIGSERIAL PRIMARY KEY,
    ev_date DATE NOT NULL,
    type TEXT NOT NULL,           -- air|sea|coastguard|cable|survey|drill
    zone TEXT,                    -- 西南空域|台海中線|北部|東部|金門|東沙|台澎...
    lng DOUBLE PRECISION, lat DOUBLE PRECISION,
    cnt INTEGER NOT NULL DEFAULT 1,   -- 架次/艘次/事件數
    detail TEXT, source TEXT, url TEXT,
    uniq TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS incursions_date ON incursions (ev_date)`;
  await sql`CREATE INDEX IF NOT EXISTS incursions_type ON incursions (type)`;
  _incReady = true;
}
export async function upsertIncursions(items) {
  await ensureIncursions();
  const sql = db();
  let n = 0;
  for (const it of items) {
    if (!it.ev_date || !it.type || !it.uniq) continue;
    try {
      await sql`INSERT INTO incursions (ev_date,type,zone,lng,lat,cnt,detail,source,url,uniq)
        VALUES (${it.ev_date},${it.type},${it.zone || null},${it.lng ?? null},${it.lat ?? null},${it.cnt ?? 1},${it.detail || null},${it.source || null},${it.url || null},${it.uniq})
        ON CONFLICT (uniq) DO UPDATE SET
          cnt = EXCLUDED.cnt, zone = EXCLUDED.zone, lng = EXCLUDED.lng, lat = EXCLUDED.lat,
          detail = EXCLUDED.detail, source = EXCLUDED.source, url = EXCLUDED.url`;
      n++;
    } catch {}
  }
  return n;
}
export async function listIncursions({ from = null, to = null } = {}) {
  await ensureIncursions();
  const sql = db();
  const f = from || "2020-09-01";
  const t = to || new Date().toISOString().slice(0, 10);
  return sql`SELECT ev_date,type,zone,lng,lat,cnt,detail,source,url FROM incursions
             WHERE ev_date >= ${f} AND ev_date <= ${t} ORDER BY ev_date ASC`;
}
export async function incursionsRaw() {
  await ensureIncursions();
  const sql = db();
  const c = await sql`SELECT count(*)::int AS n, count(DISTINCT type)::int AS types, min(ev_date) AS earliest, max(ev_date) AS latest, sum(cnt)::int AS total_cnt FROM incursions`;
  return c[0];
}
export async function clearIncursionsByType(type) {
  await ensureIncursions();
  const sql = db();
  await sql`DELETE FROM incursions WHERE type = ${type}`;
}
