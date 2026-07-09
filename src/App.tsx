import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { TextLayer, SolidPolygonLayer } from "@deck.gl/layers";

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
  const [menuOpen, setMenuOpen] = useState(true);
  const [newsOpen, setNewsOpen] = useState(true);
  const [allLayersOn, setAllLayersOn] = useState(false);
  const [memoSaved, setMemoSaved] = useState(false);
  const [basemap, setBasemap] = useState<"dark" | "topo" | "sat" | "gibs">("dark");
  const [satOn, setSatOn] = useState(false);
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
  const [rainMode, setRainMode] = useState<"1h" | "24h">("1h");
  const rainModeRef = useRef<"1h" | "24h">("1h");
  const rainStationsRef = useRef<any[]>([]);
  const rainTimeRef = useRef<string>("");
  const [quakeOn, setQuakeOn] = useState(false);
  const [quakeInfo, setQuakeInfo] = useState<string>("");
  const [quakeAll, setQuakeAll] = useState(false);
  const quakeAllRef = useRef(false);
  const [tempOn, setTempOn] = useState(false);
  const [tempInfo, setTempInfo] = useState<string>("");
  const [staOn, setStaOn] = useState(false);
  const [staTypes, setStaTypes] = useState<Set<string>>(new Set(["weather", "rain", "quake"]));
  const staPopRef = useRef<mapboxgl.Popup | null>(null);
  const [typhoonOn, setTyphoonOn] = useState(false);
  const [typhoonMode, setTyphoonMode] = useState(0);
  const typhoonModeRef = useRef(0);
  const typhoonCenterRef = useRef<[number, number] | null>(null);
  const [typhoonInfo, setTyphoonInfo] = useState<string>("");
  const [oceanOn, setOceanOn] = useState(false);
  const [oceanInfo, setOceanInfo] = useState<string>("");
  const [riversOn, setRiversOn] = useState(false);
  const riverPopRef = useRef<mapboxgl.Popup | null>(null);
  const [riverMode, setRiverMode] = useState(0);
  const riverModeRef = useRef(0);
  const [shipsOn, setShipsOn] = useState(false);
  const [shipsInfo, setShipsInfo] = useState<string>("");
  const shipPopRef = useRef<mapboxgl.Popup | null>(null);
  const [peaksOn, setPeaksOn] = useState(false);
  const [peaksInfo, setPeaksInfo] = useState<string>("");
  const peakPopRef = useRef<mapboxgl.Popup | null>(null);
  const [peakCls, setPeakCls] = useState<Set<string>>(new Set(["百岳", "小百岳"]));
  const peakClsRef = useRef<Set<string>>(new Set(["百岳", "小百岳"]));
  const peaksDataRef = useRef<any>(null);
  const [lakeOn, setLakeOn] = useState(false);
  const [lakeInfo, setLakeInfo] = useState<string>("");
  const lakePopRef = useRef<mapboxgl.Popup | null>(null);
  const [gzOn, setGzOn] = useState(false);
  const gzPopRef = useRef<mapboxgl.Popup | null>(null);
  const [gzFrom, setGzFrom] = useState(0);
  const [gzTo, setGzTo] = useState(0);
  const [gzMax, setGzMax] = useState(0);
  const [gzInfo, setGzInfo] = useState<string>("");
  const gzDataRef = useRef<any[]>([]);
  const [wallOn, setWallOn] = useState(false);
  const [wallInfo, setWallInfo] = useState<string>("");
  const wallPopRef = useRef<mapboxgl.Popup | null>(null);
  const [wallExag, setWallExag] = useState(20);
  const [wallWidth, setWallWidth] = useState(1);
  const wallDataRef = useRef<any[]>([]);
  const wallExagRef = useRef(20);
  const wallWidthRef = useRef(1);
  const wallMoveRef = useRef<any>(null);
  const riverGeoRef = useRef<any[]>([]);
  const oceanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverIdRef = useRef<{ rain: any; temp: any }>({ rain: null, temp: null });
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
  // 背景預抓山岳資料(Overpass 冷啟較慢)，使用者點開時已就緒
  useEffect(() => { const t = setTimeout(() => { fetch("/api/peaks?min=1000").then((r) => r.json()).then((d) => { if (d && d.ok) peaksDataRef.current = d; }).catch(() => {}); }, 3500); return () => clearTimeout(t); }, []);

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
  function ensureGibs() {
    const m = mapRef.current; if (!m || m.getLayer("gibs-sat")) return;
    const d = new Date(Date.now() - 24 * 3600 * 1000);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    m.addSource("gibs-sat", { type: "raster", tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`], tileSize: 256, maxzoom: 9, attribution: "NASA EOSDIS GIBS" });
    const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
    m.addLayer({ id: "gibs-sat", type: "raster", source: "gibs-sat", paint: { "raster-opacity": 0.9 } }, beforeId);
  }
  function applyBasemap(mode: "dark" | "topo" | "sat" | "gibs") {
    const m = mapRef.current; if (!m) return;
    if (mode === "gibs") ensureGibs();
    const vis = (id: string, on: boolean) => { if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", on ? "visible" : "none"); };
    vis("sat-layer", mode === "sat");
    vis("contour-line", mode === "topo");
    vis("hillshade", mode !== "sat" && mode !== "gibs"); // 衛星/空照本身已有實景，其餘用陰影做凸起
    vis("gibs-sat", mode === "gibs");
    setBasemap(mode);
  }
  function cycleBasemap() {
    const order = ["dark", "topo", "sat", "gibs"] as const;
    applyBasemap(order[(order.indexOf(basemap as any) + 1) % order.length]);
  }

  // 雨量站 → 六角柱(有雨的站)，高度依所選時距雨量，示意比例
  function rainVal(s: any, metric: "1h" | "24h") { return metric === "24h" ? (s.r24 || 0) : (s.r1 || 0); }
  function rainHexFC(stations: any[], metric: "1h" | "24h") {
    const feats: any[] = [];
    const R = 0.0315; // 約 3.5km 的示意責任半徑
    for (const s of stations) {
      const v = rainVal(s, metric);
      if (!(v > 0)) continue;
      const kx = R / Math.max(0.2, Math.cos((s.lat * Math.PI) / 180)), ky = R;
      const ring: number[][] = [];
      for (let i = 0; i < 6; i++) { const a = (Math.PI / 180) * (60 * i - 30); ring.push([s.lon + kx * Math.cos(a), s.lat + ky * Math.sin(a)]); }
      ring.push(ring[0]);
      feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { r1: v, now: s.now, r24: s.r24, name: s.name, cx: s.lon, cy: s.lat } });
    }
    return { type: "FeatureCollection", features: feats } as any;
  }
  // 全部測站的覆蓋點(含沒下雨的)，顏色依所選時距雨量
  function rainDotFC(stations: any[], metric: "1h" | "24h") {
    return { type: "FeatureCollection", features: stations.filter((s) => typeof s.lon === "number").map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { v: rainVal(s, metric), name: s.name } })) } as any;
  }
  // 區域峰值：只取「在半徑 D 內雨量最大」的站，再留前 10 名(避免毛毛雨小站洗版)
  function rainPeaks(stations: any[], metric: "1h" | "24h") {
    const wet = stations.filter((s) => rainVal(s, metric) > 0);
    const D = 0.1;
    const peaks: any[] = [];
    for (const s of wet) {
      let isPeak = true;
      for (const o of wet) {
        if (o === s) continue;
        const dx = (o.lon - s.lon) * Math.cos((s.lat * Math.PI) / 180), dy = o.lat - s.lat;
        if (Math.hypot(dx, dy) <= D && rainVal(o, metric) > rainVal(s, metric)) { isPeak = false; break; }
      }
      if (isPeak) peaks.push(s);
    }
    peaks.sort((a, b) => rainVal(b, metric) - rainVal(a, metric));
    return peaks.slice(0, 10);
  }
  function ensureDeck() {
    const m = mapRef.current; if (!m) return null;
    if (!deckRef.current) { deckRef.current = new MapboxOverlay({ interleaved: true, layers: [] }); m.addControl(deckRef.current as any); }
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
  function renderRain(metric: "1h" | "24h") {
    const m = mapRef.current; if (!m) return;
    const stations = rainStationsRef.current || [];
    const fc = rainHexFC(stations, metric);
    (m.getSource("rain") as mapboxgl.GeoJSONSource)?.setData(fc);
    (m.getSource("rain-dot") as mapboxgl.GeoJSONSource)?.setData(rainDotFC(stations, metric));
    const peaks = rainPeaks(stations, metric).map((s: any) => ({ ...s, v: rainVal(s, metric), z: ((m.queryTerrainElevation([s.lon, s.lat], { exaggerated: true }) as number) || 0) + Math.min(rainVal(s, metric), 80) * RAIN_H }));
    setDeckLayers("rain", [new TextLayer({
      id: "rain-peak-text", data: peaks,
      getPosition: (d: any) => [d.lon, d.lat, d.z], getText: (d: any) => `${d.name} ${Math.round(d.v)}mm`,
      getSize: 13, sizeUnits: "pixels", getColor: [234, 244, 255, 255], billboard: true,
      fontFamily: '"Noto Sans TC","Microsoft JhengHei",sans-serif', characterSet: "auto",
      getTextAnchor: "middle", getAlignmentBaseline: "bottom",
      background: true, getBackgroundColor: [6, 16, 31, 210], backgroundPadding: [5, 3],
    })]);
    const wet = stations.filter((s: any) => rainVal(s, metric) > 0).length;
    setRainInfo(`${metric === "24h" ? "近24小時" : "近1小時"}雨量　全台 ${stations.length} 站、其中 ${wet} 站有雨${rainTimeRef.current ? `　觀測 ${rainTimeRef.current.slice(11, 16)}` : ""}`);
  }
  function setRainModeAndRender(metric: "1h" | "24h") { rainModeRef.current = metric; setRainMode(metric); renderRain(metric); }
  async function toggleRain() {
    const m = mapRef.current; if (!m) return;
    const on = !rainOn;
    const ids = ["rain-dot", "rain-col"];
    if (!on) {
      for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none");
      setDeckLayers("rain", []);
      setRainOn(false); setRainInfo("");
      return;
    }
    try {
      const d = await fetch("/api/weather").then((r) => r.json());
      if (!d.ok) { setRainInfo(d.error === "CWA_KEY 未設定" ? "雨量未啟用：請設定 CWA_KEY" : "雨量讀取失敗"); return; }
      const stations = d.stations || [];
      rainStationsRef.current = stations; rainTimeRef.current = d.time || "";
      const metric = rainModeRef.current;
      if (!m.getSource("rain")) {
        m.addSource("rain", { type: "geojson", data: rainHexFC(stations, metric), generateId: true });
        m.addSource("rain-dot", { type: "geojson", data: rainDotFC(stations, metric) });
        m.addLayer({ id: "rain-dot", type: "circle", source: "rain-dot", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 1.6, 11, 3.2], "circle-color": ["interpolate", ["linear"], ["get", "v"], 0, "rgba(120,140,160,0.5)", 0.5, "#9ecae1", 10, "#4292c6", 40, "#08519c"], "circle-stroke-width": 0 } });
        m.addLayer({
          id: "rain-col", type: "fill-extrusion", source: "rain",
          paint: {
            "fill-extrusion-color": ["case", ["boolean", ["feature-state", "hover"], false], "#ffffff", ["interpolate", ["linear"], ["get", "r1"], 0, "#bcd9ff", 5, "#6baed6", 15, "#2171b5", 40, "#08306b"]],
            "fill-extrusion-height": ["*", ["min", ["get", "r1"], 80], RAIN_H],
            "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.8,
          },
        });
        m.on("mousemove", "rain-col", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          const z = ((m.queryTerrainElevation([p.cx, p.cy], { exaggerated: true }) as number) || 0) + Math.min(p.r1, 80) * RAIN_H;
          setDeckLayers("hover", [hoverTip(p.cx, p.cy, z, `${p.name} ${p.r1}mm`)]);
          if (hoverIdRef.current.rain != null && hoverIdRef.current.rain !== f.id) m.setFeatureState({ source: "rain", id: hoverIdRef.current.rain }, { hover: false });
          hoverIdRef.current.rain = f.id; m.setFeatureState({ source: "rain", id: f.id }, { hover: true });
        });
        m.on("mouseleave", "rain-col", () => { setDeckLayers("hover", []); if (hoverIdRef.current.rain != null) { m.setFeatureState({ source: "rain", id: hoverIdRef.current.rain }, { hover: false }); hoverIdRef.current.rain = null; } });
      }
      for (const id of ids) m.setLayoutProperty(id, "visibility", "visible");
      renderRain(metric);
      setRainOn(true);
    } catch { setRainInfo("雨量讀取失敗"); }
  }
  // ===== 中國船舶 AIS 圖層(叢集) =====
  async function toggleShips() {
    const m = mapRef.current; if (!m) return;
    const on = !shipsOn;
    const ids = ["ship-trk-line", "ship-trk-warn", "ships-cluster", "ships-count", "ships-pt"];
    if (!on) { for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); shipPopRef.current?.remove(); setShipsOn(false); setShipsInfo(""); return; }
    try {
      const d = await fetch("/api/ships?t=" + Math.floor(Date.now() / 30000)).then((r) => r.json());
      if (!d.ok) { setShipsInfo("船舶未啟用：請設定 AISSTREAM_KEY"); return; }
      loadShipTracks(m);
      const fc = { type: "FeatureCollection", features: (d.ships || []).filter((s: any) => typeof s.lng === "number").map((s: any) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lng, s.lat] }, properties: { name: s.name || s.mmsi, cls: s.cls || "其他", mmsi: s.mmsi, sog: s.sog, type: s.shiptype } })) } as any;
      if (m.getSource("ships-src")) (m.getSource("ships-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("ships-src", { type: "geojson", data: fc, cluster: true, clusterRadius: 42, clusterMaxZoom: 9 });
        m.addLayer({ id: "ships-cluster", type: "circle", source: "ships-src", filter: ["has", "point_count"], paint: { "circle-color": "rgba(200,40,40,0.55)", "circle-radius": ["step", ["get", "point_count"], 12, 50, 18, 300, 26], "circle-stroke-width": 1, "circle-stroke-color": "rgba(255,255,255,0.6)" } });
        m.addLayer({ id: "ships-count", type: "symbol", source: "ships-src", filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12 }, paint: { "text-color": "#fff" } });
        m.addLayer({ id: "ships-pt", type: "circle", source: "ships-src", filter: ["!", ["has", "point_count"]], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3, 11, 5], "circle-color": ["match", ["get", "cls"], "軍事", "#e53935", "油輪/化學船", "#fb8c00", "貨船", "#1e88e5", "漁船", "#43a047", "客船", "#8e24aa", "拖船作業", "#00897b", "#b0bec5"], "circle-opacity": 0.9, "circle-stroke-width": 0.6, "circle-stroke-color": "rgba(0,0,0,0.5)" } });
        m.on("click", "ships-cluster", (e) => { const f = m.queryRenderedFeatures(e.point, { layers: ["ships-cluster"] })[0]; const cid = f.properties!.cluster_id; (m.getSource("ships-src") as any).getClusterExpansionZoom(cid, (err: any, z: number) => { if (!err) m.easeTo({ center: (f.geometry as any).coordinates, zoom: z }); }); });
        m.on("click", "ships-pt", (e) => { const f = e.features?.[0]; if (!f) return; const p = f.properties as any; const html = `<div class="qpop"><b>${p.name}</b>　${p.cls}<br/>MMSI ${p.mmsi}<br/>航速 ${p.sog ?? "-"} kn</div>`; shipPopRef.current?.remove(); shipPopRef.current = new mapboxgl.Popup({ offset: 10, className: "hover-tip" }).setLngLat((f.geometry as any).coordinates).setHTML(html).addTo(m); });
        m.on("mouseenter", "ships-pt", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "ships-pt", () => { m.getCanvas().style.cursor = ""; });
      }
      for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
      setShipsOn(true); setShipsInfo(d.count ? `中國籍船舶 ${d.count} 艘(近3小時)` : "尚無資料(收集器每10分鐘更新)");
    } catch { setShipsInfo("船舶讀取失敗"); }
  }
  // 近 7 天航跡 + 異常標記(非同步載入，資料由收集器逐批累積)
  async function loadShipTracks(m: mapboxgl.Map) {
    try {
      const d = await fetch("/api/ships?action=tracks&t=" + Math.floor(Date.now() / 60000)).then((r) => r.json());
      if (!d.ok || !(d.tracks || []).length) return; // 尚未累積出軌跡
      const feats = d.tracks.filter((v: any) => (v.points || []).length >= 2).map((v: any) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: v.points.map((p: any) => [p[0], p[1]]) },
        properties: { mmsi: v.mmsi, name: v.name || v.mmsi, cls: v.cls || "其他", flag: v.flag, reason: v.reason, pathKm: v.pathKm, dispKm: v.dispKm, hours: v.hours },
      }));
      const fc = { type: "FeatureCollection", features: feats } as any;
      if (m.getSource("ship-trk-src")) (m.getSource("ship-trk-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        const beforeId = m.getLayer("ships-cluster") ? "ships-cluster" : undefined;
        m.addSource("ship-trk-src", { type: "geojson", data: fc });
        const colorByFlag = ["match", ["get", "flag"], "detour", "#ff1744", "loiter", "#ffea00", "#00e5ff"];
        m.addLayer({ id: "ship-trk-line", type: "line", source: "ship-trk-src", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": colorByFlag as any, "line-width": ["match", ["get", "flag"], "normal", 2, 3], "line-opacity": ["match", ["get", "flag"], "normal", 0.9, 1] } }, beforeId);
        m.addLayer({ id: "ship-trk-warn", type: "line", source: "ship-trk-src", filter: ["!=", ["get", "flag"], "normal"], paint: { "line-color": ["match", ["get", "flag"], "detour", "#ff5252", "#ffca28"], "line-width": 6, "line-opacity": 0.18, "line-blur": 2 } }, beforeId);
        const flagTxt = (f: string) => f === "detour" ? "⚠ 繞行/折返" : f === "loiter" ? "⚠ 逗留" : "正常航行";
        m.on("click", "ship-trk-line", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          shipPopRef.current?.remove();
          shipPopRef.current = new mapboxgl.Popup({ offset: 8, className: "hover-tip" }).setLngLat(e.lngLat).setHTML(
            `<div class="qpop"><b>${p.name}</b>　${p.cls}<br/>MMSI ${p.mmsi}<br/>${flagTxt(p.flag)}<br/><span style="opacity:.8">${p.reason}</span><br/><span style="opacity:.6;font-size:11px">近 7 天航跡 ${p.pathKm}km／淨位移 ${p.dispKm}km／${p.hours}h</span></div>`
          ).addTo(m);
        });
        m.on("mouseenter", "ship-trk-line", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "ship-trk-line", () => { m.getCanvas().style.cursor = ""; });
      }
      if (shipsOn || true) for (const id of ["ship-trk-warn", "ship-trk-line"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
      const c = d.counts || {};
      const extra = (c.loiter || c.detour) ? `，異常 ${(c.loiter || 0) + (c.detour || 0)} 艘(逗留 ${c.loiter || 0}／繞行 ${c.detour || 0})` : "";
      setShipsInfo((s) => (s ? s.replace(/，異常.*$/, "") : s) + `　航跡 ${d.vessels} 艘${extra}`);
    } catch {}
  }
  // ===== 河流圖層(用 Mapbox 底圖 waterway，常態畫線 + 河名 + hover 高亮整條) =====
  function toggleRivers() {
    const m = mapRef.current; if (!m) return;
    const on = !riversOn;
    const ids = ["rivers-line", "rivers-hl", "rivers-label"];
    if (!on) { for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); riverPopRef.current?.remove(); setRiversOn(false); return; }
    if (!m.getLayer("rivers-line")) {
      const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
      m.addLayer({ id: "rivers-line", type: "line", source: "composite", "source-layer": "waterway", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#4aa3df", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 11, 2], "line-opacity": 0.85 } }, beforeId);
      m.addLayer({ id: "rivers-hl", type: "line", source: "composite", "source-layer": "waterway", filter: ["==", ["get", "name"], "___none___"], paint: { "line-color": "#9fe6ff", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2.5, 11, 6], "line-opacity": 0.95, "line-blur": 0.5 } }, beforeId);
      m.addLayer({ id: "rivers-label", type: "symbol", source: "composite", "source-layer": "waterway", layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name_zh-Hant"], ["get", "name"]], "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 13, 13], "text-allow-overlap": true, "text-ignore-placement": true, "symbol-spacing": 400 }, paint: { "text-color": "#cdeeff", "text-halo-color": "#06203f", "text-halo-width": 1.6 } });
      m.on("mousemove", "rivers-line", (e) => {
        const f = e.features?.[0]; if (!f) return; const nm = (f.properties as any)?.name; if (!nm) return;
        // 只高亮該名稱指稱的河段(同名=完整流域；不同名的上下游不受影響)
        m.setFilter("rivers-hl", ["==", ["get", "name"], nm]);
        riverPopRef.current?.remove();
        riverPopRef.current = new mapboxgl.Popup({ closeButton: false, offset: 8, className: "hover-tip" }).setLngLat(e.lngLat).setText(nm).addTo(m);
      });
      m.on("mouseleave", "rivers-line", () => { m.setFilter("rivers-hl", ["==", ["get", "name"], "___none___"]); riverPopRef.current?.remove(); });
    }
    for (const id of ids) m.setLayoutProperty(id, "visibility", "visible");
    setRiversOn(true);
  }
  // 河流循環：關 → 河流 → 河流+即時水位高度(跟底圖同邏輯)
  function cycleRiver() {
    const next = (riverModeRef.current + 1) % 3;
    riverModeRef.current = next; setRiverMode(next);
    const wantRivers = next >= 1, wantWall = next === 2;
    if (wantRivers !== riversOn) toggleRivers();
    if (wantWall !== wallOn) toggleWaterWall();
  }
  // 一鍵開/關所有圖層
  function toggleAllLayers() {
    const on = !allLayersOn; setAllLayersOn(on);
    const w = (cur: boolean, fn: () => void) => { if (cur !== on) fn(); };
    w(rainOn, toggleRain); w(quakeOn, toggleQuake); w(tempOn, toggleTemp); w(staOn, toggleSta);
    w(typhoonOn, toggleTyphoon); w(oceanOn, toggleOcean); w(shipsOn, toggleShips);
    w(peaksOn, togglePeaks); w(lakeOn, toggleLake); w(gzOn, toggleGrayZone);
    if (on && riverModeRef.current === 0) cycleRiver();
    if (!on && riverModeRef.current > 0) { if (wallOn) toggleWaterWall(); if (riversOn) toggleRivers(); riverModeRef.current = 0; setRiverMode(0); }
  }
  // ===== 衛星空照(NASA GIBS 每日近即時真彩) =====
  function toggleSat() {
    const m = mapRef.current; if (!m) return;
    const on = !satOn;
    if (!on) { if (m.getLayer("gibs-sat")) m.setLayoutProperty("gibs-sat", "visibility", "none"); setSatOn(false); return; }
    if (!m.getLayer("gibs-sat")) {
      const d = new Date(Date.now() - 24 * 3600 * 1000); // 取昨日(當日常未處理完)
      const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      m.addSource("gibs-sat", { type: "raster", tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`], tileSize: 256, maxzoom: 9, attribution: "NASA EOSDIS GIBS" });
      const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
      m.addLayer({ id: "gibs-sat", type: "raster", source: "gibs-sat", paint: { "raster-opacity": 0.85 } }, beforeId);
    }
    m.setLayoutProperty("gibs-sat", "visibility", "visible");
    setSatOn(true);
  }
  // ===== 山岳圖層(百岳/高山，OSM 名稱+標高) =====
  function applyPeakFilter() {
    const m = mapRef.current; if (!m || !m.getLayer("peaks-pt")) return;
    const sel = [...peakClsRef.current];
    const f: any = sel.length ? ["match", ["get", "clsg"], sel, true, false] : ["==", ["get", "clsg"], "___none___"];
    m.setFilter("peaks-pt", f); m.setFilter("peaks-label", f);
  }
  function togglePeakCls(k: string) {
    const s = new Set(peakClsRef.current); if (s.has(k)) s.delete(k); else s.add(k);
    peakClsRef.current = s; setPeakCls(new Set(s)); applyPeakFilter();
  }
  async function togglePeaks() {
    const m = mapRef.current; if (!m) return;
    const on = !peaksOn;
    const ids = ["peaks-pt", "peaks-label", "peaks-hl"];
    if (!on) { for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); peakPopRef.current?.remove(); setPeaksOn(false); setPeaksInfo(""); return; }
    try {
      setPeaksInfo("山岳載入中…");
      const d = peaksDataRef.current || await fetch("/api/peaks?min=1000").then((r) => r.json());
      if (!d.ok || !(d.peaks || []).length) { setPeaksInfo("山岳資料暫時無法取得"); return; }
      peaksDataRef.current = d;
      const fc = { type: "FeatureCollection", features: d.peaks.map((p: any) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] }, properties: { name: p.name, ele: p.ele, tier: p.tier, clsg: p.cls2 || "一般" } })) } as any;
      if (m.getSource("peaks-src")) (m.getSource("peaks-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("peaks-src", { type: "geojson", data: fc, generateId: true });
        const colorByCls = ["match", ["get", "clsg"], "百岳", "#ffca28", "小百岳", "#66bb6a", "#90a4ae"];
        m.addLayer({ id: "peaks-hl", type: "circle", source: "peaks-src", filter: ["==", ["get", "name"], "___none___"], paint: { "circle-radius": 12, "circle-color": "rgba(255,255,255,0.25)", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
        m.addLayer({ id: "peaks-pt", type: "circle", source: "peaks-src", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, ["match", ["get", "clsg"], "一般", 2, 3.5], 11, ["match", ["get", "clsg"], "一般", 3.5, 6]], "circle-color": colorByCls as any, "circle-stroke-width": 0.7, "circle-stroke-color": "rgba(0,0,0,0.55)", "circle-opacity": 0.95 } });
        m.addLayer({ id: "peaks-label", type: "symbol", source: "peaks-src", minzoom: 7, layout: { "text-field": ["get", "name"], "text-size": ["interpolate", ["linear"], ["zoom"], 7, 9, 12, 13], "text-offset": [0, 0.9], "text-anchor": "top", "text-allow-overlap": false, "symbol-sort-key": ["-", 4000, ["get", "ele"]] }, paint: { "text-color": "#fff3c4", "text-halo-color": "#2b2300", "text-halo-width": 1.4 } });
        m.on("mousemove", "peaks-pt", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          m.setFilter("peaks-hl", ["==", ["get", "name"], p.name]);
          m.getCanvas().style.cursor = "pointer";
          peakPopRef.current?.remove();
          const tag = p.clsg === "一般" ? p.tier : p.clsg;
          peakPopRef.current = new mapboxgl.Popup({ closeButton: false, offset: 10, className: "hover-tip" }).setLngLat((f.geometry as any).coordinates).setHTML(`<div class="qpop"><b>${p.name}</b>　<span style="opacity:.85">${tag}</span><br/>標高 ${p.ele} m</div>`).addTo(m);
        });
        m.on("mouseleave", "peaks-pt", () => { m.setFilter("peaks-hl", ["==", ["get", "name"], "___none___"]); m.getCanvas().style.cursor = ""; peakPopRef.current?.remove(); });
      }
      applyPeakFilter();
      for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
      setPeaksInfo(`百岳 ${d.baiyue ?? 0}／小百岳 ${d.xiaobai ?? 0}／一般山岳 ${d.peaks.length - (d.baiyue ?? 0) - (d.xiaobai ?? 0)}`);
      setPeaksOn(true);
    } catch { setPeaksInfo("山岳資料載入失敗"); }
  }
  // ===== 堰塞湖監測(林保署 國有林堰塞湖監測系統) =====
  // 位置為各溪概略座標(端點未提供座標)，僅供定位參考，詳情連官方專區
  function lakeCoord(name: string): [number, number] {
    const RIV: Record<string, [number, number]> = {
      萬里溪: [121.34, 23.85], 馬太鞍溪: [121.2955, 23.6995], 泰崗溪: [121.31, 24.53],
      木瓜溪: [121.45, 23.98], 樂樂溪: [121.15, 23.40], 豐坪溪: [121.22, 23.47],
      五十溪: [121.55, 24.60], 大南溪: [121.00, 22.78], 大曼溪: [121.33, 24.65],
      清水溪: [120.72, 23.66], 加走寮溪: [120.72, 23.66],
    };
    for (const k in RIV) if (name.includes(k)) return RIV[k];
    const CTY: Record<string, [number, number]> = { 花蓮: [121.40, 23.80], 南投: [120.90, 23.90], 新竹: [121.15, 24.60], 宜蘭: [121.60, 24.55], 台東: [121.00, 22.90], 台中: [120.95, 24.20], 高雄: [120.75, 23.10], 屏東: [120.70, 22.70] };
    for (const k in CTY) if (name.includes(k)) return CTY[k];
    return [121.0, 23.7];
  }
  // 真實湖體幾何(由 AWS 30m DEM 區域成長至官方面積推得，反算水位與官方吻合)
  const LAKE_GEOM: Record<string, any> = {
    馬太鞍溪: {
      // 最大範圍 ~59.7 公頃(模型水面約 1104m，官方溢流前約 1110m)
      max: [[121.2917,23.7023],[121.2927,23.702],[121.2937,23.7016],[121.2948,23.7013],[121.2958,23.702],[121.296,23.7014],[121.2956,23.7005],[121.2954,23.6995],[121.2951,23.6986],[121.2949,23.6976],[121.2946,23.6967],[121.294,23.696],[121.293,23.6956],[121.2919,23.6952],[121.291,23.6946],[121.29,23.6943],[121.2889,23.6942],[121.2879,23.6943],[121.2869,23.6944],[121.2861,23.6937],[121.2856,23.6928],[121.2848,23.6919],[121.2838,23.6911],[121.2831,23.6913],[121.2834,23.6923],[121.284,23.6932],[121.2846,23.6941],[121.2848,23.695],[121.2858,23.6959],[121.2865,23.6967],[121.2876,23.6969],[121.2886,23.6975],[121.2888,23.6985],[121.2896,23.699],[121.2906,23.6995],[121.2913,23.7005],[121.2914,23.7014],[121.2916,23.7023],[121.2917,23.7023]],
      // 目前範圍 ~12.6 公頃(2025/10/23，水面約 988m，官方約 1010m)
      cur: [[121.2956,23.7005],[121.2955,23.7001],[121.2955,23.6997],[121.2953,23.6992],[121.2952,23.6987],[121.295,23.6983],[121.2949,23.6978],[121.2944,23.6976],[121.2939,23.6977],[121.2934,23.6977],[121.2929,23.6977],[121.2924,23.6975],[121.2918,23.6972],[121.2913,23.6968],[121.2908,23.6964],[121.2903,23.6963],[121.2898,23.6962],[121.2894,23.6963],[121.2896,23.6968],[121.29,23.6972],[121.2904,23.6977],[121.2908,23.6982],[121.2912,23.6987],[121.2916,23.699],[121.2921,23.699],[121.2926,23.6994],[121.2931,23.6993],[121.2936,23.6995],[121.2941,23.6998],[121.2946,23.7001],[121.2951,23.7005],[121.2956,23.7005],[121.2956,23.7005]],
      dam: [[121.295,23.6978],[121.296,23.7011]],
      level: 1104, crest: 1120,
      desc: "馬太鞍溪堰塞湖(花蓮萬榮)：2025/7 颱風誘發崩塌形成，9/4 滿水位約 1110m、湖面最大約 59.7 公頃、壩前水深逾 200m；9 月溢流致光復重災，10/23 縮至約 12.6 公頃。深藍=目前殘留湖面，淺藍=最大淹沒範圍，紅線=崩塌壩體。範圍由 30m DEM 淹沒推估(反算水位與官方吻合)。",
    },
    萬里溪: {
      max: [[121.3444,23.8555],[121.3455,23.8551],[121.346,23.8542],[121.3467,23.8536],[121.347,23.853],[121.347,23.852],[121.347,23.8511],[121.347,23.8501],[121.347,23.8492],[121.3463,23.8498],[121.3453,23.8508],[121.3443,23.8511],[121.3432,23.8504],[121.3422,23.8501],[121.3415,23.8492],[121.3405,23.8486],[121.3394,23.8486],[121.3386,23.849],[121.3379,23.8498],[121.3377,23.8508],[121.3386,23.8512],[121.3394,23.852],[121.3401,23.853],[121.341,23.8536],[121.342,23.8542],[121.3431,23.8547],[121.3439,23.8551],[121.3444,23.8555]],
      cur: [[121.3444,23.8555],[121.3455,23.8551],[121.346,23.8542],[121.3467,23.8536],[121.347,23.853],[121.347,23.852],[121.347,23.8511],[121.347,23.8501],[121.347,23.8492],[121.3463,23.8498],[121.3453,23.8508],[121.3443,23.8511],[121.3432,23.8504],[121.3422,23.8501],[121.3415,23.8492],[121.3405,23.8486],[121.3394,23.8486],[121.3386,23.849],[121.3379,23.8498],[121.3377,23.8508],[121.3386,23.8512],[121.3394,23.852],[121.3401,23.853],[121.341,23.8536],[121.342,23.8542],[121.3431,23.8547],[121.3439,23.8551],[121.3444,23.8555]],
      dam: [[121.3477,23.8488],[121.3477,23.8558]],
      level: 1066, crest: 1086,
      desc: "萬里溪堰塞湖(花蓮萬榮，2026/6 形成)：位萬里溪上游林田山 96/82 林班交界、距七彩湖約 7km。壩高約 114m、溢流口 1086m、目前水位約 1066.4m；崩塌約 45 公頃、最大蓄水約 510 萬 m³，推估約 7/12 滿水位。範圍由 30m DEM 淹沒至官方水面高程 1066m 推得(面積約 44 公頃與官方約 45 公頃吻合)。紅線=崩塌壩體。",
    },
  };
  // 尚無公開精確座標/岸線者：以真實屬性呈現(點位為概略)
  const LAKE_DESC: Record<string, string> = {
    萬里溪: "萬里溪堰塞湖(花蓮萬榮，2026/6 形成)：位萬里溪上游林田山事業區 96/82 林班交界，距七彩湖僅約 7km。壩體高約 114m、溢流口高程 1086m、目前水位約 1066.4m；崩塌面積約 45 公頃，最大蓄水量約 510 萬 m³(目前約 243 萬)，推估約 7/12 達滿水位。地形險峻難進入，以監測預警為主。(位置為概略，官方未公開精確座標)",
    泰崗溪: "泰崗溪堰塞湖(新竹尖石，2024/10 康芮颱風形成)：位泰崗溪上游、距司馬庫斯大橋上游約 10km。面積僅約 1.3 公頃、蓄水約 4.8 萬 m³(約 20 座泳池)、壩高約 10m，現況穩定溢流、對下游聚落無潰壩威脅。(規模過小，僅標概略點位)",
  };
  async function toggleLake() {
    const m = mapRef.current; if (!m) return;
    const on = !lakeOn;
    const ids = ["lake-max-fill", "lake-max-line", "lake-cur-fill", "lake-damband", "lake-dam", "lake-damtop", "lake-ring", "lake-pt", "lake-label"];
    if (!on) { for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); setDeckLayers("lake", []); lakePopRef.current?.remove(); setLakeOn(false); setLakeInfo(""); return; }
    try {
      const d = await fetch("/api/live?ds=barrierlake&t=" + Date.now()).then((r) => r.json());
      if (!d.ok || !(d.lakes || []).length) { setLakeInfo("堰塞湖資料暫時無法取得"); return; }
      const OFFICIAL = "https://qlakenew.forest.gov.tw/FarmlandQlakenew/LandslideDam";
      const fc = { type: "FeatureCollection", features: d.lakes.map((l: any) => {
        const [lng, lat] = lakeCoord(l.name || "");
        const dk = Object.keys(LAKE_DESC).find((k) => (l.name || "").includes(k));
        return { type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { name: l.name, alert: l.alert || "gray", warn: l.warn ? 1 : 0, rainalert: l.rainalert || "無", upd: l.upd || "", desc: dk ? LAKE_DESC[dk] : "" } };
      }) } as any;
      const colorByAlert = ["match", ["get", "alert"], "red", "#e53935", "orange", "#fb8c00", "yellow", "#ffca28", "#78909c"];
      if (m.getSource("lake-src")) (m.getSource("lake-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("lake-src", { type: "geojson", data: fc, generateId: true });
        m.addLayer({ id: "lake-ring", type: "circle", source: "lake-src", filter: ["!=", ["get", "alert"], "gray"], paint: { "circle-radius": 16, "circle-color": "rgba(229,57,53,0.18)", "circle-stroke-color": "#e53935", "circle-stroke-width": 1.5 } });
        m.addLayer({ id: "lake-pt", type: "circle", source: "lake-src", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 6, 11, 11], "circle-color": colorByAlert as any, "circle-stroke-width": 1.6, "circle-stroke-color": "#fff", "circle-opacity": 0.95 } });
        m.addLayer({ id: "lake-label", type: "symbol", source: "lake-src", layout: { "text-field": ["get", "name"], "text-size": ["interpolate", ["linear"], ["zoom"], 6, 10, 11, 13], "text-offset": [0, 1.1], "text-anchor": "top", "text-allow-overlap": false }, paint: { "text-color": "#e3f2fd", "text-halo-color": "#0d1b2a", "text-halo-width": 1.4 } });
        const alertTxt = (a: string) => a === "red" ? "紅色警戒" : a === "orange" ? "橙色警戒" : a === "yellow" ? "黃色警戒" : "監測中(無警戒)";
        m.on("click", "lake-pt", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          lakePopRef.current?.remove();
          const descHtml = p.desc ? `<br/><span style="opacity:.9">${p.desc}</span>` : "";
          lakePopRef.current = new mapboxgl.Popup({ offset: 12, className: "hover-tip", maxWidth: "320px" }).setLngLat((f.geometry as any).coordinates).setHTML(
            `<div class="qpop"><b>${p.name}</b><br/>狀態：${alertTxt(p.alert)}<br/>雨量警戒：${p.rainalert}${descHtml}<br/><span style="opacity:.6;font-size:11px">詳情見<a href="${OFFICIAL}" target="_blank" rel="noopener" style="color:#8ecbff">官方監測系統</a></span></div>`
          ).addTo(m);
        });
        m.on("mouseenter", "lake-pt", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "lake-pt", () => { m.getCanvas().style.cursor = ""; });
      }
      // 真實湖體(有 DEM 幾何者)：最大範圍/目前湖面/壩體
      const polyFeats: any[] = [], damFeats: any[] = [], deckWater: any[] = [], deckDam: any[] = [];
      for (const l of d.lakes) {
        const g = Object.keys(LAKE_GEOM).find((k) => (l.name || "").includes(k));
        if (!g) continue; const geom = LAKE_GEOM[g];
        polyFeats.push({ type: "Feature", properties: { kind: "max", name: l.name, desc: geom.desc }, geometry: { type: "Polygon", coordinates: [geom.max] } });
        polyFeats.push({ type: "Feature", properties: { kind: "cur", name: l.name, desc: geom.desc }, geometry: { type: "Polygon", coordinates: [geom.cur] } });
        damFeats.push({ type: "Feature", properties: { name: l.name, part: "toe" }, geometry: { type: "LineString", coordinates: geom.dam } });
        // 壩頂：往下游(東)平移一小段的平行線，表示壩體寬度與壩頂
        const crest = (geom.dam as number[][]).map((c) => [c[0] + 0.0016, c[1]]);
        damFeats.push({ type: "Feature", properties: { name: l.name, part: "crest" }, geometry: { type: "LineString", coordinates: crest } });
        const damBody = [[...(geom.dam as number[][]), ...crest.slice().reverse(), geom.dam[0]]];
        damFeats.push({ type: "Feature", properties: { name: l.name, part: "body" }, geometry: { type: "Polygon", coordinates: damBody } });
        // 3D 實體：水面填到水位高程、壩體填到壩頂高程
        if (geom.level) deckWater.push({ polygon: geom.max, elev: geom.level, name: l.name });
        if (geom.crest) deckDam.push({ polygon: damBody[0], elev: geom.crest, name: l.name });
      }
      const polyFc = { type: "FeatureCollection", features: polyFeats } as any;
      const damFc = { type: "FeatureCollection", features: damFeats } as any;
      if (m.getSource("lake-poly-src")) (m.getSource("lake-poly-src") as mapboxgl.GeoJSONSource).setData(polyFc);
      else if (polyFeats.length) {
        m.addSource("lake-poly-src", { type: "geojson", data: polyFc });
        m.addSource("lake-dam-src", { type: "geojson", data: damFc });
        m.addLayer({ id: "lake-max-fill", type: "fill", source: "lake-poly-src", filter: ["==", ["get", "kind"], "max"], paint: { "fill-color": "#2f6fd6", "fill-opacity": 0.12 } });
        m.addLayer({ id: "lake-max-line", type: "line", source: "lake-poly-src", filter: ["==", ["get", "kind"], "max"], paint: { "line-color": "#9fd0ff", "line-width": 1.2, "line-dasharray": [2, 1.5], "line-opacity": 0.7 } });
        m.addLayer({ id: "lake-cur-fill", type: "fill", source: "lake-poly-src", filter: ["==", ["get", "kind"], "cur"], paint: { "fill-color": "#0a337e", "fill-opacity": 0.15 } });
        m.addLayer({ id: "lake-damband", type: "fill", source: "lake-dam-src", filter: ["==", ["get", "part"], "body"], paint: { "fill-color": "#6d4c41", "fill-opacity": 0.25 } });
        m.addLayer({ id: "lake-dam", type: "line", source: "lake-dam-src", filter: ["==", ["get", "part"], "toe"], paint: { "line-color": "#c62828", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 5], "line-opacity": 0.95 } });
        m.addLayer({ id: "lake-damtop", type: "line", source: "lake-dam-src", filter: ["==", ["get", "part"], "crest"], paint: { "line-color": "#ffe0b2", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 5], "line-opacity": 0.95 } });
        m.on("click", "lake-max-fill", (e) => { const p = e.features?.[0]?.properties as any; if (!p) return; lakePopRef.current?.remove(); lakePopRef.current = new mapboxgl.Popup({ offset: 6, className: "hover-tip", maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(`<div class="qpop"><b>${p.name}</b><br/><span style="opacity:.88">${p.desc}</span></div>`).addTo(m); });
        m.on("mouseenter", "lake-max-fill", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "lake-max-fill", () => { m.getCanvas().style.cursor = ""; });
      } else if (m.getSource("lake-dam-src")) (m.getSource("lake-dam-src") as mapboxgl.GeoJSONSource).setData(damFc);
      // 3D 實體水面與實心壩體(絕對高程；隨地形正確遮擋)
      setDeckLayers("lake", [
        new SolidPolygonLayer({ id: "lake-water-3d", data: deckWater, getPolygon: (d: any) => d.polygon, extruded: true, getElevation: (d: any) => d.elev, getFillColor: [26, 110, 214, 205], material: false, pickable: false }),
        new SolidPolygonLayer({ id: "lake-dam-3d", data: deckDam, getPolygon: (d: any) => d.polygon, extruded: true, getElevation: (d: any) => d.elev, getFillColor: [120, 74, 52, 255], material: false, pickable: false }),
      ]);
      for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
      const nWarn = d.lakes.filter((l: any) => (l.alert || "gray") !== "gray").length;
      setLakeInfo(`監測中堰塞湖 ${d.lakes.length} 處${nWarn ? `，警戒 ${nWarn} 處` : "，目前均無警戒"}`);
      setLakeOn(true);
    } catch { setLakeInfo("堰塞湖資料載入失敗"); }
  }
  // ===== 中國入侵/灰色地帶 時間軸密度圖層 =====
  // 月索引：2020-09 = 0
  function monthIdx(dateStr: string) { const d = new Date(dateStr); return (d.getUTCFullYear() - 2020) * 12 + d.getUTCMonth() - 8; }
  function idxLabel(idx: number) { const y = 2020 + Math.floor((idx + 8) / 12); const mo = ((idx + 8) % 12) + 1; return `${y}/${String(mo).padStart(2, "0")}`; }
  const GZ_COLOR = ["match", ["get", "type"], "air", "#ff6d00", "drill", "#d50000", "coastguard", "#ff9100", "cable", "#ffd600", "sea", "#2962ff", "survey", "#aa00ff", "#bbbbbb"];
  const GZ_TYPE_TXT: Record<string, string> = { air: "共機空域侵擾", drill: "圍台軍演/軍事威懾", coastguard: "海警灰色地帶", cable: "海纜破壞", sea: "共艦動態", survey: "科研測繪" };
  // 依類型的小圖示(飛機/軍艦/海警船/海纜船)
  const GZ_ICONS: Record<string, string> = {
    "ic-plane": `<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24'><path fill='%23ff8f00' stroke='%23000' stroke-width='0.6' d='M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z'/></svg>`,
    "ic-warship": `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='20' viewBox='0 0 28 20'><g stroke='%23000' stroke-width='0.6'><path fill='%23e53935' d='M1 13 H27 L23 18 H5 Z'/><rect fill='%23c62828' x='9' y='7' width='9' height='6'/><rect fill='%23c62828' x='13' y='2' width='2' height='5'/><path fill='none' stroke='%23c62828' stroke-width='1' d='M15 4 L21 6'/></g></svg>`,
    "ic-patrol": `<svg xmlns='http://www.w3.org/2000/svg' width='26' height='18' viewBox='0 0 26 18'><g stroke='%23000' stroke-width='0.6'><path fill='%2300b0ff' d='M2 11 H24 L20 16 H6 Z'/><path fill='%230091ea' d='M8 6 H17 L19 11 H8 Z'/></g></svg>`,
    "ic-cable": `<svg xmlns='http://www.w3.org/2000/svg' width='26' height='24' viewBox='0 0 26 24'><g stroke='%23000' stroke-width='0.6'><path fill='%23ffd600' d='M2 10 H24 L20 15 H6 Z'/><rect fill='%23ffab00' x='8' y='5' width='9' height='5'/></g><path fill='none' stroke='%23ffd600' stroke-width='1.6' d='M13 15 V20 Q13 22.5 15.5 22 Q17 21.5 16 20'/></svg>`,
  };
  function gzIconFor(type: string) { return type === "air" ? "ic-plane" : (type === "sea" || type === "drill") ? "ic-warship" : type === "cable" ? "ic-cable" : "ic-patrol"; }
  function loadImg(svg: string): Promise<HTMLImageElement | null> { return new Promise((res) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.replace(/%23/g, "#")).replace(/#/g, "%23"); }); }
  async function ensureGzIcons(m: mapboxgl.Map) {
    for (const [name, svg] of Object.entries(GZ_ICONS)) { if (m.hasImage(name)) continue; const img = await loadImg(svg); if (img && !m.hasImage(name)) m.addImage(name, img); }
  }
  function renderIncursions(fromIdx: number, toIdx: number) {
    const m = mapRef.current; if (!m) return;
    const data = gzDataRef.current || [];
    const feats = data.filter((e) => { const i = monthIdx(e.ev_date); return i >= fromIdx && i <= toIdx && typeof e.lng === "number"; })
      .map((e) => ({ type: "Feature", geometry: { type: "Point", coordinates: [e.lng, e.lat] }, properties: { type: e.type, cnt: e.cnt || 1, detail: e.detail, source: e.source, url: e.url || "", zone: e.zone, date: e.ev_date } }));
    // 疊在同一座標的事件拆成獨立單點(以螺旋散開)，避免糊成一團
    const groups: Record<string, any[]> = {};
    for (const f of feats) { const k = (f.geometry.coordinates as number[]).map((c) => c.toFixed(3)).join(","); (groups[k] || (groups[k] = [])).push(f); }
    for (const k in groups) {
      const arr = groups[k]; if (arr.length < 2) continue;
      const [bx, by] = arr[0].geometry.coordinates as number[];
      arr.forEach((f, i) => { const ring = Math.floor(i / 10), ang = (i % 10) / 10 * 2 * Math.PI + ring * 0.6; const r = 0.02 + ring * 0.016; f.geometry.coordinates = [bx + r * Math.cos(ang) / Math.max(0.3, Math.cos(by * Math.PI / 180)), by + r * Math.sin(ang)]; });
    }
    const fc = { type: "FeatureCollection", features: feats } as any;
    if (m.getSource("gz-src")) (m.getSource("gz-src") as mapboxgl.GeoJSONSource).setData(fc);
    const total = feats.reduce((s: number, f: any) => s + (f.properties.cnt || 1), 0);
    setGzInfo(`${idxLabel(fromIdx)}–${idxLabel(toIdx)}：${feats.length} 起事件、累計 ${total} 架次/艘次/次`);
  }
  async function toggleGrayZone() {
    const m = mapRef.current; if (!m) return;
    const on = !gzOn;
    const ids = ["gz-pt"];
    if (!on) { for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); gzPopRef.current?.remove(); setGzOn(false); setGzInfo(""); return; }
    try {
      const d = await fetch("/api/intel?action=read&t=" + Date.now()).then((r) => r.json());
      if (!d.ok || !(d.incursions || []).length) { setGzInfo("入侵資料暫時無法取得(可能需先 seed)"); return; }
      gzDataRef.current = d.incursions;
      const maxIdx = Math.max(...d.incursions.map((e: any) => monthIdx(e.ev_date)), monthIdx(new Date().toISOString()));
      setGzMax(maxIdx); setGzFrom(0); setGzTo(maxIdx);
      if (!m.getSource("gz-src")) {
        m.addSource("gz-src", { type: "geojson", data: { type: "FeatureCollection", features: [] } as any });
        await ensureGzIcons(m);
        m.addLayer({ id: "gz-pt", type: "symbol", source: "gz-src", layout: { "icon-image": ["match", ["get", "type"], "air", "ic-plane", "sea", "ic-warship", "drill", "ic-warship", "cable", "ic-cable", "ic-patrol"], "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 8, 0.75, 12, 1], "icon-allow-overlap": true, "icon-ignore-placement": true } });
        m.on("click", "gz-pt", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          gzPopRef.current?.remove();
          const link = p.url ? `<br/><a href="${p.url}" target="_blank" rel="noopener" style="color:#8ecbff">來源連結 ↗</a>` : "";
          gzPopRef.current = new mapboxgl.Popup({ offset: 10, className: "hover-tip", maxWidth: "300px" }).setLngLat((f.geometry as any).coordinates).setHTML(`<div class="qpop"><b>${p.date}　${GZ_TYPE_TXT[p.type] || p.type}</b>（${p.zone}）<br/><span style="opacity:.9">${p.detail}</span><br/><span style="opacity:.6;font-size:11px">來源：${p.source}${link}</span></div>`).addTo(m);
        });
        m.on("mouseenter", "gz-pt", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "gz-pt", () => { m.getCanvas().style.cursor = ""; });
      }
      for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
      renderIncursions(0, maxIdx);
      setGzOn(true);
    } catch { setGzInfo("入侵資料載入失敗"); }
  }
  // ===== 河川水位立體水牆(鋪在 OSM 河道幾何上) =====
  function wallRefOf(s: any) { return (typeof s.avg_level === "number" && s.cnt_level >= 6) ? s.avg_level : (s.warn3 ?? s.warn2 ?? s.warn1 ?? s.cur_level); }
  function renderWall(exag: number, widthMult: number) {
    const m = mapRef.current; if (!m) return;
    const st = wallDataRef.current, geo = riverGeoRef.current || [];
    const W = 0.0016 * widthMult, CAP = 100000, R = 0.02, BASE = 500, STEP = 3;
    const ribbon = (a: number[], b: number[]) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const len = Math.hypot(dx, dy) || 1e-9; const nx = -dy / len * W, ny = dx / len * W; return [[[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny], [a[0] + nx, a[1] + ny]]]; };
    // 由「附近站點」反距離加權在河線某點內插高度(空間鄰近，非河名)
    const R2 = 0.03; // 判定河段「有站在附近」的半徑
    const nearSta = (pt: number[]) => { for (const s of st) { const dx = Math.abs(s.lng - pt[0]), dy = Math.abs(s.lat - pt[1]); if (dx < R2 && dy < R2 && Math.hypot(dx, dy) < R2) return true; } return false; };
    // IDW 內插:不設硬截斷,長空檔中間的點主要由前後兩個最近站決定(沿河補牆)
    const idwAll = (pt: number[]) => { let ws = 0, cur = 0, ref = 0; for (const s of st) { const d = Math.hypot(s.lng - pt[0], s.lat - pt[1]); const w = 1 / (d * d + 1e-6); ws += w; cur += w * s.cur_level; ref += w * wallRefOf(s); } return { cur: cur / ws, ref: ref / ws }; };
    const baseF: any[] = [], topF: any[] = [], ptF: any[] = [];
    for (const s of st) ptF.push({ type: "Feature", properties: { name: s.name, river: s.river, cur: s.cur_level, avg: s.avg_level, w1: s.warn1, w2: s.warn2, w3: s.warn3, t: s.cur_time || "" }, geometry: { type: "Point", coordinates: [s.lng, s.lat] } });
    for (const river of geo) {
      const L = river.coords; if (!L || L.length < 2) continue;
      // bbox 預剪:整條河外接框附近都沒站就跳過(大幅省算)
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const p of L) { if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0]; if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1]; }
      let hasSta = false;
      for (const s of st) { if (s.lng > bx0 - R2 && s.lng < bx1 + R2 && s.lat > by0 - R2 && s.lat < by1 + R2) { hasSta = true; break; } }
      if (!hasSta) continue;
      const pts: number[][] = []; for (let i = 0; i < L.length; i += STEP) pts.push(L[i]); if (pts[pts.length - 1] !== L[L.length - 1]) pts.push(L[L.length - 1]);
      // 找「靠近某站」的頂點範圍,first~last 之間(含中間長空檔)一起沿河補牆
      let first = -1, last = -1;
      for (let i = 0; i < pts.length; i++) { if (nearSta(pts[i])) { if (first < 0) first = i; last = i; } }
      if (first < 0) continue;
      for (let i = first; i < last; i++) {
        const A = pts[i], B = pts[i + 1], mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
        const h = idwAll(mid);
        const excess = Math.max(0, h.cur - h.ref) * exag; // 超出基準才用泥色往上冒
        const mB = BASE, mT = BASE + Math.min(excess, CAP);
        const poly = ribbon(A, B);
        baseF.push({ type: "Feature", properties: { h: BASE }, geometry: { type: "Polygon", coordinates: poly } });
        if (mT > mB + 1) topF.push({ type: "Feature", properties: { base: mB, h: mT }, geometry: { type: "Polygon", coordinates: poly } });
      }
    }
    setSrc("ww-base-src", { type: "FeatureCollection", features: baseF });
    setSrc("ww-top-src", { type: "FeatureCollection", features: topF });
    setSrc("ww-pt-src", { type: "FeatureCollection", features: ptF });
  }
  async function toggleWaterWall() {
    const m = mapRef.current; if (!m) return;
    const on = !wallOn;
    const ids = ["ww-base", "ww-top", "ww-pt"];
    if (!on) { for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); wallPopRef.current?.remove(); if (wallMoveRef.current) { m.off("moveend", wallMoveRef.current); wallMoveRef.current = null; } setWallOn(false); setWallInfo(""); return; }
    try {
      const d = await fetch("/api/live?ds=river&t=" + Math.floor(Date.now() / 60000)).then((r) => r.json());
      if (!d.ok || !(d.stations || []).length) { setWallInfo("河川水位資料暫時無法取得"); return; }
      wallDataRef.current = d.stations.filter((s: any) => typeof s.lng === "number" && typeof s.lat === "number" && typeof s.cur_level === "number");
      wallExagRef.current = wallExag; wallWidthRef.current = wallWidth;
      if (!riverGeoRef.current || !riverGeoRef.current.length) {
        setWallInfo("載入河道幾何中…");
        for (let attempt = 0; attempt < 3 && !riverGeoRef.current.length; attempt++) {
          try { const g = await fetch("/api/live?ds=rivergeo").then((r) => r.json()); riverGeoRef.current = g.rivers || []; } catch { riverGeoRef.current = []; }
          if (!riverGeoRef.current.length) await new Promise((r) => setTimeout(r, 3000)); // Overpass 冷啟動時等一下重試
        }
        if (!riverGeoRef.current.length) { setWallInfo("河道幾何載入失敗，稍後再試一次"); return; }
      }
      renderWall(wallExag, wallWidth);
      if (!m.getLayer("ww-base")) {
        m.addLayer({ id: "ww-base", type: "fill-extrusion", source: "ww-base-src", paint: { "fill-extrusion-color": "#0b3d91", "fill-extrusion-base": 0, "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.82 } });
        m.addLayer({ id: "ww-top", type: "fill-extrusion", source: "ww-top-src", paint: { "fill-extrusion-color": "#7a4a21", "fill-extrusion-base": ["get", "base"], "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.9 } });
        m.addLayer({ id: "ww-pt", type: "circle", source: "ww-pt-src", paint: { "circle-radius": 3, "circle-color": "#9fd8ff", "circle-stroke-width": 0.6, "circle-stroke-color": "#08304e" } });
        const wallHtml = (p: any) => { const avg = (p.avg != null && p.avg !== "") ? Number(p.avg).toFixed(2) + " m" : "累積中"; const tt = p.t ? String(p.t).replace("T", " ").slice(0, 16) : ""; return `<div class="qpop"><b>${p.name || ""}</b> ${p.river || ""}<br/>即時水量高度 <b>${Number(p.cur).toFixed(2)} m</b><br/>平均水量高度 ${avg}<br/>警戒 一${p.w1 ?? "-"}/二${p.w2 ?? "-"}/三${p.w3 ?? "-"} m${tt ? `<br/><span style="opacity:.6;font-size:11px">觀測 ${tt}</span>` : ""}</div>`; };
        m.on("mousemove", "ww-pt", (e) => { const f = e.features?.[0]; if (!f) return; m.getCanvas().style.cursor = "pointer"; wallPopRef.current?.remove(); wallPopRef.current = new mapboxgl.Popup({ closeButton: false, offset: 8, className: "hover-tip" }).setLngLat((f.geometry as any).coordinates).setHTML(wallHtml(f.properties)).addTo(m); });
        m.on("mouseleave", "ww-pt", () => { m.getCanvas().style.cursor = ""; wallPopRef.current?.remove(); });
      }
      for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
      const t0 = wallDataRef.current.map((s: any) => s.cur_time).filter(Boolean).sort().slice(-1)[0];
      setWallInfo(`即時水位高度 ${wallDataRef.current.length} 站（藍=平均水量、泥=即時超出平均）${t0 ? `　資料 ${String(t0).replace("T", " ").slice(0, 16)}` : ""}`);
      setWallOn(true);
    } catch { setWallInfo("河川水位載入失敗"); }
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
  // 颱風去背遮罩：整片壓暗、只留颱風中心一個圓(環流)透出即時空照雲系
  function buildTyMask(m: mapboxgl.Map) {
    const c = typhoonCenterRef.current; if (!c) return;
    const R = 4.2; const hole: number[][] = [];
    for (let i = 0; i <= 48; i++) { const a = i / 48 * 2 * Math.PI; hole.push([c[0] + R * Math.cos(a) / Math.max(0.3, Math.cos(c[1] * Math.PI / 180)), c[1] + R * Math.sin(a)]); }
    const outer = [[-179, -80], [179, -80], [179, 80], [-179, 80], [-179, -80]];
    const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [outer, hole] } }] } as any;
    if (m.getSource("ty-mask-src")) (m.getSource("ty-mask-src") as mapboxgl.GeoJSONSource).setData(fc);
    else { m.addSource("ty-mask-src", { type: "geojson", data: fc }); const before = m.getLayer("ty-cone") ? "ty-cone" : undefined; m.addLayer({ id: "ty-mask", type: "fill", source: "ty-mask-src", paint: { "fill-color": "#04070e", "fill-opacity": 0.88 } }, before); }
  }
  // 颱風循環：關 → 颱風(無空照) → 颱風+去背空照(只露颱風雲系)
  async function cycleTyphoon() {
    const m = mapRef.current; if (!m) return;
    const next = (typhoonModeRef.current + 1) % 3;
    typhoonModeRef.current = next; setTyphoonMode(next);
    const mask = (show: boolean) => { if (m.getLayer("ty-mask")) m.setLayoutProperty("ty-mask", "visibility", show ? "visible" : "none"); };
    if (next === 0) { if (typhoonOn) await toggleTyphoon(); mask(false); applyBasemap("dark"); return; }
    if (!typhoonOn) await toggleTyphoon();
    if (!typhoonCenterRef.current) { mask(false); return; } // 無活動颱風
    if (next === 1) { applyBasemap("dark"); mask(false); }
    else { applyBasemap("gibs"); buildTyMask(m); mask(true); }
  }
  async function toggleTyphoon() {
    const m = mapRef.current; if (!m) return;
    const on = !typhoonOn;
    const ids = ["ty-cone", "ty-wind", "ty-path", "ty-fcst", "ty-pt", "ty-ptlbl", "ty-center"];
    if (!on) { for (const id of [...ids, "ty-mask"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); setTyphoonOn(false); setTyphoonInfo(""); return; }
    try {
      const d = await fetch("/api/typhoon").then((r) => r.json());
      if (!d.ok) { setTyphoonInfo("颱風讀取失敗"); return; }
      const tys = d.typhoons || [];
      if (!tys.length) { setTyphoonInfo("目前西北太平洋無活動颱風"); return; }
      const lineF: any[] = [], coneF: any[] = [], windF: any[] = [], centerF: any[] = [], ptF: any[] = [];
      const fmtT = (iso: string) => { const d = new Date(iso); if (isNaN(d.getTime())) return ""; try { return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d); } catch { return ""; } };
      for (const t of tys) {
        if (t.analysis.length >= 2) lineF.push({ type: "Feature", properties: { type: "a" }, geometry: { type: "LineString", coordinates: t.analysis.map((p: any) => [p.lon, p.lat]) } });
        if (t.forecast.length) { const last = t.analysis[t.analysis.length - 1] || t.forecast[0]; lineF.push({ type: "Feature", properties: { type: "f" }, geometry: { type: "LineString", coordinates: [[last.lon, last.lat], ...t.forecast.map((p: any) => [p.lon, p.lat])] } }); }
        for (const p of t.forecast) if (p.r70) coneF.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circlePoly(p.lon, p.lat, p.r70)] } });
        const cur = t.analysis[t.analysis.length - 1];
        if (cur) {
          const w7 = quadPoly(cur.lon, cur.lat, cur.r15); if (w7) windF.push({ type: "Feature", properties: { lvl: 7 }, geometry: { type: "Polygon", coordinates: [w7] } });
          const w10 = quadPoly(cur.lon, cur.lat, cur.r25); if (w10) windF.push({ type: "Feature", properties: { lvl: 10 }, geometry: { type: "Polygon", coordinates: [w10] } });
          centerF.push({ type: "Feature", properties: { name: t.name, wind: cur.wind, pressure: cur.pressure }, geometry: { type: "Point", coordinates: [cur.lon, cur.lat] } });
          ptF.push({ type: "Feature", properties: { label: `現在 ${fmtT(cur.time)}`, kind: "now" }, geometry: { type: "Point", coordinates: [cur.lon, cur.lat] } });
        }
        for (const p of t.forecast) {
          const base = p.time ? new Date(p.time).getTime() : NaN;
          const vt = Number.isFinite(base) && p.hour != null ? new Date(base + p.hour * 3600000).toISOString() : (p.time || "");
          const lbl = (p.hour != null ? `+${p.hour}h ` : "") + fmtT(vt);
          ptF.push({ type: "Feature", properties: { label: lbl.trim(), kind: "f" }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } });
        }
      }
      setSrc("ty-cone-src", { type: "FeatureCollection", features: coneF });
      setSrc("ty-wind-src", { type: "FeatureCollection", features: windF });
      setSrc("ty-line-src", { type: "FeatureCollection", features: lineF });
      setSrc("ty-center-src", { type: "FeatureCollection", features: centerF });
      setSrc("ty-pt-src", { type: "FeatureCollection", features: ptF });
      if (!m.getLayer("ty-cone")) {
        m.addLayer({ id: "ty-cone", type: "fill", source: "ty-cone-src", paint: { "fill-color": "#9ecae1", "fill-opacity": 0.12 } });
        m.addLayer({ id: "ty-wind", type: "fill", source: "ty-wind-src", paint: { "fill-color": ["match", ["get", "lvl"], 10, "#e23b3b", "#f5a53c"], "fill-opacity": ["match", ["get", "lvl"], 10, 0.4, 0.22] } });
        m.addLayer({ id: "ty-path", type: "line", source: "ty-line-src", filter: ["==", ["get", "type"], "a"], paint: { "line-color": "#ffffff", "line-width": 2.4, "line-opacity": 0.9 } });
        m.addLayer({ id: "ty-fcst", type: "line", source: "ty-line-src", filter: ["==", ["get", "type"], "f"], paint: { "line-color": "#ffd54f", "line-width": 2.2, "line-dasharray": [2, 2], "line-opacity": 0.9 } });
        m.addLayer({ id: "ty-pt", type: "circle", source: "ty-pt-src", paint: { "circle-radius": ["match", ["get", "kind"], "now", 5, 3.5], "circle-color": ["match", ["get", "kind"], "now", "#ffffff", "#ffd54f"], "circle-stroke-width": 1, "circle-stroke-color": "#333" } });
        m.addLayer({ id: "ty-ptlbl", type: "symbol", source: "ty-pt-src", layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": "#fff3c4", "text-halo-color": "#3a2f00", "text-halo-width": 1.4 } });
        m.addLayer({ id: "ty-center", type: "symbol", source: "ty-center-src", layout: { "text-field": "🌀", "text-size": 30, "text-allow-overlap": true } });
      }
      for (const id of ids) m.setLayoutProperty(id, "visibility", "visible");
      typhoonCenterRef.current = centerF[0] ? (centerF[0].geometry.coordinates as [number, number]) : null;
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
    if (!on) { for (const id of ["ocean-sst", "ocean-sst-label"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); setOceanOn(false); setOceanInfo(""); return; }
    try {
      const d = await fetch("/api/ocean").then((r) => r.json());
      if (!d.ok || !(d.points || []).length) { setOceanInfo("海溫資料暫無"); return; }
      const sh = sstImage(d.points);
      if (m.getSource("ocean-src")) (m.getSource("ocean-src") as any).updateImage({ url: sh.url });
      else { m.addSource("ocean-src", { type: "image", url: sh.url, coordinates: sh.coords }); m.addLayer({ id: "ocean-sst", type: "raster", source: "ocean-src", paint: { "raster-opacity": 0.7, "raster-resampling": "linear", "raster-fade-duration": 0 } }, m.getLayer("intel-pts") ? "intel-pts" : undefined); }
      m.setLayoutProperty("ocean-sst", "visibility", "visible");
      // 在海面對應位置標出溫度數值(text-allow-overlap:false 會依縮放自動疏密)
      const labFC = { type: "FeatureCollection", features: d.points.map((p: any) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { t: Math.round(p.sst) } })) } as any;
      if (m.getSource("ocean-lab-src")) (m.getSource("ocean-lab-src") as mapboxgl.GeoJSONSource).setData(labFC);
      else { m.addSource("ocean-lab-src", { type: "geojson", data: labFC }); m.addLayer({ id: "ocean-sst-label", type: "symbol", source: "ocean-lab-src", layout: { "text-field": ["concat", ["to-string", ["get", "t"]], "°"], "text-size": ["interpolate", ["linear"], ["zoom"], 5, 9, 9, 13], "text-allow-overlap": false }, paint: { "text-color": "#ffffff", "text-halo-color": "#06203f", "text-halo-width": 1.4 } }); }
      m.setLayoutProperty("ocean-sst-label", "visibility", "visible");
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
        m.addSource("temp-src", { type: "geojson", data: fc, generateId: true });
        m.addLayer({
          id: "temp-col", type: "fill-extrusion", source: "temp-src",
          paint: {
            "fill-extrusion-color": ["case", ["boolean", ["feature-state", "hover"], false], "#ffffff", ["interpolate", ["linear"], ["get", "temp"], 6, "#08306b", 11, "#2c7fb8", 16, "#7fcdbb", 20, "#ffffcc", 24, "#fd8d3c", 28, "#e31a1c", 33, "#800026"]],
            "fill-extrusion-height": TEMP_COL_H,
            "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.9,
          },
        });
        m.on("mousemove", "temp-col", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          const z = ((m.queryTerrainElevation([p.cx, p.cy], { exaggerated: true }) as number) || 0) + TEMP_COL_H;
          setDeckLayers("hover", [hoverTip(p.cx, p.cy, z, `${p.name} ${p.temp}°`)]);
          if (hoverIdRef.current.temp != null && hoverIdRef.current.temp !== f.id) m.setFeatureState({ source: "temp-src", id: hoverIdRef.current.temp }, { hover: false });
          hoverIdRef.current.temp = f.id; m.setFeatureState({ source: "temp-src", id: f.id }, { hover: true });
        });
        m.on("mouseleave", "temp-col", () => { setDeckLayers("hover", []); if (hoverIdRef.current.temp != null) { m.setFeatureState({ source: "temp-src", id: hoverIdRef.current.temp }, { hover: false }); hoverIdRef.current.temp = null; } });
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
  const BASEMAP_LABEL = { dark: "原始", topo: "等高線", sat: "空照", gibs: "最新空照" } as const;
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

      <button className={"all-layers-btn" + (allLayersOn ? " on" : "")} onClick={toggleAllLayers} title="一鍵顯示/關閉所有圖層">{allLayersOn ? "全部 ✓" : "全部"}</button>
      <button className="layer-toggle" onClick={() => setMenuOpen((o) => !o)} title="圖層選單：開關各資料圖層">
        {menuOpen ? "✕ 圖層" : "☰ 圖層"}
      </button>
      <div className={"layer-menu" + (menuOpen ? "" : " hidden")}>
        <button className={"news-btn" + (newsOpen ? " on" : "")} onClick={() => setNewsOpen((o) => !o)} title="消息分類篩選(新聞與群眾回報)，面板顯示於左側">消息 {newsOpen ? "◂" : "▸"}</button>
        <button className={"basemap-btn" + (basemap !== "dark" ? " on" : "")} onClick={cycleBasemap} title="切換底圖：原始 → 等高線 → 空照 → 最新空照(NASA GIBS)">底圖：{BASEMAP_LABEL[basemap]}</button>
        <button className={"rain-btn" + (rainOn ? " on" : "")} onClick={toggleRain} title="即時雨量 3D 水柱(近1小時雨量)">雨量</button>
        {rainInfo && <div className="rain-info">{rainInfo}</div>}
        <button className={"quake-btn" + (quakeOn ? " on" : "")} onClick={toggleQuake} title="近期顯著有感地震：震央 + 不規則震度擴散範圍">地震</button>
        {quakeInfo && <div className="quake-info">{quakeInfo}</div>}
        <button className={"temp-btn" + (tempOn ? " on" : "")} onClick={toggleTemp} title="即時氣溫 3D 柱(藍冷紅熱，20°C 為中點)">氣溫</button>
        {tempInfo && <div className="temp-info">{tempInfo}</div>}
        <button className={"sta-btn" + (staOn ? " on" : "")} onClick={toggleSta} title="測站位置(氣象/雨量/地震)，點站看最新數據">測站</button>
        <button className={"ty-btn" + (typhoonMode > 0 ? " on" : "")} onClick={cycleTyphoon} title="颱風循環：關 → 颱風路徑/暴風圈 → 颱風+去背空照(只露颱風雲系)">{typhoonMode === 0 ? "颱風" : typhoonMode === 1 ? "颱風：路徑" : "颱風：去背空照"}</button>
        {typhoonInfo && <div className="ty-info">{typhoonInfo}</div>}
        <button className={"ocean-btn" + (oceanOn ? " on" : "")} onClick={toggleOcean} title="海表溫度(台大 ODB)">海溫</button>
        {oceanInfo && <div className="ocean-info">{oceanInfo}</div>}
        <button className={"river-btn" + (riverMode > 0 ? " on" : "")} onClick={cycleRiver} title="河流循環(跟底圖同邏輯)：關 → 河流線+河名 → 河流+即時水位高度(滑過站點看水量高度與時間)">{riverMode === 0 ? "河流" : riverMode === 1 ? "河流：線" : "河流：即時水位"}</button>
        {wallInfo && <div className="wall-info">{wallInfo}</div>}
        <button className={"ship-btn" + (shipsOn ? " on" : "")} onClick={toggleShips} title="中國籍船舶 AIS(近岸為主，軍艦多半靜默)">中國船</button>
        {shipsInfo && <div className="ship-info">{shipsInfo}</div>}
        <button className={"peak-btn" + (peaksOn ? " on" : "")} onClick={togglePeaks} title="台灣山岳:百岳/小百岳分層(點開後可勾選)">山岳</button>
        {peaksInfo && <div className="peak-info">{peaksInfo}</div>}
        <button className={"lake-btn" + (lakeOn ? " on" : "")} onClick={toggleLake} title="堰塞湖監測(林保署):監測中堰塞湖，馬太鞍溪為真實湖體">堰塞湖</button>
        {lakeInfo && <div className="lake-info">{lakeInfo}</div>}
        <button className={"gz-btn" + (gzOn ? " on" : "")} onClick={toggleGrayZone} title="中國軍事/灰色地帶入侵紀錄：拉時間軸自選區間，疊出各期間入侵密度">中國入侵</button>
        {gzInfo && <div className="gz-info">{gzInfo}</div>}
      </div>
      {newsOpen && (
        <div className="news-panel">
          {CATS.map((c) => (
            <button key={c.id} className={"news-chip" + (visible.has(c.id) ? "" : " off")} onClick={() => toggle(c.id)}>
              <span className="dot" style={{ background: c.color }} />{c.label}<span className="cnt">{counts[c.id] || 0}</span>
            </button>
          ))}
          <button className="news-chip" onClick={() => setVisible(allOn ? new Set() : new Set(CATS.map((c) => c.id)))}>
            <span className="dot" style={{ background: "#ffffff", opacity: allOn ? 1 : 0.25 }} />全選
          </button>
        </div>
      )}
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
      {peaksOn && (
        <div className="peak-panel">
          {([["百岳", "#ffca28"], ["小百岳", "#66bb6a"], ["一般", "#90a4ae"]] as const).map(([k, c]) => (
            <label key={k} className="sta-opt">
              <input type="checkbox" checked={peakCls.has(k)} onChange={() => togglePeakCls(k)} />
              <span className="sta-dot" style={{ background: c }} />{k === "一般" ? "一般山岳" : k}
            </label>
          ))}
        </div>
      )}
      {rainOn && (
        <div className="seg-panel">
          <button className={"seg-btn" + (rainMode === "1h" ? " on" : "")} onClick={() => setRainModeAndRender("1h")}>近1小時</button>
          <button className={"seg-btn" + (rainMode === "24h" ? " on" : "")} onClick={() => setRainModeAndRender("24h")}>近24小時</button>
        </div>
      )}
      {gzOn && (
        <div className="gz-ctrl">
          <div className="gz-range-lbl">時間範圍　<b>{idxLabel(gzFrom)} → {idxLabel(gzTo)}</b></div>
          <label>起 <input type="range" min={0} max={gzMax} step={1} value={gzFrom} onChange={(e) => { const v = Math.min(Number(e.target.value), gzTo); setGzFrom(v); renderIncursions(v, gzTo); }} /></label>
          <label>訖 <input type="range" min={0} max={gzMax} step={1} value={gzTo} onChange={(e) => { const v = Math.max(Number(e.target.value), gzFrom); setGzTo(v); renderIncursions(gzFrom, v); }} /></label>
          <div className="gz-legend">
            <span style={{ color: "#ff6d00" }}>●</span>共機　<span style={{ color: "#d50000" }}>●</span>軍演　<span style={{ color: "#ff9100" }}>●</span>海警　<span style={{ color: "#ffd600" }}>●</span>海纜　<span style={{ color: "#2962ff" }}>●</span>共艦　<span style={{ color: "#aa00ff" }}>●</span>科研
          </div>
        </div>
      )}
      {wallOn && (
        <div className="wall-ctrl">
          <label>高度誇張 <b>{wallExag}×</b>
            <input type="range" min={1} max={300} step={1} value={wallExag} onChange={(e) => { const v = Number(e.target.value); setWallExag(v); wallExagRef.current = v; renderWall(v, wallWidthRef.current); }} />
          </label>
          <label>寬度 <b>{wallWidth.toFixed(1)}×</b>
            <input type="range" min={1} max={5} step={0.5} value={wallWidth} onChange={(e) => { const v = Number(e.target.value); setWallWidth(v); wallWidthRef.current = v; renderWall(wallExagRef.current, v); }} />
          </label>
        </div>
      )}
      {oceanOn && (
        <div className="sst-legend">
          <span className="qlg-title">海溫°C</span>
          {[22, 24, 26, 28, 30, 32].map((t) => (<span key={t} className="qlg-sw" style={{ background: `rgb(${sstColor(t).join(",")})` }}>{t}</span>))}
        </div>
      )}

      {quakeOn && quakeList.length > 0 && (
        <div className="quake-list">
          <div className="ql-head">
            <span>地震（新 → 舊）</span>
            <span className="ql-seg">
              <button className={quakeAll ? "" : "on"} onClick={() => { quakeAllRef.current = false; setQuakeAll(false); }}>顯著</button>
              <button className={quakeAll ? "on" : ""} onClick={() => { quakeAllRef.current = true; setQuakeAll(true); }}>全部</button>
            </span>
          </div>
          {quakeList.filter((q) => quakeAll || q.kind !== "小區域").map((q) => (
            <div key={q.no ?? (q.time + q.location)} className={"ql-item" + (quakeList.indexOf(q) === quakeSel ? " sel" : "")}
              title={`規模 ${q.mag ?? "?"}・深度 ${q.depth ?? "?"} km・${q.kind || "顯著"}`} onClick={() => selectQuake(quakeList.indexOf(q))}>
              <span className="ql-date">{qDate(q.time)}</span>
              <span className="ql-loc">M{q.mag ?? "?"}　{qLoc(q.location)}{q.kind === "小區域" ? " ·小區域" : ""}</span>
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

    </>
  );
}
