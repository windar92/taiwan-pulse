// 抓取策展來源 → 分類 → 定位 → 寫入 events。由 /api/ingest（排程）呼叫。
import { createHash } from "node:crypto";
import { FEEDS } from "./feeds.js";
import { classify } from "./classify.js";
import { locate } from "./geo.js";
import { upsertEvents, pruneEvents } from "./db.js";

const TIMEOUT = 13000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, "Accept": "application/rss+xml,application/xml,application/json,text/html,*/*" } });
    if (!r.ok) throw new Error(`${r.status}`);
    let txt = await r.text();
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1); // 去 BOM（政府站常見）
    return txt;
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

// NCDR 災防告警（JSON，ATOM 的 JSON 表述）→ 依內容分類定位
async function handleNcdr(feed) {
  const txt = await fetchText(feed.url);
  let data; try { data = JSON.parse(txt); } catch { return []; }
  const arr = Array.isArray(data) ? data : (data.entry || data.feed?.entry || data.data || data.items || []);
  const out = [];
  for (const rec of (Array.isArray(arr) ? arr : [])) {
    const title = String(rec.title?.["#text"] || rec.title || rec.Title || "").trim();
    const summary = String(rec.summary?.["#text"] || rec.summary || rec.description || "").replace(/<[^>]+>/g, " ").trim();
    const cat = String(rec.category?.["@term"] || rec.category || "");
    const text = `${title} ${summary} ${cat}`;
    if (!title) continue;
    let cats = classify(text, feed.forceCats || []);
    if (!cats.length) cats = ["safety"]; // 災防告警至少歸公共安全
    const loc = locate(text, null);
    if (!loc) continue;
    const link = (typeof rec.link === "string" ? rec.link : (rec.link?.["@href"] || rec.link?.href || rec.id || "")) || "";
    const dt = rec.updated || rec.effective || rec.published;
    let pub = new Date(dt); if (Number.isNaN(pub.getTime())) pub = new Date();
    const hash = createHash("sha1").update(`${feed.id}|${rec.id || link || title}`).digest("hex");
    out.push({ hash, source: feed.id, source_name: feed.name, categories: cats.join(","),
      title: title.slice(0, 240), summary: summary.slice(0, 600), url: link,
      lng: loc.lng, lat: loc.lat, place: loc.place, county: loc.county, published_at: pub.toISOString() });
  }
  return out;
}

// 台水 停水資訊（JSON，含影響縣市/影響行政區欄位）→ 公共安全
async function handleWater(feed) {
  const txt = await fetchText(feed.url);
  let data; try { data = JSON.parse(txt); } catch { return []; }
  const arr = Array.isArray(data) ? data : (data.data || data.result?.records || data.records || []);
  const out = [];
  for (const rec of (Array.isArray(arr) ? arr : [])) {
    const blob = JSON.stringify(rec);
    const text = "停水 " + blob;
    const loc = locate(text, null);
    if (!loc) continue;
    // 取「地名類」欄位當標題（排除純數字，例如停水戶數）
    const pickText = (keys) => {
      for (const want of keys) for (const k of Object.keys(rec)) if (k.includes(want)) {
        const v = String(rec[k] ?? "").trim();
        if (v && !/^\d+(\.\d+)?$/.test(v)) return v;
      }
      return "";
    };
    const district = pickText(["影響行政區", "停水地區", "停水區域", "行政區", "村里", "路段", "地區"]);
    const reason = pickText(["停水原因", "原因", "說明", "備註"]);
    const when = pickText(["停水時間", "案件日期", "預計", "日期"]);
    const households = (() => { for (const k of Object.keys(rec)) if (k.includes("戶數")) return String(rec[k] ?? ""); return ""; })();
    const title = `停水通知：${(district || loc.place).slice(0, 40)}`;
    const summary = [reason, when, households && `影響約 ${households} 戶`].filter(Boolean).join("；").slice(0, 600) || "台水公司停水資訊，詳見原文。";
    const idKey = (() => { for (const k of Object.keys(rec)) if (k.includes("編號") || k.toLowerCase() === "id") return String(rec[k] ?? ""); return ""; })();
    const hash = createHash("sha1").update(`${feed.id}|${idKey || blob.slice(0, 80)}`).digest("hex");
    out.push({ hash, source: feed.id, source_name: feed.name, categories: "safety",
      title, summary, url: "https://web.water.gov.tw/wateroff", lng: loc.lng, lat: loc.lat,
      place: loc.place, county: loc.county, published_at: new Date().toISOString() });
  }
  return out;
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
      } else if (feed.type === "json-ncdr") {
        evs = await handleNcdr(feed);
      } else if (feed.type === "json-water") {
        evs = await handleWater(feed);
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
