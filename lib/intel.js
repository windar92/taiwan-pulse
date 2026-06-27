// 共用情報邏輯：本地 server.js 與 Vercel api/profile.js 共用此模組，避免程式碼分歧。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";

const root = process.cwd();
const graphVersion = process.env.META_GRAPH_VERSION || "v21.0";
const fetchTimeoutMs = 6500;

loadDotEnv();

const eventTerms = ["事故", "車禍", "火災", "停電", "停水", "抗議", "犯罪", "工程", "交通", "爭議", "公衛", "陳抗", "遊行"];
const disasterTerms = ["災情", "地震", "颱風", "淹水", "土石流", "山難", "爆炸", "火災", "停電", "停水", "物資", "捐款", "血庫", "避難", "戰爭", "空襲", "衝突"];
const activityTerms = ["活動", "展覽", "音樂會", "市集", "演唱會", "講座", "親子", "藝文", "表演", "戲劇", "電影"];
const mediaTerms = ["新聞", "日報", "時報", "週刊", "電視", "廣播", "報導", "民視", "公視", "華視", "台視", "中視", "東森", "三立", "年代", "非凡", "中天", "鏡週刊", "信傳媒", "風傳媒", "上報", "報導者", "中央社", "聯合", "自由", "蘋果", "太報", "民報", "新頭殼", "關鍵評論", "Yahoo", "LINE TODAY", "ETtoday", "TVBS", "NOWnews", "PChome", "MSN", "PeoPo", "CNEWS", "Newtalk", "The News Lens"];
const governmentTerms = ["政府", "公告", "警示", "新聞稿", "市府", "縣府", "區公所", "鄉公所", "鎮公所", "部", "署", "局", "處", "中心", "氣象署", "消防", "警察", "衛生局", "交通局", "停水", "停電"];
const socialTerms = ["IG", "Instagram", "FB", "Facebook", "Threads", "Twitter", "x.com", "噗浪", "Plurk", "開幕", "新開幕", "好吃", "推薦", "打卡", "菜單", "排隊", "小吃", "餐廳", "咖啡", "甜點", "分享", "貼文", "限動", "社群"];
const socialPlatforms = ["Instagram", "Facebook", "Threads", "Twitter", "x.com", "Plurk", "噗浪"];
const socialKeywords = ["Instagram", "Facebook", "Threads", "Twitter", "x.com", "噗浪", "Plurk", "新開幕", "好吃", "推薦", "打卡", "餐廳", "咖啡", "甜點"];

function loadDotEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

// --- 簡易記憶體快取（warm instance 內有效，降低重複外部請求與逾時/被擋風險）---
const _cache = new Map();
function cacheGet(key) {
  const hit = _cache.get(key);
  if (hit && Date.now() < hit.exp) return hit.val;
  if (hit) _cache.delete(key);
  return undefined;
}
function cacheSet(key, val, ttlMs) {
  _cache.set(key, { val, exp: Date.now() + ttlMs });
  if (_cache.size > 500) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  return val;
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function decodeXml(value = "") {
  return value.replaceAll("<![CDATA[", "").replaceAll("]]>", "").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'");
}

function textBetween(value, start, end) {
  const from = value.indexOf(start);
  if (from === -1) return "";
  const to = value.indexOf(end, from + start.length);
  if (to === -1) return "";
  return value.slice(from + start.length, to);
}

function stripTags(value = "") {
  // 先解碼實體（把 &lt;a&gt; 還原成 <a>），再去標籤，重複一次以清掉巢狀編碼，
  // 避免 Google News description 的原始 <a href> 漏到畫面上。
  let v = decodeXml(value);
  v = v.replace(/<[^>]+>/g, " ");
  v = decodeXml(v);
  v = v.replace(/<[^>]+>/g, " ");
  return v.replace(/\s+/g, " ").trim();
}

function parseRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => {
    const item = match[1];
    const source = stripTags(textBetween(item, "<source", "</source>")).replace(/^.*?>/, "") || "Google News";
    return {
      title: decodeXml(textBetween(item, "<title>", "</title>")).trim(),
      link: decodeXml(textBetween(item, "<link>", "</link>")).trim(),
      pubDate: decodeXml(textBetween(item, "<pubDate>", "</pubDate>")).trim(),
      source,
      summary: stripTags(textBetween(item, "<description>", "</description>")) || "來源未提供摘要。",
    };
  }).filter((item) => item.title && item.link);
}

