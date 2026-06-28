// 抓取策展來源 → 分類 → 定位 → 寫入 events。由 /api/ingest（排程）呼叫。
import { createHash } from "node:crypto";
import { FEEDS } from "./feeds.js";
import { classify } from "./classify.js";
import { locate } from "./geo.js";
import { upsertEvents, pruneEvents } from "./db.js";

const TIMEOUT = 8000;

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "TaiwanPulse/0.1 (+map)" } });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function decode(s = "") {
  return s.replaceAll("<![CDATA[", "").replaceAll("]]>", "")
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'");
}
function strip(s = "") {
  let v = decode(s).replace(/<[^>]+>/g, " ");
  v = decode(v).replace(/<[^>]+>/g, " ");
  return v.replace(/\s+/g, " ").trim();
}
function between(s, a, b) {
  const i = s.indexOf(a); if (i === -1) return "";
  const j = s.indexOf(b, i + a.length); if (j === -1) return "";
  return s.slice(i + a.length, j);
}

function parseFeed(xml) {
  let blocks = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  let atom = false;
  if (!blocks.length) {
    blocks = [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
    atom = true;
  }
  return blocks.map((b) => {
    const title = strip(between(b, "<title>", "</title>"));
    let link = "";
    if (atom) {
      const m = b.match(/<link[^>]*href="([^"]+)"/);
      link = m ? m[1] : "";
    } else {
      link = strip(between(b, "<link>", "</link>"));
    }
    const date = between(b, "<pubDate>", "</pubDate>") || between(b, "<published>", "</published>") ||
      between(b, "<updated>", "</updated>") || between(b, "<dc:date>", "</dc:date>");
    const summary = strip(between(b, "<description>", "</description>") || between(b, "<summary>", "</summary>") || between(b, "<content>", "</content>"));
    return { title, link, date, summary };
  }).filter((x) => x.title);
}

function toEvent(feed, it) {
  const text = `${it.title} ${it.summary}`;
  const cats = classify(text, feed.forceCats || []);
  if (!cats.length) return null;
  const loc = locate(text, feed.county, { defense: cats.includes("defense"), title: it.title });
  if (!loc) return null;
  let pub = new Date(it.date);
  if (Number.isNaN(pub.getTime())) pub = new Date();
  const hash = createHash("sha1").update(`${feed.id}|${it.link || it.title}`).digest("hex");
  return {
    hash, source: feed.id, source_name: feed.name,
    categories: cats.join(","),
    title: it.title.slice(0, 240), summary: (it.summary || "").slice(0, 600),
    url: it.link || "", lng: loc.lng, lat: loc.lat, place: loc.place, county: loc.county,
    published_at: pub.toISOString(),
  };
}

async function handleLandslide(feed) {
  const txt = await fetchText(feed.url);
  let data;
  try { data = JSON.parse(txt); } catch { return []; }
  const arr = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  const out = [];
  for (const rec of arr) {
    const text = "土石流大規模崩塌警戒 " + JSON.stringify(rec);
    const loc = locate(text, null);
    if (!loc) continue;
    const hash = createHash("sha1").update(`${feed.id}|${loc.place}|${JSON.stringify(rec).slice(0, 80)}`).digest("hex");
    out.push({
      hash, source: feed.id, source_name: feed.name, categories: "disaster",
      title: `土石流/崩塌警戒：${loc.place}`, summary: "水保署即時警戒，請注意疏散與避難資訊。",
      url: "https://246.ardswc.gov.tw/", lng: loc.lng, lat: loc.lat, place: loc.place, county: loc.county,
      published_at: new Date().toISOString(),
    });
  }
  return out;
}

export async function runIngest() {
  const events = [];
  const perFeed = {};
  await Promise.all(FEEDS.map(async (feed) => {
    try {
      let evs = [];
      if (feed.type === "json-landslide") {
        evs = await handleLandslide(feed);
      } else {
        const xml = await fetchText(feed.url);
        const items = parseFeed(xml).slice(0, 40);
        evs = items.map((it) => toEvent(feed, it)).filter(Boolean);
      }
      perFeed[feed.id] = evs.length;
      events.push(...evs);
    } catch (e) {
      perFeed[feed.id] = `err:${e.message}`;
    }
  }));
  // 去重（同 hash）
  const seen = new Set();
  const dedup = events.filter((e) => (seen.has(e.hash) ? false : (seen.add(e.hash), true)));
  const inserted = await upsertEvents(dedup);
  await pruneEvents(30).catch(() => {});
  return { scanned: events.length, unique: dedup.length, inserted, perFeed };
}
