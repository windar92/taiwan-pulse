import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { TextLayer } from "@deck.gl/layers";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;
const HOME_KEY = "tp-home";
const DEFAULT_HOME = { lng: 120.95, lat: 23.8, zoom: 7.3 };
const COUNTY_GEOJSON = "https://raw.githubusercontent.com/g0v/twgeojson/master/json/twCounty2010.geo.json";
const RAIN_H = 700; // 雨量水柱示意高度倍率(柱高與標號高度共用)
const QUAKE_H = 2500; // 地震震度柱示意高度倍率(每級)

type Cat = "disaster" | "safety" | "warning" | "defense" | "policy" | "ecology" | "activity" | "report";
const CATS: { id: Cat; label: string; color: string }[] = [
  { id: "disaster", label: "自然災害", color: "#ef5350" },
  { id: "safety", label: "公共安全", color: "#ff8a65" },
  { id: "warning", label: "警戒管制", color: "#ffd54f" },
  { id: "defense", label: "國防軍事", color: "#9fa8da" },
  { id: "policy", label: "政策民生", color: "#4fc3f7" },
  { id: "ecology", label: "生態", color: "#81c784" },
  { id: "activity", label: "活動", color: "#ba68c8" },
  { id: "report", label: "回報牆", color: "#26c6da" },
];
const PRIORITY: Cat[] = ["disaster", "safety", "warning", "defense", "policy", "ecology", "activity"];
const COLOR: Record<string, string> = Object.fromEntries(CATS.map((c) => [c.id, c.color]));
const LABEL: Record<string, string> = Object.fromEntries(CATS.map((c) => [c.id, c.label]));
const REPORT_OPTIONS = ["地點錯誤（釘錯位置）", "分類錯誤", "與主題無關（不該顯示）", "內容或標題有誤", "重複內容", "已過期或失效", "連結打不開", "其他"];

function loadHome() {
  try { const v = JSON.parse(localStorage.getItem(HOME_KEY) || "null"); if (v && typeof v.lng === "number") return v; } catch {}
  return DEFAULT_HOME;
}
const norm = (s: string) => (s || "").replace(/台/g, "臺");

