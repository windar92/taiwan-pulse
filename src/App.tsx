import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { TextLayer } from "@deck.gl/layers";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;
const HOME_KEY = "tp-home";
const DEFAULT_HOME = { lng: 120.95, lat: 23.8, zoom: 7.3 };
const COUNTY_GEOJSON = "https://raw.githubusercontent.com/g0v/twgeojson/master/json/twCounty2010.geo.json";
const RAIN_H = 700; // 雨量水柱示意高度倍率(柱高與標號高度共用)
const TEMP_H = 520; // (保留)
const TEMP_COL_H = 2600; // 氣溫柱固定高度(所有柱等高，溫度只用顏色表示)
function qDate(t: string) { if (!t) return ""; const d = new Date(t); const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function qLoc(s: string) { if (!s) return ""; const m = String(s).match(/位於(.+?)\)/); return m ? m[1] : String(s).slice(0, 10); }
// 震度色階(1→7級)，色相分明
const INT_COLORS: Record<number, number[]> = {
  1: [80, 200, 120], 2: [160, 220, 60], 3: [255, 214, 0], 4: [255, 138, 0], 5: [240, 50, 30], 6: [214, 0, 110], 7: [140, 40, 180],
};
const INT_HEX = ["#50c878", "#a0dc3c", "#ffd600", "#ff8a00", "#f0321e", "#d6006e", "#8c28b4"]; // 1..7

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
  const [tempOn, setTempOn] = useState(false);
  const [tempInfo, setTempInfo] = useState<string>("");
  const [staOn, setStaOn] = useState(false);
  const [staTypes, setStaTypes] = useState<Set<string>>(new Set(["weather", "rain", "quake"]));
  const staPopRef = useRef<mapboxgl.Popup | null>(null);
  const [typhoonOn, setTyphoonOn] = useState(false);
  const [typhoonInfo, setTyphoonInfo] = useState<string>("");
  const [oceanOn, setOceanOn] = useState(false);
  const [oceanInfo, setOceanInfo] = useState<string>("");
  const oceanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [quakeList, setQuakeList] = useState<any[]>([]);
  const [quakeSel, setQuakeSel] = useState(0);
  const rippleRef = useRef<number | null>(null);
  const quakePopRef = useRef<mapboxgl.Popup | null>(null);
  const deckRef = useRef<any>(null);
  const deckLayersRef = useRef<Record<string, any[]>>({});
  const intCanvasRef = useRef<HTMLCanvasElement | null>(null);

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
      // 專注東亞(蒙古—印尼、+8/+9 時區);範圍外不可平移、不載入，降低負載
      maxBounds: [[105, -12], [147, 53]], minZoom: 4,
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
        try { map.setFog({ range: [1.5, 10], color: "#0b0e13", "high-color": "#11151c", "horizon-blend": 0.25, "space-color": "#06080c", "star-intensity": 0 } as any); } catch {}
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
      feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { r1: s.r1, now: s.now, r24: s.r24, name: s.name, cx: s.lon, cy: s.lat } });
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
  // 滑鼠移過柱子時，在柱頂顯示該柱數值(deck 3D 文字)
  function hoverTip(lon: number, lat: number, z: number, text: string) {
    return new TextLayer({
      id: "hover-tip-deck", data: [{ lon, lat, z }],
      getPosition: (d: any) => [d.lon, d.lat, d.z], getText: () => text,
      getSize: 13, sizeUnits: "pixels", getColor: [255, 255, 255, 255], billboard: true,
      fontFamily: '"Noto Sans TC","Microsoft JhengHei",sans-serif', characterSet: "auto",
      getTextAnchor: "middle", getAlignmentBaseline: "bottom",
      background: true, getBackgroundColor: [20, 20, 24, 235], backgroundPadding: [6, 3],
    });
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
        m.on("mousemove", "rain-col", (e) => { const f = e.features?.[0]; if (!f) return; const p = f.properties as any; const z = ((m.queryTerrainElevation([p.cx, p.cy], { exaggerated: true }) as number) || 0) + p.r1 * RAIN_H; setDeckLayers("hover", [hoverTip(p.cx, p.cy, z, `${p.name} ${p.r1}mm`)]); });
        m.on("mouseleave", "rain-col", () => setDeckLayers("hover", []));
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
  // ===== 颱風圖層 =====
  function quadPoly(lon: number, lat: number, q: any) {
    if (!q) return null;
    const kLat = 1 / 111, kLon = 1 / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    const pts: number[][] = [];
    for (let a = 0; a <= 360; a += 8) {
      let r = a < 90 ? q.NE : a < 180 ? q.SE : a < 270 ? q.SW : q.NW; r = r || q.r || 0;
      const rad = (a * Math.PI) / 180;
      pts.push([lon + Math.sin(rad) * r * kLon, lat + Math.cos(rad) * r * kLat]);
    }
    pts.push(pts[0]); return pts;
  }
  function circlePoly(lon: number, lat: number, rkm: number) {
    const kLat = 1 / 111, kLon = 1 / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    const pts: number[][] = [];
    for (let a = 0; a <= 360; a += 12) { const rad = (a * Math.PI) / 180; pts.push([lon + Math.sin(rad) * rkm * kLon, lat + Math.cos(rad) * rkm * kLat]); }
    pts.push(pts[0]); return pts;
  }
  function setSrc(id: string, data: any) { const m = mapRef.current!; const s = m.getSource(id) as mapboxgl.GeoJSONSource; if (s) s.setData(data); else m.addSource(id, { type: "geojson", data }); }
  async function toggleTyphoon() {
    const m = mapRef.current; if (!m) return;
    const on = !typhoonOn;
    const ids = ["ty-cone", "ty-wind", "ty-path", "ty-fcst", "ty-center"];
    if (!on) { for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); setTyphoonOn(false); setTyphoonInfo(""); return; }
    try {
      const d = await fetch("/api/typhoon").then((r) => r.json());
      if (!d.ok) { setTyphoonInfo("颱風讀取失敗"); return; }
      const tys = d.typhoons || [];
      if (!tys.length) { setTyphoonInfo("目前西北太平洋無活動颱風"); return; }
      const lineF: any[] = [], coneF: any[] = [], windF: any[] = [], centerF: any[] = [];
      for (const t of tys) {
        if (t.analysis.length >= 2) lineF.push({ type: "Feature", properties: { type: "a" }, geometry: { type: "LineString", coordinates: t.analysis.map((p: any) => [p.lon, p.lat]) } });
        if (t.forecast.length) { const last = t.analysis[t.analysis.length - 1] || t.forecast[0]; lineF.push({ type: "Feature", properties: { type: "f" }, geometry: { type: "LineString", coordinates: [[last.lon, last.lat], ...t.forecast.map((p: any) => [p.lon, p.lat])] } }); }
        for (const p of t.forecast) if (p.r70) coneF.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circlePoly(p.lon, p.lat, p.r70)] } });
        const cur = t.analysis[t.analysis.length - 1];
        if (cur) {
          const w7 = quadPoly(cur.lon, cur.lat, cur.r15); if (w7) windF.push({ type: "Feature", properties: { lvl: 7 }, geometry: { type: "Polygon", coordinates: [w7] } });
          const w10 = quadPoly(cur.lon, cur.lat, cur.r25); if (w10) windF.push({ type: "Feature", properties: { lvl: 10 }, geometry: { type: "Polygon", coordinates: [w10] } });
          centerF.push({ type: "Feature", properties: { name: t.name, wind: cur.wind, pressure: cur.pressure }, geometry: { type: "Point", coordinates: [cur.lon, cur.lat] } });
        }
      }
      setSrc("ty-cone-src", { type: "FeatureCollection", features: coneF });
      setSrc("ty-wind-src", { type: "FeatureCollection", features: windF });
      setSrc("ty-line-src", { type: "FeatureCollection", features: lineF });
      setSrc("ty-center-src", { type: "FeatureCollection", features: centerF });
      if (!m.getLayer("ty-cone")) {
        m.addLayer({ id: "ty-cone", type: "fill", source: "ty-cone-src", paint: { "fill-color": "#9ecae1", "fill-opacity": 0.12 } });
        m.addLayer({ id: "ty-wind", type: "fill", source: "ty-wind-src", paint: { "fill-color": ["match", ["get", "lvl"], 10, "#e23b3b", "#f5a53c"], "fill-opacity": ["match", ["get", "lvl"], 10, 0.4, 0.22] } });
        m.addLayer({ id: "ty-path", type: "line", source: "ty-line-src", filter: ["==", ["get", "type"], "a"], paint: { "line-color": "#ffffff", "line-width": 2.4, "line-opacity": 0.9 } });
        m.addLayer({ id: "ty-fcst", type: "line", source: "ty-line-src", filter: ["==", ["get", "type"], "f"], paint: { "line-color": "#ffd54f", "line-width": 2.2, "line-dasharray": [2, 2], "line-opacity": 0.9 } });
        m.addLayer({ id: "ty-center", type: "symbol", source: "ty-center-src", layout: { "text-field": "🌀", "text-size": 30, "text-allow-overlap": true } });
      }
      for (const id of ids) m.setLayoutProperty(id, "visibility", "visible");
      setTyphoonOn(true); setTyphoonInfo(`颱風:${tys.map((t: any) => t.name).filter(Boolean).join("、")}`);
    } catch { setTyphoonInfo("颱風讀取失敗"); }
  }

  // ===== 海溫(SST)圖層 =====
  function sstColor(t: number) {
    // 色相分明的 spectral 色階，把海溫差異拉開
    const stops: [number, number[]][] = [[20, [49, 54, 149]], [23, [69, 117, 180]], [25, [116, 173, 209]], [26.5, [171, 217, 233]], [28, [254, 224, 144]], [29, [253, 141, 60]], [30, [240, 59, 32]], [31.5, [165, 0, 38]]];
    if (t <= stops[0][0]) return stops[0][1];
    if (t >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
    for (let i = 0; i < stops.length - 1; i++) { const [a, ca] = stops[i], [b, cb] = stops[i + 1]; if (t >= a && t <= b) { const f = (t - a) / (b - a); return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * f)); } }
    return stops[stops.length - 1][1];
  }
  function sstImage(points: any[]) {
    const x0 = 117, x1 = 124, y0 = 20, y1 = 27, step = 0.25;
    const nx = Math.round((x1 - x0) / step) + 1, ny = Math.round((y1 - y0) / step) + 1;
    const grid = new Float32Array(nx * ny).fill(NaN);
    for (const p of points) { const i = Math.round((p.lon - x0) / step), j = Math.round((p.lat - y0) / step); if (i >= 0 && i < nx && j >= 0 && j < ny) grid[j * nx + i] = p.sst; }
    const small = document.createElement("canvas"); small.width = nx; small.height = ny;
    const sctx = small.getContext("2d")!; const img = sctx.createImageData(nx, ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const v = grid[j * nx + i], row = ny - 1 - j, o = (row * nx + i) * 4; if (Number.isNaN(v)) { img.data[o + 3] = 0; continue; } const c = sstColor(v); img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 185; }
    sctx.putImageData(img, 0, 0);
    let cv = oceanCanvasRef.current; if (!cv) { cv = document.createElement("canvas"); oceanCanvasRef.current = cv; }
    const scale = 8; cv.width = nx * scale; cv.height = ny * scale; const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.imageSmoothingEnabled = true; ctx.filter = "blur(6px)"; ctx.drawImage(small, 0, 0, cv.width, cv.height); ctx.filter = "none";
    return { url: cv.toDataURL(), coords: [[x0, y1], [x1, y1], [x1, y0], [x0, y0]] as any };
  }
  async function toggleOcean() {
    const m = mapRef.current; if (!m) return;
    const on = !oceanOn;
    if (!on) { if (m.getLayer("ocean-sst")) m.setLayoutProperty("ocean-sst", "visibility", "none"); setOceanOn(false); setOceanInfo(""); return; }
    try {
      const d = await fetch("/api/ocean").then((r) => r.json());
      if (!d.ok || !(d.points || []).length) { setOceanInfo("海溫資料暫無"); return; }
      const sh = sstImage(d.points);
      if (m.getSource("ocean-src")) (m.getSource("ocean-src") as any).updateImage({ url: sh.url });
      else { m.addSource("ocean-src", { type: "image", url: sh.url, coordinates: sh.coords }); m.addLayer({ id: "ocean-sst", type: "raster", source: "ocean-src", paint: { "raster-opacity": 0.7, "raster-resampling": "linear", "raster-fade-duration": 0 } }, m.getLayer("intel-pts") ? "intel-pts" : undefined); }
      m.setLayoutProperty("ocean-sst", "visibility", "visible");
      setOceanOn(true); setOceanInfo(`海表溫度 ${d.date || ""}`);
    } catch { setOceanInfo("海溫讀取失敗"); }
  }

  // ===== 整合測站圖層(氣象/雨量/地震，可自選) =====
  function ptsFC(arr: any[]) {
    return { type: "FeatureCollection", features: arr.map((a) => ({ type: "Feature", geometry: { type: "Point", coordinates: [a.lon, a.lat] }, properties: a.p })) } as any;
  }
  function openStaPopup(f: any) {
    const m = mapRef.current; if (!m) return; const p = f.properties as any;
    const cwa = '<a href="https://www.cwa.gov.tw/V8/C/W/Observe/Observe.html" target="_blank" rel="noopener noreferrer">中央氣象署觀測 ↗</a>';
    let html = "";
    if (p.kind === "weather") html = `<div class="qpop"><b>${p.name}</b>　氣象站<br/>${p.county || ""}${p.town || ""}<br/>氣溫 ${p.temp ?? "-"}°C・${p.weather || ""}<br/>風 ${p.wind ?? "-"} m/s・濕度 ${p.humidity ?? "-"}%<br/>氣壓 ${p.pressure ?? "-"} hPa・時雨量 ${p.rain ?? "-"} mm<br/>${cwa}</div>`;
    else if (p.kind === "rain") html = `<div class="qpop"><b>${p.name}</b>　雨量站<br/>${p.county || ""}${p.town || ""}<br/>近1時 ${p.r1 ?? "-"} mm・今日 ${p.now ?? "-"} mm・24時 ${p.r24 ?? "-"} mm<br/>${cwa}</div>`;
    else html = `<div class="qpop"><b>${p.name}</b>　地震測站</div>`;
    staPopRef.current?.remove();
    staPopRef.current = new mapboxgl.Popup({ offset: 10, className: "hover-tip" }).setLngLat((f.geometry as any).coordinates).setHTML(html).addTo(m);
  }
  function applyStaVis(on: boolean, types: Set<string>) {
    const m = mapRef.current; if (!m) return;
    for (const t of ["weather", "rain", "quake"]) { const id = "sta-" + t; if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", on && types.has(t) ? "visible" : "none"); }
  }
  function toggleStaType(t: string) {
    setStaTypes((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); applyStaVis(staOn, n); return n; });
  }
  async function toggleSta() {
    const m = mapRef.current; if (!m) return;
    const on = !staOn;
    if (!on) { applyStaVis(false, staTypes); staPopRef.current?.remove(); setStaOn(false); return; }
    if (!m.getSource("sta-weather-src")) {
      const [aw, ar, aq] = await Promise.all([
        fetch("/api/airtemp").then((r) => r.json()).catch(() => ({ stations: [] })),
        fetch("/api/weather").then((r) => r.json()).catch(() => ({ stations: [] })),
        fetch("/api/quake").then((r) => r.json()).catch(() => ({ quakes: [] })),
      ]);
      const wfc = ptsFC((aw.stations || []).map((s: any) => ({ lon: s.lon, lat: s.lat, p: { kind: "weather", name: s.name, temp: s.temp, weather: s.weather, wind: s.wind, humidity: s.humidity, pressure: s.pressure, rain: s.rain, county: s.county, town: s.town } })));
      const rfc = ptsFC((ar.stations || []).map((s: any) => ({ lon: s.lon, lat: s.lat, p: { kind: "rain", name: s.name, r1: s.r1, now: s.now, r24: s.r24, county: s.county, town: s.town } })));
      const seen = new Set(), qs: any[] = [];
      for (const q of (aq.quakes || [])) for (const s of (q.stations || [])) { const k = s.name + "," + s.lat + "," + s.lon; if (seen.has(k)) continue; seen.add(k); qs.push({ lon: s.lon, lat: s.lat, p: { kind: "quake", name: s.name } }); }
      m.addSource("sta-weather-src", { type: "geojson", data: wfc });
      m.addSource("sta-rain-src", { type: "geojson", data: rfc });
      m.addSource("sta-quake-src", { type: "geojson", data: ptsFC(qs) });
      const addCircle = (id: string, src: string, color: string) => {
        m.addLayer({ id, type: "circle", source: src, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3, 11, 5], "circle-color": color, "circle-opacity": 0.95, "circle-stroke-width": 1.2, "circle-stroke-color": "#ffffff" } });
        m.on("click", id, (e) => { const f = e.features?.[0]; if (f) openStaPopup(f); });
        m.on("mouseenter", id, () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", id, () => { m.getCanvas().style.cursor = ""; });
      };
      addCircle("sta-weather", "sta-weather-src", "#E69F00"); // 橙
      addCircle("sta-rain", "sta-rain-src", "#0072B2");       // 藍
      addCircle("sta-quake", "sta-quake-src", "#009E73");     // 綠(Okabe-Ito 色盲友善)
    }
    applyStaVis(true, staTypes); setStaOn(true);
  }
  // 氣溫站 → 六角柱(高度依氣溫，色彩以 20°C 為中點:藍冷紅熱)
  function tempHexFC(stations: any[]) {
    const feats: any[] = []; const R = 0.0315;
    for (const s of stations) {
      if (s.temp == null) continue;
      const kx = R / Math.max(0.2, Math.cos((s.lat * Math.PI) / 180)), ky = R;
      const ring: number[][] = [];
      for (let i = 0; i < 6; i++) { const a = (Math.PI / 180) * (60 * i - 30); ring.push([s.lon + kx * Math.cos(a), s.lat + ky * Math.sin(a)]); }
      ring.push(ring[0]);
      feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { temp: s.temp, name: s.name, cx: s.lon, cy: s.lat } });
    }
    return { type: "FeatureCollection", features: feats } as any;
  }
  async function toggleTemp() {
    const m = mapRef.current; if (!m) return;
    const on = !tempOn;
    if (!on) {
      if (m.getLayer("temp-col")) m.setLayoutProperty("temp-col", "visibility", "none");
      setDeckLayers("temp", []); setTempOn(false); setTempInfo("");
      return;
    }
    try {
      const d = await fetch("/api/airtemp").then((r) => r.json());
      if (!d.ok) { setTempInfo(d.error === "CWA_KEY 未設定" ? "氣溫未啟用：請設定 CWA_KEY" : "氣溫讀取失敗"); return; }
      const stations = (d.stations || []).filter((s: any) => s.temp != null);
      const fc = tempHexFC(stations);
      if (m.getSource("temp-src")) (m.getSource("temp-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("temp-src", { type: "geojson", data: fc });
        m.addLayer({
          id: "temp-col", type: "fill-extrusion", source: "temp-src",
          paint: {
            "fill-extrusion-color": ["interpolate", ["linear"], ["get", "temp"], 6, "#08306b", 11, "#2c7fb8", 16, "#7fcdbb", 20, "#ffffcc", 24, "#fd8d3c", 28, "#e31a1c", 33, "#800026"],
            "fill-extrusion-height": TEMP_COL_H,
            "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.9,
          },
        });
        m.on("mousemove", "temp-col", (e) => { const f = e.features?.[0]; if (!f) return; const p = f.properties as any; const z = ((m.queryTerrainElevation([p.cx, p.cy], { exaggerated: true }) as number) || 0) + TEMP_COL_H; setDeckLayers("hover", [hoverTip(p.cx, p.cy, z, `${p.name} ${p.temp}°`)]); });
        m.on("mouseleave", "temp-col", () => setDeckLayers("hover", []));
      }
      m.setLayoutProperty("temp-col", "visibility", "visible");
      const hot = [...stations].sort((a, b) => b.temp - a.temp).slice(0, 4);
      const cold = [...stations].sort((a, b) => a.temp - b.temp).slice(0, 4);
      const picks = [...hot, ...cold].map((s: any) => ({ ...s, z: ((m.queryTerrainElevation([s.lon, s.lat], { exaggerated: true }) as number) || 0) + TEMP_COL_H }));
      setDeckLayers("temp", [new TextLayer({
        id: "temp-text", data: picks,
        getPosition: (s: any) => [s.lon, s.lat, s.z],
        getText: (s: any) => `${s.name} ${s.temp}°`,
        getSize: 12, sizeUnits: "pixels", getColor: [255, 255, 255, 255], billboard: true,
        fontFamily: '"Noto Sans TC","Microsoft JhengHei",sans-serif', characterSet: "auto",
        getTextAnchor: "middle", getAlignmentBaseline: "bottom",
        background: true, getBackgroundColor: [10, 18, 30, 210], backgroundPadding: [5, 3],
      })]);
      const ts = stations.map((s: any) => s.temp);
      setTempOn(true);
      setTempInfo(`氣溫觀測 ${d.time ? String(d.time).slice(11, 16) : ""}　${Math.min(...ts).toFixed(0)}–${Math.max(...ts).toFixed(0)}°C`);
    } catch { setTempInfo("氣溫讀取失敗"); }
  }
  // 以各站震度做 IDW 空間內插，建出規則網格(資料空白區設 0，讓等高線收在有感範圍內)
  function idwGrid(stations: any[]) {
    const x0 = 119.2, x1 = 122.4, y0 = 21.7, y1 = 25.5, dx = 0.02, dy = 0.02;
    const nx = Math.ceil((x1 - x0) / dx) + 1, ny = Math.ceil((y1 - y0) / dy) + 1;
    const g = new Float32Array(nx * ny);
    const maxD2 = 0.4 * 0.4;
    for (let j = 0; j < ny; j++) {
      const y = y0 + j * dy;
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * dx;
        let num = 0, den = 0, nearest = 1e9;
        for (const s of stations) {
          const ddx = s.lon - x, ddy = s.lat - y, d2 = ddx * ddx + ddy * ddy;
          if (d2 < nearest) nearest = d2;
          const w = 1 / (d2 + 1e-6); num += w * s.int; den += w;
        }
        g[j * nx + i] = nearest > maxD2 ? 0 : (den ? num / den : 0);
      }
    }
    return { g, nx, ny, x0, y0, dx, dy };
  }
  // ShakeMap 式填色：把 IDW 網格畫成色帶影像(回傳 data URL + 地理範圍)
  function shakeImage(stations: any[]) {
    const G = idwGrid(stations);
    const { g, nx, ny, x0, y0, dx, dy } = G;
    const x1 = x0 + (nx - 1) * dx, y1 = y0 + (ny - 1) * dy;
    // 先畫到網格大小的小 canvas
    const small = document.createElement("canvas"); small.width = nx; small.height = ny;
    const sctx = small.getContext("2d")!; const img = sctx.createImageData(nx, ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = g[j * nx + i], row = ny - 1 - j, o = (row * nx + i) * 4;
      if (v < 1) { img.data[o + 3] = 0; continue; }
      const c = INT_COLORS[Math.max(1, Math.min(7, Math.round(v)))];
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 200;
    }
    sctx.putImageData(img, 0, 0);
    // 放大 + 模糊 → 邊緣平滑不鋸齒
    let cv = intCanvasRef.current; if (!cv) { cv = document.createElement("canvas"); intCanvasRef.current = cv; }
    const scale = 4; cv.width = nx * scale; cv.height = ny * scale;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = true; (ctx as any).imageSmoothingQuality = "high";
    ctx.filter = "blur(7px)";
    ctx.drawImage(small, 0, 0, cv.width, cv.height);
    ctx.filter = "none";
    return { url: cv.toDataURL(), coords: [[x0, y1], [x1, y1], [x1, y0], [x0, y0]] as any };
  }
  // 所有有感測站的點
  function quakeStationsFC(stations: any[]) {
    return { type: "FeatureCollection", features: stations.map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { int: s.int, lbl: String(s.intLabel || s.int).replace("級", ""), name: s.name } })) } as any;
  }
  function stopRipple() { if (rippleRef.current != null) { cancelAnimationFrame(rippleRef.current); rippleRef.current = null; } }
  function startRipple() {
    const m = mapRef.current; if (!m || !m.getLayer("quake-ripple")) return;
    const period = 2600;
    const tick = () => {
      const mm = mapRef.current; if (!mm || !mm.getLayer("quake-ripple")) return;
      const t = (performance.now() % period) / period;
      const radius = 6 + t * 42, op = 0.6 * (1 - t);
      mm.setPaintProperty("quake-ripple", "circle-radius", radius);
      mm.setPaintProperty("quake-ripple", "circle-stroke-opacity", op);
      mm.setPaintProperty("quake-ripple", "circle-opacity", op * 0.18);
      rippleRef.current = requestAnimationFrame(tick);
    };
    stopRipple(); rippleRef.current = requestAnimationFrame(tick);
  }
  function renderQuake(q: any) {
    const m = mapRef.current; if (!m || !q) return;
    const epiFC = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [q.lon, q.lat] }, properties: { mag: q.mag, depth: q.depth, time: q.time, location: q.location, web: q.web } }] } as any;
    (m.getSource("quake-epi-src") as mapboxgl.GeoJSONSource)?.setData(epiFC);
    const shakeSrc = m.getSource("quake-shake") as any;
    if (shakeSrc) shakeSrc.updateImage({ url: shakeImage(q.stations || []).url });
    (m.getSource("quake-sta-src") as mapboxgl.GeoJSONSource)?.setData(quakeStationsFC(q.stations || []));
  }
  function selectQuake(i: number) {
    const q = quakeList[i]; if (!q) return;
    setQuakeSel(i); renderQuake(q);
    const m = mapRef.current; if (m) m.flyTo({ center: [q.lon, q.lat], duration: 800 });
  }
  async function toggleQuake() {
    const m = mapRef.current; if (!m) return;
    const on = !quakeOn;
    if (!on) {
      for (const id of ["quake-shake-layer", "quake-sta", "quake-epi", "quake-ripple"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none");
      stopRipple(); quakePopRef.current?.remove();
      setQuakeOn(false); setQuakeList([]); setQuakeInfo("");
      return;
    }
    try {
      const d = await fetch("/api/quake").then((r) => r.json());
      if (!d.ok) { setQuakeInfo(d.error === "CWA_KEY 未設定" ? "地震未啟用：請設定 CWA_KEY" : "地震讀取失敗"); return; }
      const quakes = d.quakes || [];
      if (!quakes.length) { setQuakeInfo("近期無顯著有感地震"); return; }
      if (!m.getSource("quake-shake")) {
        const sh = shakeImage(quakes[0].stations || []);
        m.addSource("quake-shake", { type: "image", url: sh.url, coordinates: sh.coords });
        m.addLayer({ id: "quake-shake-layer", type: "raster", source: "quake-shake", paint: { "raster-opacity": 0.6, "raster-resampling": "linear", "raster-fade-duration": 0 } });
        m.addSource("quake-sta-src", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({
          id: "quake-sta", type: "symbol", source: "quake-sta-src",
          layout: { "text-field": ["get", "lbl"], "text-size": ["interpolate", ["linear"], ["zoom"], 6, 11, 11, 16], "text-allow-overlap": false },
          paint: { "text-color": "#ffffff", "text-halo-color": "#000000", "text-halo-width": 1.8 },
        });
      }
      if (!m.getSource("quake-epi-src")) {
        m.addSource("quake-epi-src", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({ id: "quake-ripple", type: "circle", source: "quake-epi-src", paint: { "circle-radius": 10, "circle-color": "#ff5a5a", "circle-opacity": 0.1, "circle-stroke-color": "#ff8080", "circle-stroke-width": 2, "circle-stroke-opacity": 0.5 } });
        m.addLayer({
          id: "quake-epi", type: "symbol", source: "quake-epi-src",
          layout: { "text-field": "★", "text-size": ["interpolate", ["linear"], ["coalesce", ["get", "mag"], 4], 3, 18, 7, 38], "text-allow-overlap": true, "text-ignore-placement": true },
          paint: { "text-color": "#ffffff", "text-halo-color": "#b3001b", "text-halo-width": 2.2 },
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
      for (const id of ["quake-shake-layer", "quake-sta", "quake-epi", "quake-ripple"]) m.setLayoutProperty(id, "visibility", "visible");
      setQuakeList(quakes); setQuakeSel(0);
      renderQuake(quakes[0]); startRipple();
      setQuakeOn(true); setQuakeInfo("");
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
      <button className={"quake-btn" + (quakeOn ? " on" : "")} onClick={toggleQuake} title="近期顯著有感地震：震央 + 不規則震度擴散範圍">
        地震
      </button>
      {quakeInfo && <div className="quake-info">{quakeInfo}</div>}
      <button className={"temp-btn" + (tempOn ? " on" : "")} onClick={toggleTemp} title="即時氣溫 3D 柱(藍冷紅熱，20°C 為中點)">
        氣溫
      </button>
      {tempInfo && <div className="temp-info">{tempInfo}</div>}
      <button className={"sta-btn" + (staOn ? " on" : "")} onClick={toggleSta} title="測站位置(氣象/雨量/地震)，點站看最新數據">
        測站
      </button>
      {staOn && (
        <div className="sta-panel">
          {([["weather", "氣象站", "#E69F00"], ["rain", "雨量站", "#0072B2"], ["quake", "地震站", "#009E73"]] as const).map(([k, label, c]) => (
            <label key={k} className="sta-opt">
              <input type="checkbox" checked={staTypes.has(k)} onChange={() => toggleStaType(k)} />
              <span className="sta-dot" style={{ background: c }} />{label}
            </label>
          ))}
        </div>
      )}

      <button className={"ty-btn" + (typhoonOn ? " on" : "")} onClick={toggleTyphoon} title="颱風路徑、暴風圈與預報警戒圈">
        颱風
      </button>
      {typhoonInfo && <div className="ty-info">{typhoonInfo}</div>}
      <button className={"ocean-btn" + (oceanOn ? " on" : "")} onClick={toggleOcean} title="海表溫度(台大 ODB)">
        海溫
      </button>
      {oceanInfo && <div className="ocean-info">{oceanInfo}</div>}

      {quakeOn && quakeList.length > 0 && (
        <div className="quake-list">
          <div className="ql-head">近期有感地震（新 → 舊）</div>
          {quakeList.map((q, i) => ({ q, i })).map(({ q, i }) => (
            <div key={q.no ?? i} className={"ql-item" + (i === quakeSel ? " sel" : "")}
              title={`規模 ${q.mag ?? "?"}・深度 ${q.depth ?? "?"} km`} onClick={() => selectQuake(i)}>
              <span className="ql-date">{qDate(q.time)}</span>
              <span className="ql-loc">M{q.mag ?? "?"}　{qLoc(q.location)}</span>
            </div>
          ))}
        </div>
      )}

      {quakeOn && (
        <div className="quake-legend">
          <span className="qlg-title">震度</span>
          {INT_HEX.map((c, idx) => (<span key={idx} className="qlg-sw" style={{ background: c }}>{idx + 1}</span>))}
        </div>
      )}

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