function timeWindow(timeLabel) {
  const numericDays = Number(String(timeLabel || "").match(/\d+/)?.[0]);
  const days = Number.isFinite(numericDays) && numericDays > 0 ? Math.min(365, Math.max(1, Math.round(numericDays))) : 1;
  return { days, googleWhen: `${days}d`, since: new Date(Date.now() - days * 86400000) };
}

function filterByTime(items, timeLabel, field = "pubDate") {
  const { since } = timeWindow(timeLabel);
  return items.filter((item) => {
    const date = new Date(item[field]);
    return !Number.isNaN(date.getTime()) && date >= since;
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error?.message || body.title || `${response.status} ${response.statusText}`);
  return body;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = fetchTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocode(lat, lng) {
  const cacheKey = `geo:${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", lat);
  url.searchParams.set("lon", lng);
  url.searchParams.set("accept-language", "zh-TW");
  url.searchParams.set("zoom", "14");
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": "TaiwanLocalIntelMap/0.6" } });
  if (!response.ok) return { locality: "台灣", displayName: "台灣", lat: Number(lat), lng: Number(lng) };
  const data = await response.json();
  const a = data.address || {};
  const city = a.city || a.county || a.state || "";
  const district = a.town || a.city_district || a.suburb || a.village || "";
  const locality = [city, district].filter(Boolean).join(" ");
  const result = { locality: locality || data.name || "台灣", displayName: data.display_name || locality || "台灣", lat: Number(lat), lng: Number(lng), city, district, name: data.name || "" };
  return cacheSet(cacheKey, result, 3600000); // 地名反查穩定，快取 1 小時
}

async function googleNews(query, timeLabel, limit = 12) {
  const { googleWhen } = timeWindow(timeLabel);
  const cacheKey = `gn:${query}|${googleWhen}|${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", `${query} when:${googleWhen}`);
  url.searchParams.set("hl", "zh-TW");
  url.searchParams.set("gl", "TW");
  url.searchParams.set("ceid", "TW:zh-Hant");
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0 TaiwanLocalIntelMap/0.6" } });
  if (!response.ok) throw new Error(`Google News ${response.status}`);
  const items = filterByTime(parseRss(await response.text()), timeLabel).slice(0, limit);
  return cacheSet(cacheKey, items, 180000); // 新聞快取 3 分鐘
}

async function safeGoogleNews(label, query, timeLabel, limit = 12) {
  try {
    const items = await googleNews(query, timeLabel, limit);
    return { items, status: { name: label, configured: true, count: items.length, status: "ok", error: "" } };
  } catch (error) {
    return { items: [], status: { name: label, configured: true, count: 0, status: "error", error: error.message } };
  }
}

async function safeGoogleNewsMany(label, queries, timeLabel, perQueryLimit = 12) {
  const results = await Promise.all(queries.map((query) => safeGoogleNews(label, query, timeLabel, perQueryLimit)));
  const items = dedupeItems(results.flatMap((result) => result.items));
  const failed = results.filter((result) => result.status.status !== "ok");
  return {
    items,
    status: {
      name: label,
      configured: true,
      count: items.length,
      status: failed.length === results.length ? "error" : "ok",
      error: failed.length ? `${failed.length}/${results.length} queries failed: ${failed.map((result) => result.status.error).filter(Boolean).slice(0, 2).join("; ")}` : "",
      queries,
    },
  };
}

async function safeCultureActivities(place, timeLabel, limit = 12) {
  try {
    const items = await cultureActivities(place, timeLabel, limit);
    return { items, status: { name: "文化部 iCulture", configured: true, count: items.length, status: "ok", error: "" } };
  } catch (error) {
    return { items: [], status: { name: "文化部 iCulture", configured: true, count: 0, status: "error", error: error.message } };
  }
}

function tagsFor(item, terms) {
  const text = `${item.title || ""} ${item.summary || ""} ${item.source || ""}`;
  return terms.filter((term) => {
    const lower = text.toLowerCase();
    const token = term.toLowerCase();
    if (/^[a-z0-9.]+$/.test(token) && token.length <= 3) {
      return new RegExp(`(^|[^a-z0-9.])${token.replace(".", "\\.")}([^a-z0-9.]|$)`, "i").test(text);
    }
    return lower.includes(token);
  });
}

function classify(items, terms) {
  return items.map((item) => ({ ...item, tags: tagsFor(item, terms) })).filter((item) => item.tags.length);
}

function textOf(item) {
  return `${item.title || ""} ${item.summary || ""} ${item.source || ""} ${item.link || ""}`;
}

function isGovernmentItem(item) {
  const text = textOf(item).toLowerCase();
  return text.includes(".gov.tw") || text.includes("gov.taipei") || text.includes("gov.tw") || governmentTerms.some((term) => textOf(item).includes(term));
}

function isNewsMediaItem(item) {
  if (isGovernmentItem(item)) return false;
  const text = textOf(item);
  return mediaTerms.some((term) => text.toLowerCase().includes(term.toLowerCase()));
}

function locationTerms(place) {
  const displayParts = String(place.displayName || "").split(/[,\s，、｜|]+/).map((part) => part.trim()).filter((part) => part.length >= 2);
  return [...new Set([
    place.locality,
    place.city,
    place.district,
    place.name,
    ...String(place.locality || "").split(/\s+/),
    ...displayParts.slice(0, 10),
  ].filter((term) => term && term !== "台灣"))];
}

function placeQueryParts(place) {
  const city = place.city || "";
  const district = place.district || "";
  const locality = place.locality || "";
  return {
    city,
    district,
    locality,
    local: locality || [city, district].filter(Boolean).join(" "),
    cityOnly: city || locality,
  };
}

function buildNewsQueries(place, topic) {
  const parts = placeQueryParts(place);
  const cleanTopic = topic || "地方新聞";
  return [...new Set([
    `${parts.local} ${cleanTopic}`,
    parts.district ? `${parts.district} ${cleanTopic}` : "",
    parts.cityOnly ? `${parts.cityOnly} ${cleanTopic}` : "",
    parts.cityOnly && cleanTopic !== "地方新聞" ? `${parts.cityOnly} ${cleanTopic}` : "",
    cleanTopic !== "地方新聞" ? `台灣 ${cleanTopic}` : "",
  ].filter(Boolean))].slice(0, 3);
}

function buildNationwideNewsQueries(topic) {
  const cleanTopic = topic || "地方新聞";
  return [...new Set([
    `台灣 ${cleanTopic}`,
    cleanTopic,
    `全國 ${cleanTopic}`,
  ].filter(Boolean))].slice(0, 2);
}

function buildActivityQueries(place) {
  const parts = placeQueryParts(place);
  return [...new Set([
    `${parts.local} 活動 OR 展覽 OR 音樂會 OR 市集 OR 藝文`,
    parts.district ? `${parts.district} 活動 OR 展覽 OR 市集` : "",
    parts.cityOnly ? `${parts.cityOnly} 活動 OR 展覽 OR 音樂會 OR 市集` : "",
  ].filter(Boolean))].slice(0, 3);
}

function buildNationwideActivityQueries() {
  return [
    `台灣 活動 OR 展覽 OR 音樂會 OR 市集 OR 藝文`,
    `全台 活動 OR 展覽 OR 演唱會 OR 市集`,
  ];
}

function buildGovernmentQueries(place) {
  const parts = placeQueryParts(place);
  return [...new Set([
    `${parts.local} 政府 OR 公告 OR 警示 OR 市府 OR 區公所 OR 消防局 OR 警察局 OR 衛生局 OR 交通局`,
    parts.cityOnly ? `${parts.cityOnly} 政府 OR 公告 OR 警示 OR 氣象署 OR 停水 OR 停電` : "",
  ].filter(Boolean))].slice(0, 1);
}

function buildNationwideGovernmentQueries() {
  return [
    `台灣 政府 OR 公告 OR 警示 OR 氣象署 OR 停水 OR 停電`,
    `全國 政府 OR 公告 OR 警示`,
  ];
}

function buildDisasterQueries(place) {
  const parts = placeQueryParts(place);
  return [...new Set([
    `${parts.local} 災情 OR 地震 OR 淹水 OR 火災 OR 停電 OR 停水 OR 捐款 OR 血庫 OR 避難 OR 戰爭`,
    parts.cityOnly ? `${parts.cityOnly} 災情 OR 地震 OR 淹水 OR 火災 OR 停電 OR 停水` : "",
  ].filter(Boolean))].slice(0, 1);
}

function buildNationwideDisasterQueries() {
  return [
    `台灣 災情 OR 地震 OR 淹水 OR 火災 OR 停電 OR 停水 OR 血庫 OR 戰爭`,
    `全國 災情 OR 地震 OR 颱風 OR 戰爭`,
  ];
}

function buildSocialQueries(place) {
  const parts = placeQueryParts(place);
  return [...new Set([
    `${parts.local} ${socialKeywords.join(" OR ")}`,
    parts.district ? `${parts.district} ${socialKeywords.join(" OR ")}` : "",
    parts.cityOnly ? `${parts.cityOnly} ${socialKeywords.join(" OR ")}` : "",
  ].filter(Boolean))].slice(0, 1);
}

function buildNationwideSocialQueries() {
  return [
    `台灣 ${socialKeywords.join(" OR ")}`,
    `全台 ${socialKeywords.join(" OR ")}`,
  ];
}

function hasLocationSignal(item, place) {
  const text = textOf(item);
  return locationTerms(place).some((term) => text.includes(term));
}

function asSocialItems(items, place, defaultSource = "公開社群索引") {
  return items.map((item) => {
    const tags = [...new Set([...tagsFor(item, socialTerms), ...tagsFor(item, socialPlatforms)])].map((tag) => tag === "Twitter" || tag === "x.com" ? "X" : tag);
    return {
      ...item,
      source: item.source || defaultSource,
      summary: item.summary || `${place.locality} 的公開社群訊號。`,
      tags: tags.length ? tags : ["社群", "生活"],
    };
  });
}

function providerStatus(name, configured, count = 0, error = "") {
  return { name, configured, count, status: configured ? (error ? "error" : "ok") : "missing_credentials", error };
}

function compactHashtags(place) {
  const parts = (place.locality || "").split(/\s+/).filter(Boolean);
  const city = parts[0] || "台灣";
  const district = parts[1] || "";
  return [...new Set([
    `${city}美食`,
    district ? `${district}美食` : "",
    district ? `${district}新開幕` : "",
    `${city}咖啡`,
  ].filter(Boolean).map((tag) => tag.replace(/[^\p{L}\p{N}_]/gu, "")))].slice(0, 4);
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.link || item.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function itemTimestamp(item) {
  const date = new Date(item.pubDate || item.time || item.createdAt || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function sortByTimeDesc(items) {
  return [...items].sort((a, b) => itemTimestamp(b) - itemTimestamp(a));
}

async function xRecentSearch(place, timeLabel) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return { items: [], status: providerStatus("X", false) };
  try {
    const base = place.locality || "台灣";
    const query = `("${base}") (${socialKeywords.join(" OR ")}) lang:zh -is:retweet`;
    const url = new URL("https://api.x.com/2/tweets/search/recent");
    url.searchParams.set("query", query);
    url.searchParams.set("max_results", "10");
    url.searchParams.set("tweet.fields", "created_at,author_id,public_metrics,lang");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username,name");
    const data = await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
    const users = new Map((data.includes?.users || []).map((user) => [user.id, user]));
    const items = filterByTime((data.data || []).map((tweet) => {
      const user = users.get(tweet.author_id) || {};
      return {
        title: tweet.text.slice(0, 80),
        link: user.username ? `https://x.com/${user.username}/status/${tweet.id}` : `https://x.com/i/web/status/${tweet.id}`,
        pubDate: tweet.created_at,
        source: "X",
        summary: tweet.text,
        tags: ["X", "社群"],
      };
    }), timeLabel);
    return { items, status: providerStatus("X", true, items.length) };
  } catch (error) {
    return { items: [], status: providerStatus("X", true, 0, error.message) };
  }
}

async function instagramHashtags(place, timeLabel) {
  const token = process.env.META_ACCESS_TOKEN;
  const userId = process.env.IG_USER_ID;
  if (!token || !userId) return { items: [], status: providerStatus("Instagram Graph", false) };
  const items = [];
  try {
    for (const tag of compactHashtags(place)) {
      const search = new URL(`https://graph.facebook.com/${graphVersion}/ig_hashtag_search`);
      search.searchParams.set("user_id", userId);
      search.searchParams.set("q", tag);
      search.searchParams.set("access_token", token);
      const hashtag = (await fetchJson(search)).data?.[0];
      if (!hashtag?.id) continue;
      const mediaUrl = new URL(`https://graph.facebook.com/${graphVersion}/${hashtag.id}/recent_media`);
      mediaUrl.searchParams.set("user_id", userId);
      mediaUrl.searchParams.set("fields", "id,caption,media_type,permalink,timestamp,username");
      mediaUrl.searchParams.set("limit", "5");
      mediaUrl.searchParams.set("access_token", token);
      const media = await fetchJson(mediaUrl);
      for (const post of media.data || []) {
        items.push({
          title: (post.caption || `#${tag}`).slice(0, 80),
          link: post.permalink,
          pubDate: post.timestamp,
          source: "Instagram",
          summary: post.caption || `#${tag}`,
          tags: ["Instagram", `#${tag}`],
        });
      }
    }
    const filtered = filterByTime(items, timeLabel);
    return { items: filtered, status: providerStatus("Instagram Graph", true, filtered.length) };
  } catch (error) {
    return { items: [], status: providerStatus("Instagram Graph", true, 0, error.message) };
  }
}

async function facebookPages(place, timeLabel) {
  const token = process.env.META_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageIds = (process.env.FACEBOOK_PAGE_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!token || !pageIds.length) return { items: [], status: providerStatus("Facebook Pages", false) };
  const items = [];
  try {
    for (const pageId of pageIds) {
      const url = new URL(`https://graph.facebook.com/${graphVersion}/${pageId}/posts`);
      url.searchParams.set("fields", "id,message,permalink_url,created_time,from");
      url.searchParams.set("limit", "10");
      url.searchParams.set("access_token", token);
      const data = await fetchJson(url);
      for (const post of data.data || []) {
        const text = post.message || "";
        if (!text.includes(place.locality) && !socialTerms.some((term) => text.toLowerCase().includes(term.toLowerCase()))) continue;
        items.push({ title: text.slice(0, 80) || post.from?.name || "Facebook post", link: post.permalink_url, pubDate: post.created_time, source: "Facebook", summary: text, tags: ["Facebook", "社群"] });
      }
    }
    const filtered = filterByTime(items, timeLabel);
    return { items: filtered, status: providerStatus("Facebook Pages", true, filtered.length) };
  } catch (error) {
    return { items: [], status: providerStatus("Facebook Pages", true, 0, error.message) };
  }
}

async function threadsUserPosts(place, timeLabel) {
  const token = process.env.THREADS_ACCESS_TOKEN;
  const userId = process.env.THREADS_USER_ID || "me";
  if (!token) return { items: [], status: providerStatus("Threads", false) };
  try {
    const url = new URL(`https://graph.threads.net/v1.0/${userId}/threads`);
    url.searchParams.set("fields", "id,text,permalink,timestamp,username");
    url.searchParams.set("limit", "20");
    url.searchParams.set("access_token", token);
    const data = await fetchJson(url);
    const items = filterByTime((data.data || []).map((post) => ({
      title: (post.text || "Threads post").slice(0, 80),
      link: post.permalink,
      pubDate: post.timestamp,
      source: "Threads",
      summary: post.text || "",
      tags: ["Threads", "社群"],
    })).filter((post) => post.summary.includes(place.locality) || socialTerms.some((term) => post.summary.toLowerCase().includes(term.toLowerCase()))), timeLabel);
    return { items, status: providerStatus("Threads", true, items.length) };
  } catch (error) {
    return { items: [], status: providerStatus("Threads", true, 0, error.message) };
  }
}

function oauthHeader(method, endpoint, params) {
  const key = encodeURIComponent(process.env.PLURK_CONSUMER_SECRET || "") + "&" + encodeURIComponent(process.env.PLURK_TOKEN_SECRET || "");
  const baseParams = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const base = [method.toUpperCase(), encodeURIComponent(endpoint), encodeURIComponent(baseParams)].join("&");
  const signature = createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + Object.entries({ ...params, oauth_signature: signature }).filter(([keyName]) => keyName.startsWith("oauth_")).map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`).join(", ");
}

async function plurkSearch(place, timeLabel) {
  const configured = process.env.PLURK_CONSUMER_KEY && process.env.PLURK_CONSUMER_SECRET && process.env.PLURK_TOKEN && process.env.PLURK_TOKEN_SECRET;
  if (!configured) return { items: [], status: providerStatus("Plurk", false) };
  try {
    const endpoint = "https://www.plurk.com/APP/PlurkSearch/search";
    const query = place.locality || "台灣";
    const params = {
      query,
      oauth_consumer_key: process.env.PLURK_CONSUMER_KEY,
      oauth_nonce: randomBytes(12).toString("hex"),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: process.env.PLURK_TOKEN,
      oauth_version: "1.0",
    };
    const url = new URL(endpoint);
    url.searchParams.set("query", query);
    const data = await fetchJson(url, { headers: { Authorization: oauthHeader("GET", endpoint, params) } });
    const items = filterByTime((data.plurks || []).map((post) => ({
      title: stripTags(post.content_raw || post.content || "Plurk").slice(0, 80),
      link: post.plurk_id ? `https://www.plurk.com/p/${Number(post.plurk_id).toString(36)}` : "",
      pubDate: post.posted,
      source: "Plurk",
      summary: stripTags(post.content_raw || post.content || ""),
      tags: ["Plurk", "噗浪"],
    })), timeLabel);
    return { items, status: providerStatus("Plurk", true, items.length) };
  } catch (error) {
    return { items: [], status: providerStatus("Plurk", true, 0, error.message) };
  }
}