type Sel = { hash: string; title: string; summary: string; url: string; county: string; cats: string; source: string };

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const countyKeyRef = useRef<string>("COUNTYNAME");
  const hoverRef = useRef<mapboxgl.Popup | null>(null);
  const [visible, setVisible] = useState<Set<Cat>>(new Set(CATS.map((c) => c.id)));
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [showMemo, setShowMemo] = useState(false);
  const [memoSaved, setMemoSaved] = useState(false);
  const [basemap, setBasemap] = useState<"dark" | "topo" | "sat">("dark");
  const [sel, setSel] = useState<Sel | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState(false);
  const [optOrder, setOptOrder] = useState<string[]>(REPORT_OPTIONS);
  const [terrainBlocked, setTerrainBlocked] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [rainOn, setRainOn] = useState(false);
  const [rainInfo, setRainInfo] = useState<string>("");
  const [quakeOn, setQuakeOn] = useState(false);
  const [quakeInfo, setQuakeInfo] = useState<string>("");
  const rippleRef = useRef<number | null>(null);
  const quakePopRef = useRef<mapboxgl.Popup | null>(null);
  const deckRef = useRef<any>(null);
  const deckLayersRef = useRef<Record<string, any[]>>({});

  const refreshOrder = () =>
    fetch("/api/feedback").then((r) => r.json()).then((d) => {
      if (d?.ok) { const s = d.stats || {}; setOptOrder([...REPORT_OPTIONS].sort((a, b) => (s[b] || 0) - (s[a] || 0))); }
    }).catch(() => {});

  useEffect(() => { refreshOrder(); }, []);

  // 偵測瀏覽器是否開了防指紋/隱私防護（會汙染 Canvas2D 讀回，導致 Mapbox 關掉 3D 地形）
  useEffect(() => {
    try {
      const c = document.createElement("canvas"); c.width = 6; c.height = 6;
      const ctx = c.getContext("2d", { willReadFrequently: true } as any);
      if (!ctx) { setTerrainBlocked(true); return; }
      ctx.fillStyle = "rgb(11,22,33)"; ctx.fillRect(0, 0, 6, 6);
      const px = ctx.getImageData(0, 0, 6, 6).data;
      let poisoned = false;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] !== 11 || px[i + 1] !== 22 || px[i + 2] !== 33) { poisoned = true; break; }
      }
      if (poisoned) setTerrainBlocked(true);
    } catch { setTerrainBlocked(true); }
  }, []);

  useEffect(() => {
    if (!containerRef.current || !TOKEN) return;
    const home = loadHome();
    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current, style: "mapbox://styles/mapbox/dark-v11",
      projection: { name: "mercator" }, center: [home.lng, home.lat], zoom: home.zoom || 7.3,
      pitch: home.pitch ?? 60, bearing: home.bearing ?? 0, maxPitch: 85,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    hoverRef.current = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "hover-tip" });

    map.on("style.load", async () => {
      // 地名中文化：把所有文字圖層改成繁體中文，抓不到中文名者 fallback 原名
      try {
        for (const ly of (map.getStyle().layers || [])) {
          if (ly.type === "symbol" && (ly as any).layout && (ly as any).layout["text-field"]) {
            map.setLayoutProperty(ly.id, "text-field", ["coalesce", ["get", "name_zh-Hant"], ["get", "name_zh-Hans"], ["get", "name_zh"], ["get", "name"]]);
          }
        }
      } catch {}

      // 真實地形：台灣本島＋離島的實際高度，做出等比例微縮模型的立體感
      try {
        if (!map.getSource("mapbox-dem")) {
          map.addSource("mapbox-dem", { type: "raster-dem", url: "mapbox://mapbox.mapbox-terrain-dem-v1", tileSize: 512, maxzoom: 14 });
        }
        map.setTerrain({ source: "mapbox-dem", exaggeration: 1.0 });
        if (!map.getLayer("sky")) {
          map.addLayer({ id: "sky", type: "sky", paint: { "sky-type": "atmosphere", "sky-atmosphere-sun": [0.0, 88.0], "sky-atmosphere-sun-intensity": 8 } });
        }
        map.addLayer({
          id: "hillshade", type: "hillshade", source: "mapbox-dem",
          paint: {
            "hillshade-exaggeration": 0.9,
            "hillshade-illumination-anchor": "viewport",
            "hillshade-illumination-direction": 315,
            "hillshade-shadow-color": "#05070a",
            "hillshade-highlight-color": "#9fb4d4",
            "hillshade-accent-color": "#243044",
          },
        });
        // 衛星實景底圖（預設隱藏，按鈕切換）→ 搭配真實地形＝比例微縮模型
        if (!map.getSource("sat")) {
          map.addSource("sat", { type: "raster", url: "mapbox://mapbox.satellite", tileSize: 256 });
        }
        map.addLayer({ id: "sat-layer", type: "raster", source: "sat", layout: { visibility: "none" }, paint: { "raster-opacity": 1 } });
        // 等高線（地形圖模式用，預設隱藏）→ 搭配真實 3D 凸起、不需衛星照片
        if (!map.getSource("tw-contour")) {
          map.addSource("tw-contour", { type: "vector", url: "mapbox://mapbox.mapbox-terrain-v2" });
        }
        map.addLayer({
          id: "contour-line", type: "line", source: "tw-contour", "source-layer": "contour",
          layout: { visibility: "none", "line-join": "round" },
          paint: {
            "line-color": "#6fae9f",
            "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.35, 11, 0.9, 14, 1.4],
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.3, 11, 0.55],
          },
        });
      } catch {}

      try {
        const gj = await fetch(COUNTY_GEOJSON).then((r) => r.json());
        const props = gj.features?.[0]?.properties || {};
        countyKeyRef.current = Object.keys(props).find((k) => /[縣市]$/.test(String(props[k]))) || "COUNTYNAME";
        map.addSource("tw-county", { type: "geojson", data: gj });
        map.addLayer({ id: "county-hl-fill", type: "fill", source: "tw-county", paint: { "fill-color": "#ffffff", "fill-opacity": 0.12 }, filter: ["==", ["get", countyKeyRef.current], "___none___"] });
        map.addLayer({ id: "county-hl-line", type: "line", source: "tw-county", paint: { "line-color": "#ffd54f", "line-width": 2.2, "line-opacity": 0.9 }, filter: ["==", ["get", countyKeyRef.current], "___none___"] });
      } catch {}

      map.addSource("intel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "intel-pts", type: "circle", source: "intel",
        paint: {
          "circle-radius": ["case", ["==", ["get", "cat"], "report"], 6, 7],
          "circle-color": ["match", ["get", "cat"], "disaster", COLOR.disaster, "safety", COLOR.safety, "warning", COLOR.warning, "defense", COLOR.defense, "policy", COLOR.policy, "ecology", COLOR.ecology, "activity", COLOR.activity, "report", COLOR.report, "#888"],
          "circle-opacity": 0.85, "circle-stroke-width": 1.3, "circle-stroke-color": "rgba(255,255,255,0.85)",
        },
      });

      const setHL = (county: string | null) => {
        const k = countyKeyRef.current;
        const f: any = county ? ["any", ["==", ["get", k], norm(county)], ["==", ["get", k], county]] : ["==", ["get", k], "___none___"];
        if (map.getLayer("county-hl-fill")) map.setFilter("county-hl-fill", f);
        if (map.getLayer("county-hl-line")) map.setFilter("county-hl-line", f);
      };
      map.on("mouseenter", "intel-pts", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const f = e.features?.[0]; if (!f) return;
        const p = f.properties as any;
        setHL(p.county || null);
        hoverRef.current?.setLngLat((f.geometry as any).coordinates).setText(p.title || "").addTo(map);
      });
      map.on("mouseleave", "intel-pts", () => { map.getCanvas().style.cursor = ""; setHL(null); hoverRef.current?.remove(); });
      map.on("click", "intel-pts", (e) => {
        const f = e.features?.[0]; if (!f) return;
        const p = f.properties as any;
        setHL(p.county || null);
        hoverRef.current?.remove();
        setSel({ hash: p.hash || "", title: p.title || "", summary: p.summary || "", url: p.url || "", county: p.county || "", cats: p.cats || "", source: p.source || "" });
        setExpanded(false); setReporting(false); setChosen(new Set()); setSent(false);
      });
      loadData();
    });
    return () => map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("intel-pts")) return;
    map.setFilter("intel-pts", ["in", ["get", "cat"], ["literal", Array.from(visible)]]);
  }, [visible]);

  async function loadData() {
    const map = mapRef.current; if (!map) return;
    const [evRes, rpRes] = await Promise.all([
      fetch(`/api/events?days=7`).then((r) => r.json()).catch(() => null),
      fetch(`/api/reports?radius=%E5%85%A8%E5%9C%8B&days=14`).then((r) => r.json()).catch(() => null),
    ]);
    const features: any[] = []; const tally: Record<string, number> = {};
    const primary = (cats: string): Cat => { const a = (cats || "").split(","); return (PRIORITY.find((c) => a.includes(c)) as Cat) || "policy"; };
    if (evRes?.ok) for (const e of evRes.events || []) {
      if (typeof e.lng !== "number") continue;
      const cat = primary(e.categories);
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [e.lng, e.lat] }, properties: { cat, cats: e.categories, hash: e.hash, title: e.title, summary: e.summary, source: e.source_name, url: e.url, county: e.county } });
      tally[cat] = (tally[cat] || 0) + 1;
    }
    if (rpRes?.ok) for (const r of rpRes.reports || []) {
      if (typeof r.lng !== "number") continue;
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [r.lng, r.lat] }, properties: { cat: "report", cats: "report", hash: "", title: r.title, summary: r.body, source: r.kind, url: "", county: "" } });
      tally.report = (tally.report || 0) + 1;
    }
    (map.getSource("intel") as mapboxgl.GeoJSONSource)?.setData({ type: "FeatureCollection", features } as any);
    setCounts(tally);
  }

  function recenter() { const m = mapRef.current; if (!m) return; const h = loadHome(); m.flyTo({ center: [h.lng, h.lat], zoom: h.zoom || 7.3, pitch: h.pitch ?? 55, bearing: h.bearing ?? 0, duration: 1100 }); }
  function memorize() { const m = mapRef.current; if (!m) return; const c = m.getCenter(); localStorage.setItem(HOME_KEY, JSON.stringify({ lng: c.lng, lat: c.lat, zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() })); setMemoSaved(true); setTimeout(() => setMemoSaved(false), 1600); }
  function applyBasemap(mode: "dark" | "topo" | "sat") {
    const m = mapRef.current; if (!m) return;
    const vis = (id: string, on: boolean) => { if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", on ? "visible" : "none"); };
    vis("sat-layer", mode === "sat");
    vis("contour-line", mode === "topo");
    vis("hillshade", mode !== "sat"); // 深色與地形模式都用陰影做凸起；衛星本身已有實景
    setBasemap(mode);
  }
  function cycleBasemap() {
    applyBasemap(basemap === "dark" ? "topo" : basemap === "topo" ? "sat" : "dark");
  }

  // 雨量站 → 六角柱(只畫有雨的站)，高度依近1小時雨量，示意比例
  function rainHexFC(stations: any[]) {
    const feats: any[] = [];
    const R = 0.0315; // 約 3.5km 的示意責任半徑
    for (const s of stations) {
      if (!(s.r1 > 0)) continue;
      const kx = R / Math.max(0.2, Math.cos((s.lat * Math.PI) / 180)), ky = R;
      const ring: number[][] = [];
      for (let i = 0; i < 6; i++) { const a = (Math.PI / 180) * (60 * i - 30); ring.push([s.lon + kx * Math.cos(a), s.lat + ky * Math.sin(a)]); }
      ring.push(ring[0]);
      feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { r1: s.r1, now: s.now, r24: s.r24, name: s.name } });
    }
    return { type: "FeatureCollection", features: feats } as any;
  }
  // 區域峰值：只取「在半徑 D 內雨量最大」的站，再留前 10 名(避免毛毛雨小站洗版)
  function rainPeaks(stations: any[]) {
    const wet = stations.filter((s) => s.r1 > 0);
    const D = 0.1;
    const peaks: any[] = [];
    for (const s of wet) {
      let isPeak = true;
      for (const o of wet) {
        if (o === s) continue;
        const dx = (o.lon - s.lon) * Math.cos((s.lat * Math.PI) / 180), dy = o.lat - s.lat;
        if (Math.hypot(dx, dy) <= D && o.r1 > s.r1) { isPeak = false; break; }
      }
      if (isPeak) peaks.push(s);
    }
    peaks.sort((a, b) => b.r1 - a.r1);
    return peaks.slice(0, 10);
  }
  function ensureDeck() {
    const m = mapRef.current; if (!m) return null;
    if (!deckRef.current) { deckRef.current = new MapboxOverlay({ interleaved: false, layers: [] }); m.addControl(deckRef.current as any); }
    return deckRef.current;
  }
  // 多個圖層(雨量標號、地震標號…)共用同一個 deck overlay，用登記表合併
  function setDeckLayers(key: string, layers: any[]) {
    const deck = ensureDeck(); if (!deck) return;
    deckLayersRef.current[key] = layers;
    deck.setProps({ layers: Object.values(deckLayersRef.current).flat() });
  }
  async function toggleRain() {
    const m = mapRef.current; if (!m) return;
    const on = !rainOn;
    if (!on) {
      if (m.getLayer("rain-col")) m.setLayoutProperty("rain-col", "visibility", "none");
      setDeckLayers("rain", []);
      setRainOn(false); setRainInfo("");
      return;
    }
    try {
      const d = await fetch("/api/weather").then((r) => r.json());
      if (!d.ok) { setRainInfo(d.error === "CWA_KEY 未設定" ? "雨量未啟用：請設定 CWA_KEY" : "雨量讀取失敗"); return; }
      const stations = d.stations || [];
      const fc = rainHexFC(stations);
      if (m.getSource("rain")) (m.getSource("rain") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("rain", { type: "geojson", data: fc });
        m.addLayer({
          id: "rain-col", type: "fill-extrusion", source: "rain",
          paint: {
            "fill-extrusion-color": ["interpolate", ["linear"], ["get", "r1"], 0, "#bcd9ff", 5, "#6baed6", 15, "#2171b5", 40, "#08306b"],
            "fill-extrusion-height": ["*", ["get", "r1"], RAIN_H],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.78,
          },
        });
      }
      m.setLayoutProperty("rain-col", "visibility", "visible");
      // 數字標號用 deck.gl 放在 [經度,緯度,地形高+柱高] 的 3D 位置，貼在水柱真實頂端
      const peaks = rainPeaks(stations).map((s: any) => ({
        ...s, z: ((m.queryTerrainElevation([s.lon, s.lat], { exaggerated: true }) as number) || 0) + s.r1 * RAIN_H,
      }));
      setDeckLayers("rain", [new TextLayer({
        id: "rain-peak-text",
        data: peaks,
        getPosition: (d: any) => [d.lon, d.lat, d.z],
        getText: (d: any) => `${d.name} ${Math.round(d.r1)}mm`,
        getSize: 13, sizeUnits: "pixels",
        getColor: [234, 244, 255, 255],
        billboard: true,
        fontFamily: '"Noto Sans TC","Microsoft JhengHei",sans-serif',
        characterSet: "auto",
        getTextAnchor: "middle", getAlignmentBaseline: "bottom",
        background: true, getBackgroundColor: [6, 16, 31, 210], backgroundPadding: [5, 3],
      })]);
      setRainOn(true);
      setRainInfo(d.time ? `雨量觀測 ${String(d.time).slice(11, 16)}` : "");
    } catch { setRainInfo("雨量讀取失敗"); }
  }
  // 地震各站震度 → 六角柱
  function quakeHexFC(stations: any[]) {
    const feats: any[] = []; const R = 0.0315;
    for (const s of stations) {
      if (!(s.int > 0)) continue;
      const kx = R / Math.max(0.2, Math.cos((s.lat * Math.PI) / 180)), ky = R;
      const ring: number[][] = [];
      for (let i = 0; i < 6; i++) { const a = (Math.PI / 180) * (60 * i - 30); ring.push([s.lon + kx * Math.cos(a), s.lat + ky * Math.sin(a)]); }
      ring.push(ring[0]);
      feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { int: s.int, name: s.name, intLabel: s.intLabel } });
    }
    return { type: "FeatureCollection", features: feats } as any;
  }
  function stopRipple() { if (rippleRef.current != null) { cancelAnimationFrame(rippleRef.current); rippleRef.current = null; } }
  function startRipple() {
    const m = mapRef.current; if (!m || !m.getLayer("quake-ripple")) return;
    const period = 2600;
    const tick = () => {
      const mm = mapRef.current; if (!mm || !mm.getLayer("quake-ripple")) return;
      const t = (performance.now() % period) / period;
      const radius = 6 + t * 46, op = 0.55 * (1 - t);
      mm.setPaintProperty("quake-ripple", "circle-radius", ["*", ["+", 0.5, ["/", ["coalesce", ["get", "mag"], 4], 6]], radius]);
      mm.setPaintProperty("quake-ripple", "circle-stroke-opacity", op);
      mm.setPaintProperty("quake-ripple", "circle-opacity", op * 0.22);
      rippleRef.current = requestAnimationFrame(tick);
    };
    stopRipple(); rippleRef.current = requestAnimationFrame(tick);
  }
  async function toggleQuake() {
    const m = mapRef.current; if (!m) return;
    const on = !quakeOn;
    if (!on) {
      for (const id of ["quake-col", "quake-epi", "quake-ripple"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none");
      stopRipple(); setDeckLayers("quake", []); quakePopRef.current?.remove();
      setQuakeOn(false); setQuakeInfo("");
      return;
    }
    try {
      const d = await fetch("/api/quake").then((r) => r.json());
      if (!d.ok) { setQuakeInfo(d.error === "CWA_KEY 未設定" ? "地震未啟用：請設定 CWA_KEY" : "地震讀取失敗"); return; }
      const quakes = d.quakes || [];
      if (!quakes.length) { setQuakeInfo("近期無顯著有感地震"); return; }
      const latest = quakes[0];
      const epiFC = {
        type: "FeatureCollection",
        features: quakes.map((q: any) => ({
          type: "Feature", geometry: { type: "Point", coordinates: [q.lon, q.lat] },
          properties: { mag: q.mag, depth: q.depth, time: q.time, location: q.location, web: q.web },
        })),
      } as any;
      if (m.getSource("quake-epi-src")) (m.getSource("quake-epi-src") as mapboxgl.GeoJSONSource).setData(epiFC);
      else {
        m.addSource("quake-epi-src", { type: "geojson", data: epiFC });
        m.addLayer({ id: "quake-ripple", type: "circle", source: "quake-epi-src", paint: { "circle-radius": 10, "circle-color": "#ff5a5a", "circle-opacity": 0.1, "circle-stroke-color": "#ff8080", "circle-stroke-width": 2, "circle-stroke-opacity": 0.4 } });
        m.addLayer({
          id: "quake-epi", type: "circle", source: "quake-epi-src",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "mag"], 3], 3, 4, 5, 8, 7, 16],
            "circle-color": ["interpolate", ["linear"], ["coalesce", ["get", "mag"], 3], 3, "#f1c40f", 5, "#e67e22", 6, "#e74c3c", 7, "#c0392b"],
            "circle-opacity": 0.9, "circle-stroke-width": 1.5, "circle-stroke-color": "#fff",
          },
        });
        m.on("click", "quake-epi", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          const t = p.time ? String(p.time).replace("T", " ").slice(0, 16) : "";
          const html = `<div class="qpop"><b>規模 ${p.mag ?? "?"}</b>　深度 ${p.depth ?? "?"} km<br/>${t}<br/>${String(p.location || "").replace(/</g, "")}` +
            (p.web ? `<br/><a href="${p.web}" target="_blank" rel="noopener noreferrer">氣象署地震報告 ↗</a>` : "") + `</div>`;
          quakePopRef.current?.remove();
          quakePopRef.current = new mapboxgl.Popup({ offset: 12, className: "hover-tip" }).setLngLat((f.geometry as any).coordinates).setHTML(html).addTo(m);
        });
        m.on("mouseenter", "quake-epi", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "quake-epi", () => { m.getCanvas().style.cursor = ""; });
      }
      const hex = quakeHexFC(latest.stations || []);
      if (m.getSource("quake-col-src")) (m.getSource("quake-col-src") as mapboxgl.GeoJSONSource).setData(hex);
      else {
        m.addSource("quake-col-src", { type: "geojson", data: hex });
        m.addLayer({
          id: "quake-col", type: "fill-extrusion", source: "quake-col-src",
          paint: {
            "fill-extrusion-color": ["interpolate", ["linear"], ["get", "int"], 1, "#9fd98f", 2, "#f7e463", 3, "#f7b14a", 4, "#f2663a", 5, "#e23b3b", 6, "#b3208a", 7, "#7a0fb0"],
            "fill-extrusion-height": ["*", ["get", "int"], QUAKE_H],
            "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.82,
          },
        });
      }
      for (const id of ["quake-ripple", "quake-epi", "quake-col"]) m.setLayoutProperty(id, "visibility", "visible");
      const labelStations = (latest.stations || []).filter((s: any) => s.int >= 3)
        .map((s: any) => ({ ...s, z: ((m.queryTerrainElevation([s.lon, s.lat], { exaggerated: true }) as number) || 0) + s.int * QUAKE_H }));
      setDeckLayers("quake", [new TextLayer({
        id: "quake-int-text", data: labelStations,
        getPosition: (s: any) => [s.lon, s.lat, s.z],
        getText: (s: any) => `${s.name} ${s.intLabel}`,
        getSize: 12, sizeUnits: "pixels", getColor: [255, 238, 228, 255], billboard: true,
        fontFamily: '"Noto Sans TC","Microsoft JhengHei",sans-serif', characterSet: "auto",
        getTextAnchor: "middle", getAlignmentBaseline: "bottom",
        background: true, getBackgroundColor: [44, 8, 8, 215], backgroundPadding: [5, 3],
      })]);
      startRipple();
      const lt = latest.time ? String(latest.time).replace("T", " ").slice(5, 16) : "";
      setQuakeOn(true);
      setQuakeInfo(`最新：規模 ${latest.mag ?? "?"}・${lt}`);
    } catch { setQuakeInfo("地震讀取失敗"); }
  }
  const BASEMAP_LABEL = { dark: "深色", topo: "地形", sat: "衛星" } as const;
  function toggle(cat: Cat) { setVisible((p) => { const n = new Set(p); n.has(cat) ? n.delete(cat) : n.add(cat); return n; }); }
  function toggleOpt(o: string) { setChosen((p) => { const n = new Set(p); n.has(o) ? n.delete(o) : n.add(o); return n; }); }
  async function submitReport() {
    if (!sel || chosen.size === 0) return;
    await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event_hash: sel.hash, event_title: sel.title, options: [...chosen] }) }).catch(() => {});
    setSent(true); refreshOrder();
  }

  const allOn = visible.size === CATS.length;
  if (!TOKEN) return <div className="token-missing"><div><strong>尚未設定 Mapbox token</strong></div></div>;

  return (
    <>
      <div id="map" ref={containerRef} />
      <div className="brand">
        <strong>台灣情報脈動</strong>
        <span>各地即時消息與公部門公開資料</span>
        <span className="brand-range">新聞與公告：近 7 天　·　群眾回報：近 14 天</span>
      </div>

      {terrainBlocked && !hintDismissed && (
        <div className="terrain-hint">
          <span>🏔️ 3D 立體地形被瀏覽器的隱私／防指紋防護擋住了。若想看真實山形起伏，請關閉本站的盾牌（Brave）或防追蹤設定後重新整理。衛星與一般圖層不受影響。</span>
          <button className="hint-x" onClick={() => setHintDismissed(true)} title="關閉提示">×</button>
        </div>
      )}

      <div className="center-control" onMouseEnter={() => setShowMemo(true)} onMouseLeave={() => setShowMemo(false)}>
        {showMemo && <button className="memo-btn" onClick={memorize} title="把目前畫面中心設為我的置中位置">{memoSaved ? "已記憶 ✓" : "記憶"}</button>}
        <button className="ctr-btn" onClick={recenter} title="回到我的置中位置">⌖</button>
      </div>

      <button className={"basemap-btn" + (basemap !== "dark" ? " on" : "")} onClick={cycleBasemap} title="切換底圖：深色 → 地形(等高線) → 衛星實景">
        {BASEMAP_LABEL[basemap]}
      </button>
      <button className={"rain-btn" + (rainOn ? " on" : "")} onClick={toggleRain} title="即時雨量 3D 水柱(近1小時雨量)">
        雨量
      </button>
      {rainInfo && <div className="rain-info">{rainInfo}</div>}
      <button className={"quake-btn" + (quakeOn ? " on" : "")} onClick={toggleQuake} title="近期顯著有感地震：震央漣漪 + 各站震度柱">
        地震
      </button>
      {quakeInfo && <div className="quake-info">{quakeInfo}</div>}

      {sel && (
        <div className="panel">
          <button className="panel-x" onClick={() => setSel(null)}>×</button>
          <div className="panel-title">{sel.title}</div>
          <div className={"panel-body" + (expanded ? "" : " clamp5")}>{sel.summary || "（此來源未提供內文摘要，請點原文）"}</div>
          <div className="panel-meta">
            {(sel.cats || "").split(",").filter(Boolean).map((c) => LABEL[c] || c).join("・")}
            {sel.source ? " · " + sel.source : ""}{sel.county ? " · " + sel.county : ""}
          </div>
          <div className="panel-actions">
            <button onClick={() => setExpanded((e) => !e)}>{expanded ? "收合" : "開啟全文"}</button>
            {sel.url && <a className="link-btn" href={sel.url} target="_blank" rel="noopener noreferrer">原文 ↗</a>}
            <button className={"rep-toggle" + (reporting ? " on" : "")} onClick={() => setReporting((r) => !r)}>回報錯誤</button>
          </div>
          {reporting && (sent ? (
            <div className="report-thanks">✓ 已收到回報，謝謝！</div>
          ) : (
            <div className="report">
              <div className="report-h">這則哪裡有問題？（可複選）</div>
              {optOrder.map((o) => (
                <label key={o} className="report-opt">
                  <input type="checkbox" checked={chosen.has(o)} onChange={() => toggleOpt(o)} />{o}
                </label>
              ))}
              <button className="report-send" disabled={chosen.size === 0} onClick={submitReport}>送出回報</button>
            </div>
          ))}
        </div>
      )}

      <div className="legend">
        {CATS.map((c) => (
          <button key={c.id} className={"legend-item" + (visible.has(c.id) ? "" : " off")} onClick={() => toggle(c.id)}>
            <span className="dot" style={{ background: c.color }} />{c.label}<span className="cnt">{counts[c.id] || 0}</span>
          </button>
        ))}
        <button className="legend-item" onClick={() => setVisible(allOn ? new Set() : new Set(CATS.map((c) => c.id)))} title="全選 / 取消全選">
          <span className="dot" style={{ background: "#ffffff", opacity: allOn ? 1 : 0.25 }} />全選
        </button>
      </div>
    </>
  );
}