async function authorizedSocial(place, timeLabel) {
  const providers = await Promise.all([
    xRecentSearch(place, timeLabel),
    instagramHashtags(place, timeLabel),
    facebookPages(place, timeLabel),
    threadsUserPosts(place, timeLabel),
    plurkSearch(place, timeLabel),
  ]);
  return {
    items: dedupeItems(providers.flatMap((provider) => provider.items)),
    statuses: providers.map((provider) => provider.status),
  };
}

async function cultureRawData() {
  const cached = cacheGet("culture:all");
  if (cached) return cached;
  const url = "https://cloud.culture.tw/frontsite/trans/SearchShowAction.do?method=doFindTypeJ&category=all";
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": "TaiwanLocalIntelMap/0.6" } });
  if (!response.ok) return [];
  const data = await response.json();
  return cacheSet("culture:all", data, 600000); // 全國活動資料每次都一樣，快取 10 分鐘
}

async function cultureActivities(place, timeLabel, limit = 12) {
  const data = await cultureRawData();
  if (!Array.isArray(data) || !data.length) return [];
  const city = place.city || place.locality?.split(" ")[0] || "";
  const rows = [];
  for (const event of data) {
    for (const show of event.showInfo || []) {
      const locationText = `${show.location || ""} ${show.locationName || ""}`;
      const time = show.time || event.startDate || event.endDate;
      if (city && !locationText.includes(city)) continue;
      rows.push({ title: event.title, link: event.webSales || event.sourceWebPromote || event.comment || "", pubDate: time, time, source: "文化部 iCulture", summary: `${show.locationName || "地點未標示"}｜${show.location || ""}`, tags: ["活動", "藝文"] });
    }
  }
  return filterByTime(rows, timeLabel, "time").slice(0, limit);
}

function distanceKm(a, b) {
  const rad = (n) => (n * Math.PI) / 180;
  const r = 6371;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function earthquakes(lat, lng, timeLabel) {
  const { since } = timeWindow(timeLabel);
  const url = new URL("https://earthquake.usgs.gov/fdsnws/event/1/query");
  url.searchParams.set("format", "geojson");
  url.searchParams.set("starttime", since.toISOString().slice(0, 10));
  url.searchParams.set("minlatitude", "20");
  url.searchParams.set("maxlatitude", "27");
  url.searchParams.set("minlongitude", "118");
  url.searchParams.set("maxlongitude", "124");
  url.searchParams.set("minmagnitude", "2.5");
  url.searchParams.set("orderby", "time");
  url.searchParams.set("limit", "20");
  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];
  const data = await response.json();
  return (data.features || []).map((feature) => {
    const [quakeLng, quakeLat, depthKm] = feature.geometry.coordinates;
    return { place: feature.properties.place, mag: feature.properties.mag, time: new Date(feature.properties.time).toISOString(), url: feature.properties.url, depthKm, lat: quakeLat, lng: quakeLng, distanceKm: distanceKm({ lat: Number(lat), lng: Number(lng) }, { lat: quakeLat, lng: quakeLng }).toFixed(1) };
  });
}

export async function handleProfile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const lat = Number(url.searchParams.get("lat") || 25.0401);
  const lng = Number(url.searchParams.get("lng") || 121.5119);
  const topic = url.searchParams.get("topic") || "地方新聞";
  const radius = url.searchParams.get("radius") || "500m";
  const isNationwide = radius === "全國" || radius.toLowerCase() === "nationwide";
  const time = url.searchParams.get("time") || "今天";
  try {
    const place = isNationwide
      ? { locality: "全國", displayName: "台灣全國", lat, lng, city: "台灣", district: "全國", name: "全國" }
      : await reverseGeocode(lat, lng).catch(() => ({ locality: "台灣", displayName: "地名反查暫時失敗", lat, lng, city: "" }));
    const newsQueries = isNationwide ? buildNationwideNewsQueries(topic) : buildNewsQueries(place, topic);
    const activityQueries = isNationwide ? buildNationwideActivityQueries() : buildActivityQueries(place);
    const governmentQueries = isNationwide ? buildNationwideGovernmentQueries() : buildGovernmentQueries(place);
    const socialQueries = isNationwide ? buildNationwideSocialQueries() : buildSocialQueries(place);
    const disasterQueries = isNationwide ? buildNationwideDisasterQueries() : buildDisasterQueries(place);
    const [newsResult, activityResult, cultureResult, governmentResult, socialResult, disasterResult, quakeList, officialSocial] = await Promise.all([
      safeGoogleNewsMany("Google News: 新聞", newsQueries, time, 14),
      safeGoogleNewsMany("Google News: 活動", activityQueries, time, 8),
      safeCultureActivities(place, time, 12),
      safeGoogleNewsMany("Google News: 政府", governmentQueries, time, 12),
      safeGoogleNewsMany("Google News: 社群索引", socialQueries, time, 10),
      safeGoogleNewsMany("Google News: 災害", disasterQueries, time, 10),
      earthquakes(lat, lng, time).catch(() => []),
      authorizedSocial(place, time),
    ]);
    const mediaNews = sortByTimeDesc(newsResult.items.filter(isNewsMediaItem));
    const news = (isNationwide ? mediaNews : mediaNews.filter((item) => hasLocationSignal(item, place))).slice(0, 14);
    const nationalNews = isNationwide ? [] : mediaNews.filter((item) => !hasLocationSignal(item, place)).slice(0, 14);
    const activityNews = activityResult.items;
    const culture = cultureResult.items;
    const government = sortByTimeDesc(dedupeItems([...governmentResult.items, ...newsResult.items.filter(isGovernmentItem), ...disasterResult.items.filter(isGovernmentItem)])).slice(0, 14);
    const socialNews = socialResult.items;
    const disasterNews = disasterResult.items;
    const activities = sortByTimeDesc([...culture, ...classify(activityNews, activityTerms)]).slice(0, 14);
    const indexedSocial = asSocialItems(socialNews, place, "公開索引");
    const pulse = sortByTimeDesc(dedupeItems([...officialSocial.items, ...indexedSocial])).slice(0, 18);
    const disasters = sortByTimeDesc(classify(disasterNews, disasterTerms)).slice(0, 8);
    send(res, 200, JSON.stringify({
      ok: true,
      fetchedAt: new Date().toISOString(),
      place,
      filters: { radius, time, topic },
      queries: {
        news: newsQueries.map((query) => `${query} when:${timeWindow(time).googleWhen}`).join(" | "),
        government: governmentQueries.map((query) => `${query} when:${timeWindow(time).googleWhen}`).join(" | "),
        activities: `${activityQueries.map((query) => `${query} when:${timeWindow(time).googleWhen}`).join(" | ")} + 文化部 iCulture`,
        social: socialQueries.map((query) => `${query} when:${timeWindow(time).googleWhen}`).join(" | "),
        disasters: disasterQueries.map((query) => `${query} when:${timeWindow(time).googleWhen}`).join(" | "),
      },
      sourceStatus: [newsResult.status, activityResult.status, cultureResult.status, governmentResult.status, socialResult.status, disasterResult.status],
      socialProviders: officialSocial.statuses,
      news,
      nationalNews,
      government,
      activities,
      pulse,
      disasters,
      earthquakes: sortByTimeDesc(quakeList),
    }), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, s-maxage=180, stale-while-revalidate=600" });
  } catch (error) {
    send(res, 502, JSON.stringify({ ok: false, error: error.message }), { "Content-Type": "application/json; charset=utf-8" });
  }
}
