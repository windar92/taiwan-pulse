import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { TextLayer, SolidPolygonLayer, LineLayer, IconLayer } from "@deck.gl/layers";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;
const HOME_KEY = "tp-home";
const DEFAULT_HOME = { lng: 120.95, lat: 23.8, zoom: 7.3 };
const COUNTY_GEOJSON = "https://raw.githubusercontent.com/g0v/twgeojson/master/json/twCounty2010.geo.json";
// 雨量水柱高度：各時距用各自的線性倍率與上限，讓柱高與雨量成「真實正比」。
// 舊版固定 min(v,80)*700，24h 模式下豪雨(200~500mm)全部撞到 80mm 上限 → 柱高一樣高，看不出差異。
const RAIN_H_1H = 700, RAIN_H_24H = 70;      // 公尺/mm(24h 數值約大10倍，倍率相應縮小)
const RAIN_CAP_1H = 250, RAIN_CAP_24H = 1200; // 僅防呆用的極端上限，正常不會觸及
const rainScale = (metric: "1h" | "24h") => (metric === "24h" ? RAIN_H_24H : RAIN_H_1H);
const rainCap = (metric: "1h" | "24h") => (metric === "24h" ? RAIN_CAP_24H : RAIN_CAP_1H);
const rainColH = (metric: "1h" | "24h", v: number) => Math.min(v || 0, rainCap(metric)) * rainScale(metric);
// 顏色分級也依時距調整(24h 的門檻約為 1h 的 10 倍)
const rainColorStops = (metric: "1h" | "24h"): any[] =>
  metric === "24h" ? [0, "#bcd9ff", 30, "#6baed6", 100, "#2171b5", 300, "#08306b"]
                   : [0, "#bcd9ff", 5, "#6baed6", 15, "#2171b5", 40, "#08306b"];
const rainDotStops = (metric: "1h" | "24h"): any[] =>
  metric === "24h" ? [0, "rgba(120,140,160,0.5)", 3, "#9ecae1", 60, "#4292c6", 250, "#08519c"]
                   : [0, "rgba(120,140,160,0.5)", 0.5, "#9ecae1", 10, "#4292c6", 40, "#08519c"];
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

// ===== 重要度計分：把「死了人/斷纜/共機」和「中秋禮盒/桌球友誼賽」分開 =====
const SEV_RULES: [RegExp, number][] = [
  [/死亡|罹難|不治|喪生|身亡|死者/, 42],
  [/爆炸|氣爆|大火|延燒|坍塌|倒塌|墜機|墜樓|翻覆/, 32],
  [/共機|共艦|共軍|解放軍|逾越中線|擾台|海警船|軍演|漢光|實彈/, 32],
  [/斷纜|海纜|光纜中斷|通訊中斷/, 30],
  [/颱風|海上警報|陸上警報|停班|停課|撤離|疏散/, 30],
  [/地震|規模\s?[3-9]|震度\s?[4-7]/, 26],
  [/重傷|傷亡|失蹤|受困|搜救/, 26],
  [/槍擊|砍人|命案|挾持|綁架|爆裂物|恐嚇/, 24],
  [/土石流|走山|山崩|堰塞湖|潰堤|溢流警戒/, 24],
  [/封路|道路中斷|封閉|禁航|管制/, 18],
  [/大規模停電|全區停電|跳電/, 18],
  [/疫情|群聚感染|食物中毒|禽流感|非洲豬瘟/, 16],
  [/起訴|判刑|收押|逮捕|查獲|偵辦/, 12],
];
const FLUFF_RE = /禮盒|嘉年華|市集|園遊會|表揚|揭牌|授旗|研習|夏令營|營隊|親子|摸彩|抽獎|成果展|文化節|美食節|打卡|網美|優惠|好禮|同樂|開箱|徵集|報名|講座|論壇|頒獎|感謝|友誼賽|才藝|寫生|繪畫|歌唱|舞蹈|志工|生活節|解壓|閱讀禮|午餐|廚藝|伴手禮|送禮|中秋|端午|春節|年菜|義賣|捐贈|開幕|揭幕|巡迴|宣導|推廣|樂齡|銀髮|優先採購|記者會|展售|特展/;
const ROUTINE_RE = /水庫放流|自由溢流|已無警戒|停水通知|管線漏水|破管搶修|汰換管線|新裝工程|計畫性維護|例行/;
// 來源層級：公共媒體 > 深度媒體 > 官方警示 > 商業媒體 > 地方公關稿
function srcTier(s: string) {
  if (/中央社|公視/.test(s)) return 3;
  if (/報導者|鏡新聞/.test(s)) return 2.5;
  if (/氣象署|NCDR|海巡|水保署|國防部|移民署|漁業署/.test(s)) return 2;
  if (/自由時報|聯合報|三立|民視|ETtoday|新頭殼|風傳媒|TVBS/.test(s)) return 1.5;
  return 1;
}
function sevScore(t: string) {
  let max = 0, sum = 0;
  for (const [re, w] of SEV_RULES) if (re.test(t)) { max = Math.max(max, w); sum += w; }
  return max + (sum - max) * 0.25;
}
function normTitle(t: string) {
  return (t || "").replace(/[【】〔〕()（）\[\]「」『』:：,，、。!！?？~～\-—\s]/g, "").replace(/\d{2,}/g, "").slice(0, 14);
}
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
  const [visible, setVisible] = useState<Set<Cat>>(new Set());
  const visibleRef = useRef<Set<Cat>>(visible);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [showMemo, setShowMemo] = useState(false);
  const [menuOpen, setMenuOpen] = useState(true);
  const [newsOpen, setNewsOpen] = useState(false);
  const [focus, setFocus] = useState<any[]>([]);
  const [focusOpen, setFocusOpen] = useState(false);
  const [resOpen, setResOpen] = useState(false);
  const [resList, setResList] = useState<any[]>([]);
  const [allLayersOn, setAllLayersOn] = useState(false);
  const [memoSaved, setMemoSaved] = useState(false);
  const [basemap, setBasemap] = useState<"dark" | "topo" | "sat" | "gibs" | "vis" | "nphoto" | "nmap" | "rudy">("dark");
  const [landslideOn, setLandslideOn] = useState(false);
  const [shadeOn, setShadeOn] = useState(false); // 光達地形暈渲
  const [slopeOn, setSlopeOn] = useState(false); // 坡度圖
  const [treesOn, setTreesOn] = useState(false); // 巨木地圖
  const [treesInfo, setTreesInfo] = useState("");
  const treesPopRef = useRef<mapboxgl.Popup | null>(null);
  const treeDataRef = useRef<any[]>([]);
  const [treeExag, setTreeExag] = useState(2); // 巨木立體高度誇張倍率(2×附近最像樹)
  const treeExagRef = useRef(2);
  const [wfOn, setWfOn] = useState(false); const [wfInfo, setWfInfo] = useState(""); const wfPopRef = useRef<mapboxgl.Popup | null>(null);
  const [hsOn, setHsOn] = useState(false); const [hsInfo, setHsInfo] = useState(""); const hsPopRef = useRef<mapboxgl.Popup | null>(null);
  const [cableOn, setCableOn] = useState(false); const [cableInfo, setCableInfo] = useState(""); const cablePopRef = useRef<mapboxgl.Popup | null>(null);
  const [gwOn, setGwOn] = useState(false); const [gwInfo, setGwInfo] = useState(""); const gwPopRef = useRef<mapboxgl.Popup | null>(null);
  const [pdOn, setPdOn] = useState(false); const [pdInfo, setPdInfo] = useState(""); const pdPopRef = useRef<mapboxgl.Popup | null>(null);
  const [gibsInfo, setGibsInfo] = useState<string>("");
  const visModeRef = useRef<string>("");
  const countyGeoRef = useRef<any>(null);
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
  const [oceanMode, setOceanMode] = useState(0); // 0=關 1=色溫底圖 2=色溫底圖+溫度數字
  const oceanModeRef = useRef(0);
  const [riversOn, setRiversOn] = useState(false);
  const [riversInfo, setRiversInfo] = useState("");
  const riversGeoRef = useRef<any>(null);
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
  const lakeLevelRef = useRef<any>(null);
  const lakePopRef = useRef<mapboxgl.Popup | null>(null);
  const [coastOn, setCoastOn] = useState(false);
  const [basinMode, setBasinMode] = useState(0); // 0關 1近1h 2近24h
  const basinModeRef = useRef(0);
  const [basinInfo, setBasinInfo] = useState("");
  const basinGeoRef = useRef<any>(null);
  const basinPopRef = useRef<mapboxgl.Popup | null>(null);
  const [cctvOn, setCctvOn] = useState(false);
  const [cctvInfo, setCctvInfo] = useState("");
  const cctvPopRef = useRef<mapboxgl.Popup | null>(null);
  // 即時影像的類別開關(國道/省道/河川/淹水/景點)，做法比照「測站」的子面板
  const [camTypes, setCamTypes] = useState<Set<string>>(new Set(["freeway", "highway", "river", "flood", "scenic"]));
  const [camCounts, setCamCounts] = useState<Record<string, number>>({});
  const [currentsOn, setCurrentsOn] = useState(false);
  const [currentsInfo, setCurrentsInfo] = useState("");
  const curVecsRef = useRef<any[]>([]);
  const curMoveRef = useRef<(() => void) | null>(null);
  const curStepRef = useRef<number>(0);
  const curGridRef = useRef<{ map: Map<string, { u: number; v: number }>; lon0: number; lat0: number; lonMax: number; latMax: number; g: number } | null>(null);
  const [zoomInfo, setZoomInfo] = useState("");
  const [plaOn, setPlaOn] = useState(false);
  const [plaInfo, setPlaInfo] = useState("");
  const plaPopRef = useRef<mapboxgl.Popup | null>(null);
  // 解放軍設施的類別開關(比照即時影像/測站)
  const PLA_CATS: [string, string][] = [
    ["軍機場/空軍", "#40c4ff"], ["海軍/軍港", "#18ffff"], ["海軍陸戰", "#1de9b6"],
    ["火箭軍", "#d500f9"], ["飛彈", "#ff9100"], ["防空飛彈", "#ffab40"],
    ["陸軍", "#8d6e63"], ["雷達/預警", "#ff5252"], ["電子/通信", "#e040fb"],
    ["海警", "#eceff1"], ["基地/指揮", "#ffd740"], ["油氣平台", "#ff6e40"], ["其他", "#b0bec5"],
  ];
  const PLA_COLOR: Record<string, string> = Object.fromEntries(PLA_CATS);
  const [plaTypes, setPlaTypes] = useState<Set<string>>(new Set(PLA_CATS.map(([k]) => k)));
  const [plaCounts, setPlaCounts] = useState<Record<string, number>>({});
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
    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 130, unit: "metric" }), "bottom-left");
    const updateZoomInfo = () => {
      const z = map.getZoom();
      const step = Math.max(0.0625, Math.min(4, 0.25 * Math.pow(2, 6.77 - z)));
      setZoomInfo(`z ${z.toFixed(2)}　海流取樣格距 ${step.toFixed(2)}°（約${Math.round(step * 111)} km）`);
    };
    map.on("move", updateZoomInfo); map.on("load", updateZoomInfo);
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
        // 等高線數字標高：<1000m 每 200m、≥1000m 每 500m
        map.addLayer({
          id: "contour-label", type: "symbol", source: "tw-contour", "source-layer": "contour",
          filter: ["case", ["<", ["get", "ele"], 1000], ["==", ["%", ["get", "ele"], 200], 0], ["==", ["%", ["get", "ele"], 500], 0]],
          layout: {
            visibility: "none", "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "ele"]], " m"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 8, 9, 13, 12], "text-max-angle": 25,
            "symbol-spacing": 350, "text-padding": 4,
          },
          paint: { "text-color": "#cfeee3", "text-halo-color": "#0d2621", "text-halo-width": 1.6 },
        });
      } catch {}

      try {
        const gj = await fetch(COUNTY_GEOJSON).then((r) => r.json());
        countyGeoRef.current = gj;
        const props = gj.features?.[0]?.properties || {};
        countyKeyRef.current = Object.keys(props).find((k) => /[縣市]$/.test(String(props[k]))) || "COUNTYNAME";
        map.addSource("tw-county", { type: "geojson", data: gj });
        map.addLayer({ id: "county-hl-fill", type: "fill", source: "tw-county", paint: { "fill-color": "#ffffff", "fill-opacity": 0.12 }, filter: ["==", ["get", countyKeyRef.current], "___none___"] });
        map.addLayer({ id: "county-hl-line", type: "line", source: "tw-county", paint: { "line-color": "#ffd54f", "line-width": 2.2, "line-opacity": 0.9 }, filter: ["==", ["get", countyKeyRef.current], "___none___"] });
      } catch {}

      map.addSource("intel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "intel-pts", type: "circle", source: "intel",
        filter: ["in", ["get", "cat"], ["literal", Array.from(visibleRef.current)]],
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
    visibleRef.current = visible;
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
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [e.lng, e.lat] }, properties: { cat, cats: e.categories, hash: e.hash, title: e.title, summary: e.summary, source: e.source_name, url: e.url, county: e.county, published_at: e.published_at || "" } });
      tally[cat] = (tally[cat] || 0) + 1;
    }
    if (rpRes?.ok) for (const r of rpRes.reports || []) {
      if (typeof r.lng !== "number") continue;
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [r.lng, r.lat] }, properties: { cat: "report", cats: "report", hash: "", title: r.title, summary: r.body, source: r.kind, url: "", county: "" } });
      tally.report = (tally.report || 0) + 1;
    }
    buildFocus(evRes?.ok ? (evRes.events || []) : []);
    (map.getSource("intel") as mapboxgl.GeoJSONSource)?.setData({ type: "FeatureCollection", features } as any);
    setCounts(tally);
  }

  // 依重要度挑出「今日焦點」：計分 → 跨來源去重(重複=互相佐證，加分) → 取前 8
  function buildFocus(events: any[]) {
    const now = Date.now();
    const scored = events.map((e: any) => {
      const t = (e.title || "") + " " + (e.summary || "");
      const hrs = e.published_at ? Math.max(0, (now - Date.parse(e.published_at)) / 3600000) : 48;
      let s = sevScore(t) + srcTier(e.source_name || "") * 7 + Math.max(0, 22 - hrs * 1.1);
      if (FLUFF_RE.test(t)) s -= 40;
      if (ROUTINE_RE.test(t)) s -= 45;
      if ((e.categories || "").includes("defense")) s += 10;
      return { ...e, _s: s, _k: normTitle(e.title) };
    });
    const byKey = new Map<string, any>();
    for (const it of scored) {
      const prev = byKey.get(it._k);
      if (!prev) byKey.set(it._k, { ...it, _n: 1 });
      else { prev._n++; if (it._s > prev._s) { const n = prev._n; byKey.set(it._k, { ...it, _n: n }); } }
    }
    const list = [...byKey.values()].map((x) => ({ ...x, _s: x._s + Math.min(x._n - 1, 3) * 9 }))
      .filter((x) => x._s > 18)
      .sort((a, b) => b._s - a._s).slice(0, 8);
    setFocus(list);
  }
  function flyToEvent(e: any) {
    const m = mapRef.current; if (!m || typeof e.lng !== "number") return;
    m.flyTo({ center: [e.lng, e.lat], zoom: Math.max(m.getZoom(), 10), duration: 900 });
    setSel({ title: e.title, summary: e.summary, cats: e.categories, source: e.source_name, url: e.url, county: e.county } as any);
  }
  function recenter() { const m = mapRef.current; if (!m) return; const h = loadHome(); m.flyTo({ center: [h.lng, h.lat], zoom: h.zoom || 7.3, pitch: h.pitch ?? 55, bearing: h.bearing ?? 0, duration: 1100 }); }
  function memorize() { const m = mapRef.current; if (!m) return; const c = m.getCenter(); localStorage.setItem(HOME_KEY, JSON.stringify({ lng: c.lng, lat: c.lat, zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() })); setMemoSaved(true); setTimeout(() => setMemoSaved(false), 1600); }
  // 即時雲圖：日本向日葵九號(Himawari-9) AHI Band13 清晰紅外(每10分鐘)，經 NASA GIBS 重投影為 web 墨卡托
  // 圖磚用 GIBS "default"(永遠取最新可用影像,不會空白);顯示時間為推估的最新可用時刻(GIBS 延遲約 30–60 分)
  function himawariTime() {
    const d = new Date(Date.now() - 40 * 60 * 1000);
    d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10, 0, 0);
    const tw = new Date(d.getTime() + 8 * 3600 * 1000); // 台灣時間 UTC+8
    return `${tw.getUTCMonth() + 1}/${tw.getUTCDate()} ${String(tw.getUTCHours()).padStart(2, "0")}:${String(tw.getUTCMinutes()).padStart(2, "0")}`;
  }
  function ensureGibs() {
    const m = mapRef.current; if (!m || m.getLayer("gibs-sat")) return;
    m.addSource("gibs-sat", { type: "raster", tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`], tileSize: 256, maxzoom: 6, attribution: "JMA Himawari-9 / NASA GIBS" });
    const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
    m.addLayer({ id: "gibs-sat", type: "raster", source: "gibs-sat", paint: { "raster-opacity": 0.82 } }, beforeId);
    setGibsInfo(`紅外雲圖　來源：向日葵九號(Himawari-9) 清晰紅外(Band13) · NASA GIBS 重投影\n資料時間：約 ${himawariTime()} 前後(台灣時間，最新可用影像，每10分鐘更新、約30–60分延遲)`);
  }
  // 衛星空照圖：VIIRS 可見光「真彩」(Corrected Reflectance True Color)
  // 這是真正「從太空往下看」的實景影像：地面是真實顏色、雲系是白的、颱風眼看得到。
  // 註：向日葵(10分鐘)沒有可用的真彩來源 —— NASA GIBS 的 GeoColor 只有 GOES(美洲)，
  //     亞洲這邊只能拿到紅外(假色)。真彩只有極軌衛星 VIIRS/MODIS，每天過境一次。
  function visDate() {
    const d = new Date(Date.now() - 24 * 3600 * 1000); // 取前一日(當日影像常還沒處理完)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  function ensureVis() {
    const m = mapRef.current; if (!m) return;
    const date = visDate();
    // NOAA-20/VIIRS 真彩(Suomi-NPP 近期日期常有缺，NOAA-20 較穩定即時)
    const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
    const build = () => {
      m.addSource("vis-src", { type: "raster", tiles: [url], tileSize: 256, maxzoom: 9, attribution: "NASA EOSDIS GIBS · NOAA-20/VIIRS" });
      const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
      m.addLayer({ id: "vis-sat", type: "raster", source: "vis-src", paint: { "raster-opacity": 1 } }, beforeId);
      visModeRef.current = date as any;
    };
    if (!m.getLayer("vis-sat")) build();
    else if ((visModeRef.current as any) !== date) {
      if (m.getLayer("vis-sat")) m.removeLayer("vis-sat");
      if (m.getSource("vis-src")) m.removeSource("vis-src");
      build();
    }
    setGibsInfo(`衛星空照圖　來源：NOAA-20 / VIIRS 可見光真彩(Corrected Reflectance) · NASA GIBS\n影像日期：${date}（極軌衛星每日過境一次；夜間無可見光，故非逐時更新）`);
  }
  // NLSC 內政部國土測繪中心 圖磚(免金鑰 WMTS，GoogleMapsCompatible)
  function ensureNlsc(id: string, layer: string) {
    const m = mapRef.current; if (!m || m.getLayer(id)) return;
    m.addSource(id, { type: "raster", tiles: [`https://wmts.nlsc.gov.tw/wmts/${layer}/default/GoogleMapsCompatible/{z}/{y}/{x}`], tileSize: 256, maxzoom: 20, attribution: "內政部國土測繪中心 NLSC" });
    const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
    m.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 1 } }, beforeId);
  }
  // 魯地圖(臺灣 MOI.OSM，民間戶外/登山地圖，免金鑰圖磚；步道畫得細)
  function ensureRudy() {
    const m = mapRef.current; if (!m || m.getLayer("rudy-lyr")) return;
    m.addSource("rudy-src", { type: "raster", tiles: ["https://tile.happyman.idv.tw/map/moi_osm/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 16, attribution: "魯地圖 Rudy Map · © OpenStreetMap contributors" });
    const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
    m.addLayer({ id: "rudy-lyr", type: "raster", source: "rudy-src", paint: { "raster-opacity": 1 } }, beforeId);
  }
  function applyBasemap(mode: "dark" | "topo" | "sat" | "gibs" | "vis" | "nphoto" | "nmap" | "rudy") {
    const m = mapRef.current; if (!m) return;
    if (mode === "gibs") ensureGibs();
    if (mode === "vis") ensureVis();
    if (mode === "nphoto") ensureNlsc("nphoto-lyr", "PHOTO2");
    if (mode === "nmap") ensureNlsc("nmap-lyr", "EMAP5_OPENDATA");
    if (mode === "rudy") ensureRudy();
    const vis = (id: string, on: boolean) => { if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", on ? "visible" : "none"); };
    vis("sat-layer", mode === "sat");
    vis("contour-line", mode === "topo");
    vis("contour-label", mode === "topo");
    vis("hillshade", mode === "dark" || mode === "topo"); // 有實景/電子地圖的底圖不需陰影
    vis("gibs-sat", mode === "gibs");
    vis("vis-sat", mode === "vis");
    vis("nphoto-lyr", mode === "nphoto");
    vis("nmap-lyr", mode === "nmap");
    vis("rudy-lyr", mode === "rudy");
    if (mode === "sat") setGibsInfo("空照　來源：Mapbox Satellite（多期高解析衛星／航照合成影像，非單一拍攝時間；不定期更新）");
    else if (mode === "nphoto") setGibsInfo("正射影像　來源：內政部國土測繪中心 NLSC（台灣航照正射，山區細節較 Mapbox 空照清楚）");
    else if (mode === "nmap") setGibsInfo("電子地圖(含等高線)　來源：內政部國土測繪中心 NLSC 通用版電子地圖 EMAP5");
    else if (mode === "rudy") setGibsInfo("魯地圖(戶外/登山)　來源：魯地圖 Rudy Map · © OpenStreetMap contributors。台灣登山圈常用，步道/山屋/水源標得細；為渲染圖磚，無法點選單一步道。");
    else if (mode !== "gibs" && mode !== "vis") setGibsInfo("");
    if (shadeOn) shadeToTop();
    if (landslideOn) landslideToTop(); // 換底圖後把疊圖推回最上層
    // 海陸輪廓線只用於「紅外雲圖 / 衛星空照圖」這兩種看不出海陸界線的底圖；
    // 其餘底圖自動隱藏(狀態保留，切回雲圖/空照時自動恢復)。
    const coastable = mode === "gibs" || mode === "vis";
    const showCoast = coastOn && coastable;
    vis("coast-halo", showCoast);
    vis("coast-line", showCoast);
    if (showCoast) coastToTop(); // 換底圖後把海陸輪廓線推回最上層
    setBasemap(mode);
  }
  function cycleBasemap() {
    const order = ["dark", "topo", "sat", "nphoto", "nmap", "rudy", "gibs", "vis"] as const;
    applyBasemap(order[(order.indexOf(basemap as any) + 1) % order.length]);
  }
  // 山崩與地滑地質敏感區疊圖(經濟部地礦中心「山崩雲」WMTS，注意圖磚順序為 z/x/y)
  function landslideToTop() {
    const m = mapRef.current; if (!m || !m.getLayer("landslide-lyr")) return;
    const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
    if (beforeId) m.moveLayer("landslide-lyr", beforeId); else m.moveLayer("landslide-lyr");
  }
  function toggleLandslide() {
    const m = mapRef.current; if (!m) return;
    const on = !landslideOn;
    if (!m.getSource("landslide-src")) {
      m.addSource("landslide-src", { type: "raster", tiles: ["https://landslide.geologycloud.tw/jlwmts/jetlink/SensitiveArea/GoogleMapsCompatibl/{z}/{x}/{y}"], tileSize: 256, attribution: "經濟部地質調查及礦業管理中心 · 山崩與地滑地質敏感區" });
      const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
      m.addLayer({ id: "landslide-lyr", type: "raster", source: "landslide-src", paint: { "raster-opacity": 0.55 }, layout: { visibility: "none" } }, beforeId);
    }
    m.setLayoutProperty("landslide-lyr", "visibility", on ? "visible" : "none");
    if (on) landslideToTop();
    setLandslideOn(on);
    setGibsInfo(on
      ? "山崩與地滑地質敏感區　來源：經濟部地礦中心（收錄111年以前記錄之崩塌滑坡區）。建議搭配『正射』或『等高線』底圖判讀高風險邊坡；紅／橘區＝敏感區，僅供行前參考、非即時災情。"
      : "");
  }
  // 光達地形暈渲(20m 多向陰影圖，讓稜線/溪谷/崩溝立體感更細)。同為山崩雲圖磚，注意 z/x/y
  function shadeToTop() {
    const m = mapRef.current; if (!m || !m.getLayer("shade-lyr")) return;
    // 疊在基本地形之上、但在其他資料點與山崩疊圖之下
    const beforeId = m.getLayer("landslide-lyr") ? "landslide-lyr" : (m.getLayer("intel-pts") ? "intel-pts" : undefined);
    if (beforeId) m.moveLayer("shade-lyr", beforeId); else m.moveLayer("shade-lyr");
  }
  function toggleShade() {
    const m = mapRef.current; if (!m) return;
    const on = !shadeOn;
    if (!m.getSource("shade-src")) {
      m.addSource("shade-src", { type: "raster", tiles: ["https://landslide.geologycloud.tw/jlwmts/jetlink/Shadw20/GoogleMapsCompatible/{z}/{x}/{y}"], tileSize: 256, attribution: "經濟部地礦中心 · 全島數值地形多向陰影圖(20m 光達)" });
      m.addLayer({ id: "shade-lyr", type: "raster", source: "shade-src", paint: { "raster-opacity": 0.5 }, layout: { visibility: "none" } }, m.getLayer("landslide-lyr") ? "landslide-lyr" : (m.getLayer("intel-pts") ? "intel-pts" : undefined));
    }
    m.setLayoutProperty("shade-lyr", "visibility", on ? "visible" : "none");
    if (on) shadeToTop();
    setShadeOn(on);
    setGibsInfo(on ? "光達地形暈渲　來源：經濟部地礦中心 全島數值地形多向陰影圖(20m)。半透明疊在底圖上，強化稜線、溪谷、崩溝立體感；搭配『等高線』或『原始』底圖效果最佳。" : "");
  }
  // 坡度圖(20m 光達坡度，登山風險判讀：越陡越危險)。同山崩雲圖磚 z/x/y
  function slopeToTop() {
    const m = mapRef.current; if (!m || !m.getLayer("slope-lyr")) return;
    const beforeId = m.getLayer("landslide-lyr") ? "landslide-lyr" : (m.getLayer("intel-pts") ? "intel-pts" : undefined);
    if (beforeId) m.moveLayer("slope-lyr", beforeId); else m.moveLayer("slope-lyr");
  }
  function toggleSlope() {
    const m = mapRef.current; if (!m) return;
    const on = !slopeOn;
    if (!m.getSource("slope-src")) {
      m.addSource("slope-src", { type: "raster", tiles: ["https://landslide.geologycloud.tw/jlwmts/jetlink/Slp20/GoogleMapsCompatible/{z}/{x}/{y}"], tileSize: 256, attribution: "經濟部地礦中心 · 全島數值地形坡度圖(20m 光達)" });
      m.addLayer({ id: "slope-lyr", type: "raster", source: "slope-src", paint: { "raster-opacity": 0.55 }, layout: { visibility: "none" } }, m.getLayer("intel-pts") ? "intel-pts" : undefined);
    }
    m.setLayoutProperty("slope-lyr", "visibility", on ? "visible" : "none");
    if (on) slopeToTop();
    setSlopeOn(on);
    setGibsInfo(on ? "坡度圖　來源：經濟部地礦中心 全島數值地形坡度圖(20m 光達)。顏色越暖＝坡度越陡；登山行前評估路段陡峭度，陡坡＋雨後崩塌風險高。" : "");
  }
  // 通用 POI 點圖層(瀑布/溫泉，資料來源：小飛 Google My Maps)
  async function togglePoi(kind: "wf" | "hs") {
    const m = mapRef.current; if (!m) return;
    const cfg = kind === "wf"
      ? { on: wfOn, setOn: setWfOn, setInfo: setWfInfo, pop: wfPopRef, id: "wf-pt", url: "/waterfalls.json", color: "#29b6f6", stroke: "#08324a", label: "野溪瀑布", icon: "💧", src: "跟著小飛玩 Follow Xiaofei" }
      : { on: hsOn, setOn: setHsOn, setInfo: setHsInfo, pop: hsPopRef, id: "hs-pt", url: "/hotsprings.json", color: "#ff7043", stroke: "#4a1c08", label: "野溪溫泉", icon: "♨", src: "跟著小飛玩 Follow Xiaofei" };
    const on = !cfg.on;
    if (!on) { if (m.getLayer(cfg.id)) m.setLayoutProperty(cfg.id, "visibility", "none"); cfg.pop.current?.remove(); cfg.setOn(false); cfg.setInfo(""); return; }
    cfg.setOn(true); cfg.setInfo(cfg.label + "載入中…");
    try {
      const d = await fetch(cfg.url).then((r) => r.json());
      if (!(d.points || []).length) { cfg.setInfo(cfg.label + "暫無"); return; }
      const fc = { type: "FeatureCollection", features: d.points.map((p: any) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { name: p.name, desc: p.desc || "" } })) } as any;
      const srcId = cfg.id + "-src";
      if (m.getSource(srcId)) (m.getSource(srcId) as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource(srcId, { type: "geojson", data: fc });
        m.addLayer({ id: cfg.id, type: "circle", source: srcId, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 6], "circle-color": cfg.color, "circle-stroke-width": 1, "circle-stroke-color": cfg.stroke, "circle-opacity": 0.92 } });
        m.on("mouseenter", cfg.id, () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", cfg.id, () => { m.getCanvas().style.cursor = ""; });
        m.on("click", cfg.id, (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          cfg.pop.current?.remove();
          const urlm = (p.desc || "").match(/https?:\/\/[^\s"']+/);
          const link = urlm ? `<br/><a href="${urlm[0]}" target="_blank" rel="noopener" style="color:#7ec8ff;font-size:11.5px">相關連結 ↗</a>` : "";
          cfg.pop.current = new mapboxgl.Popup({ offset: 10, className: "hover-tip", maxWidth: "280px" }).setLngLat((f.geometry as any).coordinates).setHTML(
            `<div class="qpop"><b>${cfg.icon} ${p.name || ""}</b><br/><span style="opacity:.85;font-size:12px">${(p.desc || "").replace(/https?:\/\/[^\s"']+/g, "").slice(0, 90)}</span>${link}<br/><span style="opacity:.6;font-size:11px">來源：${cfg.src}·祕境路況會變，僅供參考、請勿貿然前往</span></div>`
          ).addTo(m);
        });
      }
      m.setLayoutProperty(cfg.id, "visibility", "visible");
      cfg.setInfo(`${cfg.label} ${d.points.length} 處　來源：${cfg.src}（業餘整理·僅供參考，非官方導覽座標）`);
    } catch { cfg.setInfo(cfg.label + "載入失敗"); }
  }
  // ===== 海纜事件(斷纜/維護)：smc.peering.tw 公開資料 =====
  const CABLE_STATUS: Record<string, { c: string; t: string }> = { disconnected: { c: "#e53935", t: "斷線" }, partial_disconnected: { c: "#fbc02d", t: "部分斷線" }, notice: { c: "#42a5f5", t: "維護/公告" } };
  const CABLE_REASON: Record<string, string> = { earthquake: "地震", fishing: "漁業作業", sabotage: "蓄意破壞", maintenance: "計畫性維護", equipment: "設備障礙", land: "陸上作業", unknown: "未知" };
  async function toggleCable() {
    const m = mapRef.current; if (!m) return;
    const on = !cableOn;
    if (!on) { if (m.getLayer("cable-pt")) m.setLayoutProperty("cable-pt", "visibility", "none"); cablePopRef.current?.remove(); setCableOn(false); setCableInfo(""); return; }
    setCableOn(true); setCableInfo("海纜事件載入中…");
    try {
      const d = await fetch("/api/live?ds=cable").then((r) => r.json());
      const inc = (d.incidents || []).filter((x: any) => Number.isFinite(x.lon) && Number.isFinite(x.lat));
      if (!inc.length) { setCableInfo("海纜事件暫無可定位資料"); return; }
      const fc = { type: "FeatureCollection", features: inc.map((x: any) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x.lon, x.lat] }, properties: { ...x, c: CABLE_STATUS[x.status]?.c || "#90a4ae" } })) } as any;
      if (m.getSource("cable-src")) (m.getSource("cable-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("cable-src", { type: "geojson", data: fc });
        m.addLayer({ id: "cable-pt", type: "circle", source: "cable-src", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 4, 11, 8], "circle-color": ["get", "c"], "circle-stroke-width": 1.5, "circle-stroke-color": "#0a1a24", "circle-opacity": 0.9 } });
        m.on("mouseenter", "cable-pt", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "cable-pt", () => { m.getCanvas().style.cursor = ""; });
        m.on("click", "cable-pt", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          const st = CABLE_STATUS[p.status] || { t: p.status, c: "#90a4ae" };
          const rs = CABLE_REASON[p.reason] || p.reason || "未知";
          const dd = (p.date || "").slice(0, 10);
          const etr = p.resolved_at ? ("已修復 " + String(p.resolved_at).slice(0, 10)) : (p.reparing_at ? ("預計修復 " + String(p.reparing_at).slice(0, 10)) : "處理中");
          cablePopRef.current?.remove();
          cablePopRef.current = new mapboxgl.Popup({ offset: 10, className: "hover-tip", maxWidth: "300px" }).setLngLat((f.geometry as any).coordinates).setHTML(
            `<div class="qpop"><b><span style="color:${st.c}">●</span> ${p.title || ""}</b><br/><span style="opacity:.85">${dd}・${st.t}・肇因：${rs}</span><br/><span style="opacity:.8;font-size:12px">${(p.description || "").slice(0, 140)}</span><br/><span style="opacity:.6;font-size:11px">${etr}・海纜:${p.cableid || ""}</span></div>`
          ).addTo(m);
        });
      }
      m.setLayoutProperty("cable-pt", "visibility", "visible");
      setCableOn(true);
      setCableInfo(`海纜事件 ${inc.length} 起可定位（共 ${d.count} 起/近2年${d.active ? "・發生中 " + d.active : ""}）　紅=斷線 黃=部分 藍=維護\n來源：${d.source || "smc.peering.tw"}`);
    } catch { setCableInfo("海纜事件載入失敗"); }
  }
  // ===== 共軍每日動態(國防部) =====
  const PLA_ZONE: Record<string, [number, number, string]> = {
    "西南": [119.0, 21.9, "西南空域"], "北部": [122.3, 26.2, "北部空域"],
    "中部": [119.3, 24.2, "中部空域"], "東部": [123.3, 23.4, "東部空域"], "東北": [123.2, 26.2, "東北空域"],
  };
  // ===== 海上異常事件(Global Fishing Watch)：會遇/滯留/AIS 中斷 =====
  // 為何做這三類：會遇=海上轉載補給、滯留=可疑徘徊(海纜區)、AIS 中斷=刻意關訊號
  const GW_KIND: Record<string, { c: string; t: string; d: string }> = {
    encounter: { c: "#ff6d00", t: "海上會遇", d: "兩船長時間近距離並航，常見於轉載/補給" },
    loitering: { c: "#ffd600", t: "異常滯留", d: "低速長時間徘徊，海纜區出現須留意" },
    gap: { c: "#e53935", t: "AIS 中斷", d: "訊號長時間消失，可能刻意關閉" },
  };
  async function toggleGfw() {
    const m = mapRef.current; if (!m) return;
    const on = !gwOn;
    if (!on) { if (m.getLayer("gw-pt")) m.setLayoutProperty("gw-pt", "visibility", "none"); gwPopRef.current?.remove(); setGwOn(false); setGwInfo(""); return; }
    setGwOn(true); setGwInfo("海上異常事件載入中…");
    try {
      const d = await fetch("/api/live?ds=gfw&days=30").then((r) => r.json());
      if (!d.ok) { setGwInfo(d.error === "GFW_TOKEN 未設定" ? "海上異常：尚未設定 GFW_TOKEN（Vercel 環境變數）" : `海上異常載入失敗：${d.error || ""}`); return; }
      const ev = (d.events || []) as any[];
      if (!ev.length) { setGwInfo("海上異常：近 30 天無事件"); return; }
      const fc = { type: "FeatureCollection", features: ev.map((x) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x.lon, x.lat] }, properties: { ...x, other: x.other ? JSON.stringify(x.other) : "", c: GW_KIND[x.kind]?.c || "#90a4ae", cn: x.flag === "中國" || (x.other && x.other.flag === "中國") } })) } as any;
      if (m.getSource("gw-src")) (m.getSource("gw-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("gw-src", { type: "geojson", data: fc });
        m.addLayer({
          id: "gw-pt", type: "circle", source: "gw-src",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3.5, 8, 6, 12, 10],
            "circle-color": ["get", "c"],
            "circle-opacity": 0.85,
            "circle-stroke-width": ["case", ["get", "cn"], 2.2, 1],
            "circle-stroke-color": ["case", ["get", "cn"], "#ffffff", "#0a1a24"],
          },
        });
        m.on("mouseenter", "gw-pt", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "gw-pt", () => { m.getCanvas().style.cursor = ""; });
        m.on("click", "gw-pt", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          const k = GW_KIND[p.kind] || { c: "#90a4ae", t: p.kind, d: "" };
          const tt = (v: string) => (v ? String(v).replace("T", " ").slice(0, 16) : "");
          const ship = `${p.name || "(未具名)"}${p.flag ? `・${p.flag}` : ""}${p.ssvid ? `・MMSI ${p.ssvid}` : ""}`;
          let o = "";
          try { const ov = p.other ? JSON.parse(p.other) : null; if (ov) o = `<br/>對象船：${ov.name || "(未具名)"}${ov.flag ? `・${ov.flag}` : ""}${ov.ssvid ? `・MMSI ${ov.ssvid}` : ""}`; } catch { }
          const meta = [p.hours != null ? `${p.hours} 小時` : "", p.km != null ? `${p.km} km` : "", p.shoreKm != null ? `離岸 ${p.shoreKm} km` : ""].filter(Boolean).join("・");
          gwPopRef.current?.remove();
          gwPopRef.current = new mapboxgl.Popup({ offset: 10, className: "hover-tip", maxWidth: "320px" }).setLngLat((f.geometry as any).coordinates).setHTML(
            `<div class="qpop"><b><span style="color:${k.c}">●</span> ${k.t}</b><br/><span style="opacity:.85">${tt(p.start)} → ${tt(p.end)}</span><br/><span style="opacity:.9">${ship}</span>${o}<br/><span style="opacity:.7;font-size:12px">${meta}</span><br/><span style="opacity:.55;font-size:11px">${k.d}<br/>Powered by Global Fishing Watch</span></div>`
          ).addTo(m);
        });
      }
      m.setLayoutProperty("gw-pt", "visibility", "visible");
      const b = d.by || {};
      const nw = d.newest ? String(d.newest).slice(0, 10) : "";
      setGwInfo(`海上異常 ${ev.length} 件／近 ${d.days} 天　橘=會遇 ${b.encounter || 0}　黃=滯留 ${b.loitering || 0}　紅=AIS中斷 ${b.gap || 0}\n白框＝涉中國籍 ${d.cn || 0} 件${d.truncated ? "・上游筆數過多，已優先保留中國籍／AIS中斷／船籍不明" : ""}\n最新事件 ${nw}（GFW 事件資料延遲約 3–4 週，非即時船位）　Powered by Global Fishing Watch (CC BY-NC 4.0)`);
    } catch { setGwInfo("海上異常載入失敗"); }
  }
  async function togglePlaDaily() {
    const m = mapRef.current; if (!m) return;
    const on = !pdOn;
    if (!on) { if (m.getLayer("pd-pt")) m.setLayoutProperty("pd-pt", "visibility", "none"); pdPopRef.current?.remove(); setPdOn(false); setPdInfo(""); return; }
    setPdOn(true); setPdInfo("共軍每日動態載入中…");
    try {
      let d: any = await fetch("/api/live?ds=pladaily").then((r) => r.json()).catch(() => null);
      if (!d || !d.ok || !(d.days || []).length) d = await fetch("/pla-daily.json").then((r) => r.json());
      const days: any[] = (d.days || []).slice().sort((a: any, b: any) => (b.date || "").localeCompare(a.date || ""));
      if (!days.length) { setPdInfo("共軍每日動態暫無資料"); return; }
      const agg: Record<string, { total: number; cnt: number }> = {};
      for (const day of days) for (const z of (day.zones || [])) { if (!PLA_ZONE[z]) continue; const a = agg[z] || (agg[z] = { total: 0, cnt: 0 }); a.total += day.sorties || 0; a.cnt++; }
      const feats = Object.keys(agg).map((z) => ({ type: "Feature", geometry: { type: "Point", coordinates: [PLA_ZONE[z][0], PLA_ZONE[z][1]] }, properties: { zone: PLA_ZONE[z][2], total: agg[z].total, cnt: agg[z].cnt } }));
      const fc = { type: "FeatureCollection", features: feats } as any;
      if (m.getSource("pd-src")) (m.getSource("pd-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("pd-src", { type: "geojson", data: fc });
        m.addLayer({ id: "pd-pt", type: "circle", source: "pd-src", paint: { "circle-radius": ["interpolate", ["linear"], ["get", "total"], 1, 8, 20, 18, 60, 30], "circle-color": ["interpolate", ["linear"], ["get", "total"], 1, "#ffca28", 15, "#fb8c00", 40, "#e53935"], "circle-opacity": 0.5, "circle-stroke-width": 1.5, "circle-stroke-color": "#e53935" } });
        m.on("mouseenter", "pd-pt", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "pd-pt", () => { m.getCanvas().style.cursor = ""; });
        m.on("click", "pd-pt", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          pdPopRef.current?.remove();
          pdPopRef.current = new mapboxgl.Popup({ offset: 10, className: "hover-tip", maxWidth: "260px" }).setLngLat((f.geometry as any).coordinates).setHTML(
            `<div class="qpop"><b>${p.zone}</b><br/>近 ${days.length} 日：共 <b>${p.total}</b> 架次進入・${p.cnt} 天有活動<br/><span style="opacity:.6;font-size:11px">來源：國防部每日空情</span></div>`
          ).addTo(m);
        });
      }
      m.setLayoutProperty("pd-pt", "visibility", "visible");
      setPdOn(true);
      const t = days[0];
      const zoneTxt = (t.zones || []).map((z: string) => PLA_ZONE[z]?.[2] || z).join("、");
      setPdInfo(`共軍動態 ${t.date}：共機 ${t.sorties} 架次${t.crossed ? "(逾越中線 " + t.entered + ")" : "(進入 " + t.entered + ")"}、共艦 ${t.ships}、公務船 ${t.coastguard}\n空域：${zoneTxt || "無"}　圓圈=近${days.length}日各空域累計架次\n來源：國防部每日戰報`);
    } catch { setPdInfo("共軍每日動態載入失敗"); }
  }
  // 立體樹：用 deck.gl IconLayer 貼一張「針葉樹」SVG 圖案，billboard(永遠面向鏡頭)、以公尺為單位
  // 依真實樹高縮放，底部釘在該點 DEM 海拔 → 樹站在地面上、隨地形前後遮擋。最簡單又最像樹的做法。
  const TREE_SVG = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='170' viewBox='0 0 120 170'>
      <rect x='52' y='140' width='16' height='30' fill='#5d4030'/>
      <polygon points='60,4 22,64 98,64' fill='#1f6b2e'/>
      <polygon points='60,40 14,104 106,104' fill='#2e8b3d'/>
      <polygon points='60,78 8,150 112,150' fill='#3fa34d'/>
    </svg>`.replace(/\s+/g, " ")
  );
  // 海流箭頭圖示：一根「白色實心錐形箭頭」(指向 +x/東)，用 mask 讓 getColor 依流速上色。
  // 比細線好看很多：邊緣平滑、比例一致、放大不糊。
  const ARROW_SVG = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='60' viewBox='0 0 160 60'>
      <path d='M4 24 L112 24 L112 8 L156 30 L112 52 L112 36 L4 36 Z' fill='#fff'/>
    </svg>`.replace(/\s+/g, " ")
  );
  function renderTreeCones(exag: number) {
    const m = mapRef.current;
    const trees = treeDataRef.current || [];
    if (!trees.length) { setDeckLayers("trees3d", []); return; }
    // 落地高度以「Mapbox 實際地形」為準(而非資料的 elev_m，兩者 DEM 有落差會導致樹被埋)；
    // 地形磚未載入時退回 elev_m。加 1m 微抬避免與地面 z-fighting。
    const data = trees.map((t: any) => {
      let z = m ? (m.queryTerrainElevation([t.lon, t.lat], { exaggerated: true }) as number) : null;
      if (z == null || !Number.isFinite(z)) z = t.extra?.elev_m || 0;
      return { lon: t.lon, lat: t.lat, h: t.h, z: z + 1 };
    });
    setDeckLayers("trees3d", [new IconLayer({
      id: "tree-icons",
      data,
      getPosition: (d: any) => [d.lon, d.lat, d.z],
      getIcon: () => ({ url: TREE_SVG, width: 120, height: 170, anchorX: 60, anchorY: 170, mask: false }),
      getSize: (d: any) => d.h * exag, // 樹高(公尺)×誇張倍率
      sizeUnits: "meters", billboard: true, sizeMinPixels: 10, pickable: false,
      updateTriggers: { getSize: exag }, // 誇張倍率改變時強制 deck 重算大小
    })]);
  }
  // 台灣巨木地圖(找樹的人/成大 空載光達，樹高>65m 候選巨木)
  async function toggleTrees() {
    const m = mapRef.current; if (!m) return;
    const on = !treesOn;
    if (!on) { if (m.getLayer("tree-pt")) m.setLayoutProperty("tree-pt", "visibility", "none"); treesPopRef.current?.remove(); setDeckLayers("trees3d", []); setTreesOn(false); setTreesInfo(""); return; }
    setTreesOn(true); setTreesInfo("巨木地圖載入中…");
    try {
      const d = await fetch("/giant-trees.json").then((r) => r.json());
      if (!(d.trees || []).length) { setTreesInfo("巨木資料暫無"); return; }
      treeDataRef.current = d.trees;
      renderTreeCones(treeExagRef.current); // 立體樹
      const fc = { type: "FeatureCollection", features: d.trees.map((t: any) => ({ type: "Feature", geometry: { type: "Point", coordinates: [t.lon, t.lat] }, properties: { id: t.id, h: t.h, name: t.name, elev: t.extra?.elev_m ?? "", status: t.extra?.status || "potential", species: t.extra?.species || "", dbh: t.extra?.DBH || t.extra?.dbh || "", pic: t.extra?.pic_url || "", video: t.extra?.video_url || "" } })) } as any;
      if (m.getSource("tree-src")) (m.getSource("tree-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("tree-src", { type: "geojson", data: fc });
        m.addLayer({
          id: "tree-pt", type: "circle", source: "tree-src",
          paint: {
            // 樹高越高越紅；已確認的畫大一點
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, ["case", ["==", ["get", "status"], "confirmed"], 5, 3], 12, ["case", ["==", ["get", "status"], "confirmed"], 9, 6]],
            "circle-color": ["interpolate", ["linear"], ["get", "h"], 65, "#a5d6a7", 70, "#66bb6a", 75, "#fdd835", 80, "#fb8c00", 85, "#e53935"],
            "circle-stroke-width": ["case", ["==", ["get", "status"], "confirmed"], 2, 0.8],
            "circle-stroke-color": ["case", ["==", ["get", "status"], "confirmed"], "#ffffff", "#14300f"],
            "circle-opacity": 0.92,
          },
        });
        m.on("mouseenter", "tree-pt", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "tree-pt", () => { m.getCanvas().style.cursor = ""; });
        m.on("click", "tree-pt", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          treesPopRef.current?.remove();
          const confirmed = p.status === "confirmed";
          const picHtml = p.pic ? `<br/><img src="${p.pic}" style="width:260px;max-width:70vw;border-radius:6px;margin-top:5px" onerror="this.style.display='none'"/>` : "";
          const vid = p.video ? `<br/><a href="${p.video}" target="_blank" rel="noopener" style="color:#7ec8ff;font-size:11.5px">影片 ↗</a>` : "";
          const spec = p.species ? `　樹種：${p.species}` : "";
          const dbh = p.dbh ? `　胸徑：${p.dbh}` : "";
          treesPopRef.current = new mapboxgl.Popup({ offset: 10, className: "hover-tip", maxWidth: "290px" }).setLngLat((f.geometry as any).coordinates).setHTML(
            `<div class="qpop"><b>🌲 ${p.name} 巨木</b> <span style="opacity:.7;font-size:11px">${confirmed ? "已現場確認" : "光達候選"}</span><br/>樹高約 <b>${Number(p.h).toFixed(1)} m</b>　海拔 ${p.elev} m${spec}${dbh}${picHtml}${vid}<br/><span style="opacity:.6;font-size:11px">找樹的人·空載光達推估樹冠頂點，非導覽座標；原始林無路徑，請勿貿然前往</span></div>`
          ).addTo(m);
        });
      }
      m.setLayoutProperty("tree-pt", "visibility", "visible");
      const conf = d.trees.filter((t: any) => t.extra?.status === "confirmed").length;
      const maxH = Math.max(...d.trees.map((t: any) => t.h || 0));
      setTreesInfo(`台灣巨木地圖 ${d.trees.length} 株（棲蘭/丹大·空載光達樹高>65m 候選，其中 ${conf} 株已現場確認）　最高約 ${maxH.toFixed(1)}m　點顏色＝樹高。來源：找樹的人`);
    } catch { setTreesInfo("巨木資料載入失敗"); }
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
      background: true, getBackgroundColor: [20, 20, 24, 245], backgroundPadding: [6, 3],
      // 關閉深度測試 → 矮柱的提示不會被前方高柱遮住，永遠畫在最上層
      parameters: { depthTest: false } as any,
      getPixelOffset: [0, -6],
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
    // 依目前時距重設柱高倍率與顏色分級(切換 1h/24h 時比例才正確)
    if (m.getLayer("rain-col")) {
      m.setPaintProperty("rain-col", "fill-extrusion-height", ["*", ["min", ["get", "r1"], rainCap(metric)], rainScale(metric)] as any);
      m.setPaintProperty("rain-col", "fill-extrusion-color", ["case", ["boolean", ["feature-state", "hover"], false], "#ffffff", ["interpolate", ["linear"], ["get", "r1"], ...rainColorStops(metric)]] as any);
    }
    if (m.getLayer("rain-dot")) {
      m.setPaintProperty("rain-dot", "circle-color", ["interpolate", ["linear"], ["get", "v"], ...rainDotStops(metric)] as any);
    }
    const peaks = rainPeaks(stations, metric).map((s: any) => ({ ...s, v: rainVal(s, metric), z: ((m.queryTerrainElevation([s.lon, s.lat], { exaggerated: true }) as number) || 0) + rainColH(metric, rainVal(s, metric)) }));
    setDeckLayers("rain", [new TextLayer({
      id: "rain-peak-text", data: peaks,
      getPosition: (d: any) => [d.lon, d.lat, d.z], getText: (d: any) => `${d.name} ${Math.round(d.v)}mm`,
      getSize: 13, sizeUnits: "pixels", getColor: [234, 244, 255, 255], billboard: true,
      fontFamily: '"Noto Sans TC","Microsoft JhengHei",sans-serif', characterSet: "auto",
      getTextAnchor: "middle", getAlignmentBaseline: "bottom",
      background: true, getBackgroundColor: [6, 16, 31, 210], backgroundPadding: [5, 3],
      parameters: { depthTest: false } as any, // 標號不被其他柱體遮擋
    })]);
    const wet = stations.filter((s: any) => rainVal(s, metric) > 0).length;
    const maxV = stations.reduce((a: number, s: any) => Math.max(a, rainVal(s, metric)), 0);
    setRainInfo(`${metric === "24h" ? "近24小時" : "近1小時"}雨量　全台 ${stations.length} 站、其中 ${wet} 站有雨${maxV > 0 ? `　最大 ${Math.round(maxV)}mm` : ""}${rainTimeRef.current ? `　觀測 ${rainTimeRef.current.slice(11, 16)}` : ""}\n柱高與雨量成正比(${rainScale(metric)}m/mm 誇張倍率)`);
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
        m.addLayer({ id: "rain-dot", type: "circle", source: "rain-dot", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 1.6, 11, 3.2], "circle-color": ["interpolate", ["linear"], ["get", "v"], ...rainDotStops(metric)] as any, "circle-stroke-width": 0 } });
        m.addLayer({
          id: "rain-col", type: "fill-extrusion", source: "rain",
          paint: {
            "fill-extrusion-color": ["case", ["boolean", ["feature-state", "hover"], false], "#ffffff", ["interpolate", ["linear"], ["get", "r1"], ...rainColorStops(metric)]] as any,
            "fill-extrusion-height": ["*", ["min", ["get", "r1"], rainCap(metric)], rainScale(metric)] as any,
            "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.8,
          },
        });
        m.on("mousemove", "rain-col", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          const z = ((m.queryTerrainElevation([p.cx, p.cy], { exaggerated: true }) as number) || 0) + rainColH(rainModeRef.current, p.r1);
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
      setShipsOn(true); setShipsInfo(d.count ? `中國籍船舶 ${d.count} 艘(近7天)` : "尚無資料(收集器每5分鐘持續收集存檔)");
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
  // ===== 河流圖層(改用 OSM 具名河川資料:含中文河名,常態顯示所有河名 + hover 高亮整條同名河流) =====
  // 從 OpenStreetMap Overpass 取台灣具名河川(waterway=river,含中文 name)。POST 請求 + localStorage 快取(14天)。
  async function loadTaiwanRivers(): Promise<any> {
    if (riversGeoRef.current) return riversGeoRef.current;
    try {
      const cached = localStorage.getItem("twRiversGeo");
      if (cached) { const o = JSON.parse(cached); if (o.t && Date.now() - o.t < 14 * 86400000 && o.geo?.features?.length) { riversGeoRef.current = o.geo; return o.geo; } }
    } catch {}
    const query = `[out:json][timeout:90];way["waterway"~"^(river|canal)$"]["name"](21.85,119.9,25.45,122.15);out geom;`;
    const endpoints = [
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass-api.de/api/interpreter",
      "https://overpass.private.coffee/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    ];
    let j: any = null;
    for (const ep of endpoints) {
      try {
        const res = await fetch(ep, { method: "POST", body: "data=" + encodeURIComponent(query) });
        if (!res.ok) continue;
        j = await res.json();
        if (j?.elements?.length) break;
      } catch {}
    }
    if (!j?.elements?.length) throw new Error("all overpass endpoints failed");
    const features = (j.elements || []).filter((e: any) => e.type === "way" && e.geometry?.length > 1).map((e: any) => ({
      type: "Feature",
      properties: { name: e.tags?.["name:zh"] || e.tags?.name || "" },
      geometry: { type: "LineString", coordinates: e.geometry.map((p: any) => [p.lon, p.lat]) },
    }));
    const geo = { type: "FeatureCollection", features };
    riversGeoRef.current = geo;
    try { localStorage.setItem("twRiversGeo", JSON.stringify({ t: Date.now(), geo })); } catch {}
    return geo;
  }
  async function toggleRivers() {
    const m = mapRef.current; if (!m) return;
    const on = !riversOn;
    const ids = ["rivers-line", "rivers-hit", "rivers-hl"];
    if (!on) { for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); riverPopRef.current?.remove(); setRiversOn(false); setRiversInfo(""); return; }
    setRiversOn(true);
    if (!m.getLayer("rivers-line")) {
      setRiversInfo("河名載入中…(OpenStreetMap 具名河川)");
      let geo: any; try { geo = await loadTaiwanRivers(); } catch { setRiversInfo("河名資料載入失敗，請稍後重試"); return; }
      if (!m || !mapRef.current) return;
      if (!m.getSource("tw-rivers")) m.addSource("tw-rivers", { type: "geojson", data: geo });
      const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
      m.addLayer({ id: "rivers-line", type: "line", source: "tw-rivers", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#4aa3df", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 11, 2.4], "line-opacity": 0.85 } }, beforeId);
      m.addLayer({ id: "rivers-hl", type: "line", source: "tw-rivers", filter: ["==", ["get", "name"], "___none___"], paint: { "line-color": "#9fe6ff", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 3, 11, 7], "line-opacity": 0.95, "line-blur": 0.5 } }, beforeId);
      // 寬透明線,加大 hover 命中範圍(細線不易指到)
      m.addLayer({ id: "rivers-hit", type: "line", source: "tw-rivers", paint: { "line-color": "#000", "line-opacity": 0.01, "line-width": 14 } }, beforeId);
      // 河名不常態顯示(3D 地形上沿線文字會被遮掉且易雜亂),改為 hover 時以浮標顯示該河河名
      m.on("mousemove", "rivers-hit", (e) => {
        const f = e.features?.[0]; if (!f) return; const nm = (f.properties as any)?.name; if (!nm) return;
        // 高亮該名稱指稱的整條同名河流(如濁水溪只亮濁水溪本流,支流各有其名不受影響)
        m.setFilter("rivers-hl", ["==", ["get", "name"], nm]);
        m.getCanvas().style.cursor = "pointer";
        riverPopRef.current?.remove();
        riverPopRef.current = new mapboxgl.Popup({ closeButton: false, offset: 8, className: "hover-tip" }).setLngLat(e.lngLat).setText(nm).addTo(m);
      });
      m.on("mouseleave", "rivers-hit", () => { m.setFilter("rivers-hl", ["==", ["get", "name"], "___none___"]); m.getCanvas().style.cursor = ""; riverPopRef.current?.remove(); });
      setRiversInfo(`河流：OpenStreetMap 具名河川 ${geo.features.length} 條　滑鼠指到可高亮整條並顯示河名`);
    } else {
      setRiversInfo(`河流：OpenStreetMap 具名河川　滑鼠指到可高亮整條並顯示河名`);
    }
    for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
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
    w(cctvOn, toggleCctv); w(currentsOn, toggleCurrents); w(plaOn, togglePla); w(cableOn, toggleCable); w(pdOn, togglePlaDaily); w(gwOn, toggleGfw);
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
      damExt: 1.9,
      level: 1104, crest: 1120,
      desc: "馬太鞍溪堰塞湖(花蓮萬榮)：2025/7 颱風誘發崩塌形成，9/4 滿水位約 1110m、湖面最大約 59.7 公頃、壩前水深逾 200m；9 月溢流致光復重災，10/23 縮至約 12.6 公頃。深藍=目前殘留湖面，淺藍=最大淹沒範圍，紅線=崩塌壩體。範圍由 30m DEM 淹沒推估(反算水位與官方吻合)。",
    },
    萬里溪: {
      max: [[121.3444,23.8555],[121.3455,23.8551],[121.346,23.8542],[121.3467,23.8536],[121.347,23.853],[121.347,23.852],[121.347,23.8511],[121.347,23.8501],[121.347,23.8492],[121.3463,23.8498],[121.3453,23.8508],[121.3443,23.8511],[121.3432,23.8504],[121.3422,23.8501],[121.3415,23.8492],[121.3405,23.8486],[121.3394,23.8486],[121.3386,23.849],[121.3379,23.8498],[121.3377,23.8508],[121.3386,23.8512],[121.3394,23.852],[121.3401,23.853],[121.341,23.8536],[121.342,23.8542],[121.3431,23.8547],[121.3439,23.8551],[121.3444,23.8555]],
      cur: [[121.3444,23.8555],[121.3455,23.8551],[121.346,23.8542],[121.3467,23.8536],[121.347,23.853],[121.347,23.852],[121.347,23.8511],[121.347,23.8501],[121.347,23.8492],[121.3463,23.8498],[121.3453,23.8508],[121.3443,23.8511],[121.3432,23.8504],[121.3422,23.8501],[121.3415,23.8492],[121.3405,23.8486],[121.3394,23.8486],[121.3386,23.849],[121.3379,23.8498],[121.3377,23.8508],[121.3386,23.8512],[121.3394,23.852],[121.3401,23.853],[121.341,23.8536],[121.342,23.8542],[121.3431,23.8547],[121.3439,23.8551],[121.3444,23.8555]],
      dam: [[121.3467,23.8488],[121.3467,23.8558]],
      damExt: 0.2,
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
      const [d, lv] = await Promise.all([
        fetch("/api/live?ds=barrierlake&t=" + Date.now()).then((r) => r.json()),
        fetch("/api/live?ds=lakelevel&t=" + Math.floor(Date.now() / 300000)).then((r) => r.json()).catch(() => null),
      ]);
      if (!d.ok || !(d.lakes || []).length) { setLakeInfo("堰塞湖資料暫時無法取得"); return; }
      lakeLevelRef.current = lv;
      const OFFICIAL = "https://qlakenew.forest.gov.tw/FarmlandQlakenew/LandslideDam";
      // 即時水位(林保署)：馬太鞍溪只有「下游橋」水位，湖面本身無感測器;萬里溪完全沒有即時水位
      const liveFor = (name: string) => {
        const b = lv?.matai_bridge, h = lv?.hehuan_lake;
        if (name.includes("馬太鞍") && b?.level != null) {
          return `即時水位（下游 ${b.name}）：<b>${b.level.toFixed(2)} m</b>${b.alertTop != null ? `　警戒 ${b.alertTop.toFixed(2)} m` : ""}<br/><span style="opacity:.75;font-size:11px">※此為下游橋河道水位，非湖面水位（湖面無感測器）${b.time ? `・${b.time}` : ""}</span>`;
        }
        if (name.includes("合歡溪") && h?.level != null) {
          return `湖面即時水位：<b>${h.level.toFixed(2)} m</b>${h.alertTop != null ? `　溢流 ${h.alertTop.toFixed(2)} m` : ""}${h.time ? `<br/><span style="opacity:.6;font-size:11px">${h.time}</span>` : ""}`;
        }
        if (name.includes("萬里溪")) return `<span style="opacity:.75;font-size:11px">※官方未公開此湖即時水位</span>`;
        return "";
      };
      const staticNote = (name: string) =>
        (name.includes("馬太鞍") || name.includes("萬里溪"))
          ? `<br/><span style="opacity:.7;font-size:11px">3D 湖面／湖體為 DEM 推估快照，非即時變動</span>` : "";
      const fc = { type: "FeatureCollection", features: d.lakes.map((l: any) => {
        const [lng, lat] = lakeCoord(l.name || "");
        const dk = Object.keys(LAKE_DESC).find((k) => (l.name || "").includes(k));
        return { type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { name: l.name, alert: l.alert || "gray", warn: l.warn ? 1 : 0, rainalert: l.rainalert || "無", upd: l.upd || "", desc: dk ? LAKE_DESC[dk] : "", live: liveFor(l.name || ""), snote: staticNote(l.name || "") } };
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
          const liveHtml = p.live ? `<div style="margin:5px 0;padding:5px 7px;background:rgba(60,140,220,0.16);border-radius:5px">${p.live}</div>` : "";
          lakePopRef.current = new mapboxgl.Popup({ offset: 12, className: "hover-tip", maxWidth: "340px" }).setLngLat((f.geometry as any).coordinates).setHTML(
            `<div class="qpop"><b>${p.name}</b><br/>狀態：${alertTxt(p.alert)}<br/>雨量警戒：${p.rainalert}${liveHtml}${descHtml}${p.snote || ""}<br/><span style="opacity:.6;font-size:11px">詳情見<a href="${OFFICIAL}" target="_blank" rel="noopener" style="color:#8ecbff">官方監測系統</a></span></div>`
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
        // 壩體往兩端延伸插入山壁(interleaved 會把山體內的部分遮掉)，使壩體貼緊兩側山壁封住谷口
        const dam = geom.dam as number[][];
        const ddx = dam[1][0] - dam[0][0], ddy = dam[1][1] - dam[0][1], EXT = (geom.damExt ?? 1.7);
        const damExt = [[dam[0][0] - ddx * EXT, dam[0][1] - ddy * EXT], [dam[1][0] + ddx * EXT, dam[1][1] + ddy * EXT]];
        damFeats.push({ type: "Feature", properties: { name: l.name, part: "toe" }, geometry: { type: "LineString", coordinates: damExt } });
        // 壩頂：往下游(東)平移一小段的平行線，表示壩體寬度與壩頂
        const crest = damExt.map((c) => [c[0] + 0.0016, c[1]]);
        damFeats.push({ type: "Feature", properties: { name: l.name, part: "crest" }, geometry: { type: "LineString", coordinates: crest } });
        const damBody = [[...damExt, ...crest.slice().reverse(), damExt[0]]];
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
      const b = lv?.matai_bridge, h = lv?.hehuan_lake;
      const liveBits: string[] = [];
      if (b?.level != null) liveBits.push(`馬太鞍溪橋(下游) ${b.level.toFixed(2)}m${b.alertTop != null ? `/警戒 ${b.alertTop.toFixed(2)}m` : ""}`);
      if (h?.level != null) liveBits.push(`合歡溪湖面 ${h.level.toFixed(2)}m${h.alertTop != null ? `/溢流 ${h.alertTop.toFixed(2)}m` : ""}`);
      setLakeInfo(`監測中堰塞湖 ${d.lakes.length} 處${nWarn ? `，警戒 ${nWarn} 處` : "，目前均無警戒"}${liveBits.length ? `\n即時水位：${liveBits.join("　")}` : ""}\n馬太鞍/萬里溪 3D 湖體為 DEM 推估快照(官方未公開湖面即時水位)`);
      setLakeOn(true);
    } catch { setLakeInfo("堰塞湖資料載入失敗"); }
  }
  // ===== 中國入侵/灰色地帶 時間軸密度圖層 =====
  // 月索引：2020-09 = 0
  function monthIdx(dateStr: string) { const d = new Date(dateStr); return (d.getUTCFullYear() - 2020) * 12 + d.getUTCMonth() - 8; }
  function idxLabel(idx: number) { const y = 2020 + Math.floor((idx + 8) / 12); const mo = ((idx + 8) % 12) + 1; return `${y}/${String(mo).padStart(2, "0")}`; }
  const GZ_COLOR = ["match", ["get", "type"], "air", "#ff6d00", "drill", "#d50000", "coastguard", "#ff9100", "cable", "#ffd600", "sea", "#2962ff", "survey", "#aa00ff", "watercannon", "#00b8d4", "ram", "#c51162", "laser", "#76ff03", "#bbbbbb"];
  const GZ_TYPE_TXT: Record<string, string> = { air: "共機空域侵擾", drill: "圍台軍演/軍事威懾", coastguard: "海警灰色地帶", cable: "海纜破壞", sea: "共艦動態", survey: "科研測繪", watercannon: "水砲攻擊", ram: "衝撞/包圍/登檢", laser: "軍規雷射照射" };
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
      let events: any[] = (d.ok && d.incursions) ? d.incursions.slice() : [];
      // 併入 AMTI 策展的東沙/南海事件(靜態檔，含明確日期/座標/來源 URL)
      try {
        const se = await fetch("/scs-events.json").then((r) => r.json());
        for (const e of (se.events || [])) {
          events.push({ ev_date: e.ev_date, type: e.type, zone: e.zone, lng: e.lng, lat: e.lat, cnt: e.cnt || 1, detail: e.detail, source: e.source, url: e.url || "", region: e.region });
        }
      } catch { /* 靜態事件檔拿不到就只用 DB 事件 */ }
      if (!events.length) { setGzInfo("入侵資料暫時無法取得(可能需先 seed)"); return; }
      gzDataRef.current = events;
      const maxIdx = Math.max(...events.map((e: any) => monthIdx(e.ev_date)), monthIdx(new Date().toISOString()));
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
    for (const s of st) {
      // 水利署 waterlevel 是「水位標高(海拔)」，真正的水深 = 水位標高 − 該站零點高程(zero_elev)
      const z = Number(s.zero_elev);
      const hasZ = Number.isFinite(z);
      // 水深合理範圍(公尺)：低於 -2m 或高於 60m 視為異常/缺測，不顯示數字
      const okD = (d: number | null) => d != null && Number.isFinite(d) && d > -2 && d < 60;
      const rawCur = hasZ ? Number(s.cur_level) - z : null;
      const curD = okD(rawCur) ? rawCur : null;
      const hasAvg = s.avg_level != null && s.avg_level !== "" && Number.isFinite(Number(s.avg_level));
      const rawAvg = (hasZ && hasAvg) ? Number(s.avg_level) - z : null;
      const avgD = okD(rawAvg) ? rawAvg : null;
      // 多數測站未提供零點高程，水深算不出來；水利署穩定提供的是「水位標高」。
      // 標籤統一顯示水位標高(m)：上=現在、下=平均，同一基準可直接比較(差值即 3D 水牆高度)。
      const curLv = Number(s.cur_level);
      const avgLv = hasAvg ? Number(s.avg_level) : null;
      const lbl = `${curLv.toFixed(2)}m\n──────\n${avgLv != null ? avgLv.toFixed(2) + "m" : "累積中"}`;
      ptF.push({ type: "Feature", properties: { name: s.name, river: s.river, cur: s.cur_level, avg: s.avg_level, curd: curD, avgd: avgD, z: hasZ ? z : null, w1: s.warn1, w2: s.warn2, w3: s.warn3, t: s.cur_time || "", lbl }, geometry: { type: "Point", coordinates: [s.lng, s.lat] } });
    }
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
    const ids = ["ww-base", "ww-top", "ww-pt", "ww-label"];
    if (!on) { for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); wallPopRef.current?.remove(); if (wallMoveRef.current) { m.off("moveend", wallMoveRef.current); wallMoveRef.current = null; } setWallOn(false); setWallInfo(""); return; }
    try {
      const d = await fetch("/api/live?ds=river&t=" + Math.floor(Date.now() / 60000)).then((r) => r.json());
      if (!d.ok || !(d.stations || []).length) { setWallInfo("河川水位資料暫時無法取得"); return; }
      // 濾掉缺測哨兵值(水利署以 -9999/-999 等表示無資料)與不合理高程，避免算出「負一百萬公分」
      const sane = (v: any) => typeof v === "number" && Number.isFinite(v) && v > -100 && v < 4000;
      wallDataRef.current = d.stations
        .filter((s: any) => typeof s.lng === "number" && typeof s.lat === "number" && sane(s.cur_level))
        .map((s: any) => ({ ...s, avg_level: sane(s.avg_level) ? s.avg_level : null, zero_elev: sane(s.zero_elev) ? s.zero_elev : null }));
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
        // 各觀測站常態顯示：現在水量 / 平均水量(絕對值 cm)
        m.addLayer({
          id: "ww-label", type: "symbol", source: "ww-pt-src", minzoom: 8,
          layout: {
            "text-field": ["get", "lbl"], "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 12, 13],
            "text-line-height": 1.05, "text-anchor": "bottom", "text-offset": [0, -0.6],
            "text-allow-overlap": false, "text-ignore-placement": false, "text-padding": 3,
          },
          paint: { "text-color": "#ffffff", "text-halo-color": "#06203f", "text-halo-width": 2 },
        });
        const wallHtml = (p: any) => {
          const tt = p.t ? String(p.t).replace("T", " ").slice(0, 16) : "";
          const d = (v: any) => (v == null || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
          const curd = d(p.curd), avgd = d(p.avgd);
          const depthLine = curd != null
            ? `即時水深 <b>${curd.toFixed(2)} m</b><br/>平均水深 ${avgd != null ? avgd.toFixed(2) + " m" : "累積中"}`
            : `即時水位標高 <b>${Number(p.cur).toFixed(2)} m</b><br/><span style="opacity:.7">(此站未提供零點高程，無法換算水深)</span>`;
          return `<div class="qpop"><b>${p.name || ""}</b> ${p.river || ""}<br/>${depthLine}<br/><span style="opacity:.75;font-size:11px">水位標高 ${Number(p.cur).toFixed(2)} m${p.z != null ? `・零點高程 ${Number(p.z).toFixed(2)} m` : ""}</span><br/>警戒 一${p.w1 ?? "-"}/二${p.w2 ?? "-"}/三${p.w3 ?? "-"} m${tt ? `<br/><span style="opacity:.6;font-size:11px">觀測 ${tt}</span>` : ""}</div>`;
        };
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
  // 颱風開關：關 → 颱風路徑(CWA 官方即時路徑)
  // 註:去背空照模式已移除 — NASA GIBS 為每日一張的靜態影像,無法與即時移動的颱風中心對位。
  async function cycleTyphoon() {
    const m = mapRef.current; if (!m) return;
    const next = (typhoonModeRef.current + 1) % 2;
    typhoonModeRef.current = next; setTyphoonMode(next);
    const mask = (show: boolean) => { if (m.getLayer("ty-mask")) m.setLayoutProperty("ty-mask", "visibility", show ? "visible" : "none"); };
    if (next === 0) { if (typhoonOn) await toggleTyphoon(); mask(false); applyBasemap("dark"); return; }
    if (!typhoonOn) await toggleTyphoon();
    applyBasemap("dark"); mask(false);
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
  // 海流流速色階(m/s)：藍→青→綠→黃→紅，把黑潮這種強流拉出來
  function curColor(s: number): [number, number, number] {
    const stops: [number, number[]][] = [[0, [40, 96, 200]], [0.3, [0, 190, 220]], [0.6, [60, 205, 110]], [0.9, [240, 215, 50]], [1.2, [240, 70, 40]], [1.6, [170, 0, 40]]];
    if (s <= stops[0][0]) return stops[0][1] as [number, number, number];
    if (s >= stops[stops.length - 1][0]) return stops[stops.length - 1][1] as [number, number, number];
    for (let i = 0; i < stops.length - 1; i++) { const [a, ca] = stops[i], [b, cb] = stops[i + 1]; if (s >= a && s <= b) { const f = (s - a) / (b - a); return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * f)) as [number, number, number]; } }
    return stops[stops.length - 1][1] as [number, number, number];
  }
  // 麥卡托 y 與其反函數(image source 是以麥卡托線性貼圖，跨大緯度必須照麥卡托列距取樣，否則會嚴重錯位)
  const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const invMercY = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

  function sstImage(d: any) {
    const coarse = d.coarse, fine = d.fine;
    const x0 = coarse.lon0, x1 = coarse.lon1, y0 = coarse.lat0, y1 = coarse.lat1;
    // 對單一網格做雙線性取樣(j 由南往北)
    const sampleGrid = (g: any, lon: number, lat: number): number | null => {
      if (!g) return null;
      const fx = (lon - g.lon0) / g.step, fy = (lat - g.lat0) / g.step;
      const i0 = Math.floor(fx), j0 = Math.floor(fy);
      if (i0 < 0 || j0 < 0 || i0 + 1 >= g.nx || j0 + 1 >= g.ny) return null;
      const tx = fx - i0, ty = fy - j0;
      const v: (number | null)[] = g.vals;
      const v00 = v[j0 * g.nx + i0], v10 = v[j0 * g.nx + i0 + 1];
      const v01 = v[(j0 + 1) * g.nx + i0], v11 = v[(j0 + 1) * g.nx + i0 + 1];
      // 以雙線性權重做「有效值加權平均」：靠岸格自然平滑，幾乎全是陸地的格則透明。
      // (舊寫法直接取最近有效值 → 會在陸地邊緣產生一格一格的平坦方塊)
      let sum = 0, wsum = 0;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      if (v00 != null) { sum += v00 * w00; wsum += w00; }
      if (v10 != null) { sum += v10 * w10; wsum += w10; }
      if (v01 != null) { sum += v01 * w01; wsum += w01; }
      if (v11 != null) { sum += v11 * w11; wsum += w11; }
      if (wsum < 0.5) return null; // 過半為陸地 → 不上色
      return sum / wsum;
    };
    // 台灣近海優先用 0.1° 細網格，其餘用 0.2° 粗網格
    const sample = (lon: number, lat: number): number | null => {
      const f = sampleGrid(fine, lon, lat);
      if (f != null) return f;
      return sampleGrid(coarse, lon, lat);
    };
    // 輸出畫布：x 線性於經度、y 線性於麥卡托
    const my0 = mercY(y0), my1 = mercY(y1);
    const W = 1800;
    const H = Math.round((W * (my1 - my0)) / (((x1 - x0) * Math.PI) / 180));
    let cv = oceanCanvasRef.current; if (!cv) { cv = document.createElement("canvas"); oceanCanvasRef.current = cv; }
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(W, H);
    for (let py = 0; py < H; py++) {
      const lat = invMercY(my1 + ((my0 - my1) * py) / (H - 1)); // 上=北
      for (let px = 0; px < W; px++) {
        const lon = x0 + ((x1 - x0) * px) / (W - 1);
        const v = sample(lon, lat);
        const o = (py * W + px) * 4;
        if (v == null) { img.data[o + 3] = 0; continue; }
        const c = sstColor(v);
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 190;
      }
    }
    ctx.putImageData(img, 0, 0);
    // 輕微模糊，柔化 0.2° 網格的方格邊界
    const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H;
    tmp.getContext("2d")!.drawImage(cv, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.filter = "blur(2px)";
    ctx.drawImage(tmp, 0, 0);
    ctx.filter = "none";
    // 依真實海岸線把陸地上的色彩精準挖掉(台灣本島/離島；其餘陸地在 MUR 本來就是 null)
    const geo = countyGeoRef.current;
    if (geo?.features) {
      const toPx = (lon: number, lat: number): [number, number] => [
        ((lon - x0) / (x1 - x0)) * W,
        ((my1 - mercY(lat)) / (my1 - my0)) * H,
      ];
      ctx.save(); ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = "#000";
      for (const f of geo.features) {
        const g = f.geometry; if (!g) continue;
        const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
        for (const poly of polys) {
          ctx.beginPath();
          for (const ring of poly) ring.forEach((c: number[], k: number) => { const [ppx, ppy] = toPx(c[0], c[1]); if (k === 0) ctx.moveTo(ppx, ppy); else ctx.lineTo(ppx, ppy); });
          ctx.closePath(); ctx.fill("evenodd");
        }
      }
      ctx.restore();
    }
    return { url: cv.toDataURL(), coords: [[x0, y1], [x1, y1], [x1, y0], [x0, y0]] as any };
  }
  async function toggleOcean() {
    const m = mapRef.current; if (!m) return;
    const on = !oceanOn;
    if (!on) { for (const id of ["ocean-sst", "ocean-sst-label"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); setOceanOn(false); setOceanInfo(""); oceanModeRef.current = 0; setOceanMode(0); return; }
    if (oceanModeRef.current === 0) { oceanModeRef.current = 1; setOceanMode(1); }
    try {
      const d = await fetch("/api/ocean").then((r) => r.json());
      if (!d.ok || !d.coarse?.vals?.length) { setOceanInfo("海溫資料暫無"); return; }
      const sh = sstImage(d);
      if (m.getSource("ocean-src")) (m.getSource("ocean-src") as any).updateImage({ url: sh.url });
      else { m.addSource("ocean-src", { type: "image", url: sh.url, coordinates: sh.coords }); m.addLayer({ id: "ocean-sst", type: "raster", source: "ocean-src", paint: { "raster-opacity": 0.7, "raster-resampling": "linear", "raster-fade-duration": 0 } }, m.getLayer("intel-pts") ? "intel-pts" : undefined); }
      m.setLayoutProperty("ocean-sst", "visibility", "visible");
      // 溫度數字：台灣近海(fine 0.1°)每 0.5° 標一個、遠海(coarse 0.2°)每 2° 標一個
      const labFeats: any[] = [];
      const addLabels = (g: any, every: number, skipInside?: any) => {
        if (!g?.vals) return;
        const stepIdx = Math.round(every / g.step);
        for (let j = 0; j < g.ny; j += stepIdx) for (let i = 0; i < g.nx; i += stepIdx) {
          const v = g.vals[j * g.nx + i];
          if (v == null) continue;
          const lon = g.lon0 + i * g.step, lat = g.lat0 + j * g.step;
          if (skipInside && lon >= skipInside.lon0 && lon <= skipInside.lon1 && lat >= skipInside.lat0 && lat <= skipInside.lat1) continue;
          labFeats.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { t: v.toFixed(1) } });
        }
      };
      addLabels(d.fine, 0.5);
      addLabels(d.coarse, 2, d.fine); // 遠海較疏，且不與細網格區重複
      const labFC = { type: "FeatureCollection", features: labFeats } as any;
      if (m.getSource("ocean-lab-src")) (m.getSource("ocean-lab-src") as mapboxgl.GeoJSONSource).setData(labFC);
      else { m.addSource("ocean-lab-src", { type: "geojson", data: labFC }); m.addLayer({ id: "ocean-sst-label", type: "symbol", source: "ocean-lab-src", layout: { "text-field": ["concat", ["to-string", ["get", "t"]], "°"], "text-size": ["interpolate", ["linear"], ["zoom"], 5, 9, 9, 13], "text-allow-overlap": false }, paint: { "text-color": "#ffffff", "text-halo-color": "#06203f", "text-halo-width": 1.4 } }); }
      // 溫度數字只在模式 2 顯示
      m.setLayoutProperty("ocean-sst-label", "visibility", oceanModeRef.current === 2 ? "visible" : "none");
      setOceanOn(true);
      setOceanInfo(`海表溫度 ${d.date || ""}（每日更新）\n來源：NASA JPL MUR SST 1km · NOAA ERDDAP`);
    } catch { setOceanInfo("海溫讀取失敗"); }
  }
  // 海溫循環：關 → 色溫底圖 → 色溫底圖+溫度數字
  async function cycleOcean() {
    const m = mapRef.current; if (!m) return;
    const next = (oceanModeRef.current + 1) % 3;
    oceanModeRef.current = next; setOceanMode(next);
    if (next === 0) { if (oceanOn) await toggleOcean(); return; }
    if (!oceanOn) { await toggleOcean(); }
    if (m.getLayer("ocean-sst-label")) m.setLayoutProperty("ocean-sst-label", "visibility", next === 2 ? "visible" : "none");
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
  // ===== 海陸輪廓線(全球海岸線，永遠疊在最上層) =====
  // 用 Mapbox 向量圖磚的 water 多邊形描邊 → 台灣本島、離島、日本、中國、越南…全球海陸界線都有
  function ensureCoast() {
    const m = mapRef.current; if (!m) return;
    if (!m.getLayer("coast-halo")) {
      // 深色底線 + 亮色細線，讓輪廓在空照/雲圖等任何底圖上都看得清楚
      m.addLayer({
        id: "coast-halo", type: "line", source: "composite", "source-layer": "water",
        layout: { "line-join": "round", "line-cap": "round", visibility: "none" },
        paint: { "line-color": "#04121f", "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 2.2, 6, 3.2, 12, 5] },
      });
      m.addLayer({
        id: "coast-line", type: "line", source: "composite", "source-layer": "water",
        layout: { "line-join": "round", "line-cap": "round", visibility: "none" },
        paint: { "line-color": "#7CFFCB", "line-opacity": 0.95, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.9, 6, 1.4, 12, 2.4] },
      });
    }
  }
  function coastToTop() {
    const m = mapRef.current; if (!m) return;
    for (const id of ["coast-halo", "coast-line"]) if (m.getLayer(id)) m.moveLayer(id); // 移到最上層
  }
  function toggleCoast() {
    const m = mapRef.current; if (!m) return;
    const on = !coastOn;
    ensureCoast();
    for (const id of ["coast-halo", "coast-line"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    if (on) coastToTop();
    setCoastOn(on);
  }
  // ===== 集水區面積雨量(流域多邊形 choropleth，近1小時/近24小時循環) =====
  async function cycleBasin() {
    const m = mapRef.current; if (!m) return;
    const next = (basinModeRef.current + 1) % 3;
    basinModeRef.current = next; setBasinMode(next);
    const ids = ["basin-fill", "basin-line", "basin-label"];
    if (next === 0) { for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); basinPopRef.current?.remove(); setBasinInfo(""); return; }
    try {
      if (!basinGeoRef.current) {
        setBasinInfo("集水區雨量載入中…");
        const [geo, data] = await Promise.all([
          fetch("/tw-basins.geojson").then((r) => r.json()),
          fetch("/api/basin?t=" + Math.floor(Date.now() / 300000)).then((r) => r.json()),
        ]);
        const byName: any = {}; for (const b of (data.basins || [])) byName[b.name || b.id] = b;
        for (const f of geo.features) { const b = byName[f.properties.name] || {}; f.properties.r1 = b.r1 ?? null; f.properties.r24 = b.r24 ?? null; f.properties.nS = b.nStations ?? 0; }
        basinGeoRef.current = { geo, time: data.time };
      }
      const { geo, time } = basinGeoRef.current;
      const metric = next === 2 ? "r24" : "r1";
      const stops1: any[] = [0, "#e8f4ff", 2, "#9ecae1", 8, "#4292c6", 20, "#2171b5", 50, "#08306b"];
      const stops24: any[] = [0, "#e8f4ff", 30, "#9ecae1", 100, "#4292c6", 200, "#2171b5", 400, "#08306b"];
      const fillColor: any = ["case", ["==", ["coalesce", ["get", metric], -1], -1], "rgba(120,130,140,0.25)",
        ["interpolate", ["linear"], ["get", metric], ...(metric === "r24" ? stops24 : stops1)]];
      if (m.getSource("basin-src")) (m.getSource("basin-src") as mapboxgl.GeoJSONSource).setData(geo);
      else {
        m.addSource("basin-src", { type: "geojson", data: geo });
        const beforeId = m.getLayer("intel-pts") ? "intel-pts" : undefined;
        m.addLayer({ id: "basin-fill", type: "fill", source: "basin-src", paint: { "fill-color": fillColor, "fill-opacity": 0.55 } }, beforeId);
        m.addLayer({ id: "basin-line", type: "line", source: "basin-src", paint: { "line-color": "#cfe8ff", "line-width": 1, "line-opacity": 0.7 } }, beforeId);
        m.addLayer({ id: "basin-label", type: "symbol", source: "basin-src", layout: { "text-field": ["get", "name"], "text-size": ["interpolate", ["linear"], ["zoom"], 6, 11, 10, 15], "text-allow-overlap": false }, paint: { "text-color": "#ffffff", "text-halo-color": "#08243b", "text-halo-width": 1.8 } });
        m.on("mousemove", "basin-fill", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          m.getCanvas().style.cursor = "pointer";
          const v1 = p.r1 == null || p.r1 === "" ? "—" : `${Number(p.r1).toFixed(1)} mm`;
          const v24 = p.r24 == null || p.r24 === "" ? "—" : `${Number(p.r24).toFixed(1)} mm`;
          basinPopRef.current?.remove();
          basinPopRef.current = new mapboxgl.Popup({ closeButton: false, offset: 6, className: "hover-tip", maxWidth: "240px" }).setLngLat(e.lngLat).setHTML(
            `<div class="qpop"><b>${p.name}集水區</b><br/>近1小時面積雨量 <b>${v1}</b><br/>近24小時面積雨量 <b>${v24}</b><br/><span style="opacity:.6;font-size:11px">流域內雨量站 ${p.nS || 0} 站，面積平均</span></div>`
          ).addTo(m);
        });
        m.on("mouseleave", "basin-fill", () => { m.getCanvas().style.cursor = ""; basinPopRef.current?.remove(); });
      }
      m.setPaintProperty("basin-fill", "fill-color", fillColor);
      // 標籤顯示流域名 + 目前指標數值
      m.setLayoutProperty("basin-label", "text-field", ["case", ["==", ["coalesce", ["get", metric], -1], -1], ["get", "name"], ["concat", ["get", "name"], "\n", ["to-string", ["round", ["get", metric]]], "mm"]] as any);
      for (const id of ids) m.setLayoutProperty(id, "visibility", "visible");
      setBasinInfo(`集水區${next === 2 ? "近24小時" : "近1小時"}面積雨量　26 條中央管河川流域${time ? `　${String(time).slice(11, 16)}` : ""}\n※流域界線為 MERIT-Basins 推估，平原河川略有誤差`);
    } catch { setBasinInfo("集水區雨量載入失敗"); }
  }
  // ===== 即時影像(多來源：國道/省道/河川/路口淹水；點擊看即時快照) =====
  // 資料源 /api/cams：公路局(省道) + 高公局(國道，官方服務時常中斷) + 水利署民生公共物聯網(河川/淹水)
  const CAM_CAT_COLOR: Record<string, string> = {
    freeway: "#ff7043",   // 國道 橘
    highway: "#ffd54f",   // 省道 黃
    river: "#4fc3f7",     // 河川/水利 藍
    flood: "#ab47bc",     // 路口淹水 紫
    scenic: "#66bb6a",    // 觀光景點 綠
  };
  const CAM_CAT_NAME: Record<string, string> = { freeway: "國道", highway: "省道", river: "河川", flood: "淹水", scenic: "景點" };
  // 依勾選的類別過濾點位(圖層本身仍是同一個 cctv-pt，只換 filter)
  function applyCamFilter(types: Set<string>) {
    const m = mapRef.current; if (!m || !m.getLayer("cctv-pt")) return;
    m.setFilter("cctv-pt", ["in", ["get", "cat"], ["literal", Array.from(types)]] as any);
  }
  function toggleCamType(t: string) {
    setCamTypes((prev) => {
      const n = new Set(prev);
      n.has(t) ? n.delete(t) : n.add(t);
      applyCamFilter(n);
      cctvPopRef.current?.remove();
      return n;
    });
  }
  async function toggleCctv() {
    const m = mapRef.current; if (!m) return;
    const on = !cctvOn;
    if (!on) { if (m.getLayer("cctv-pt")) m.setLayoutProperty("cctv-pt", "visibility", "none"); cctvPopRef.current?.remove(); setCctvOn(false); setCctvInfo(""); return; }
    setCctvOn(true); setCctvInfo("即時影像載入中…");
    try {
      const d = await fetch("/api/cams").then((r) => r.json());
      if (!d.ok || !(d.cams || []).length) { setCctvInfo("即時影像暫無"); return; }
      const srcByCat = d.srcByCat || {};
      const fc = { type: "FeatureCollection", features: d.cams.map((c: any) => ({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { cat: c.cat, name: c.name, desc: c.desc, img: c.img, src: srcByCat[c.cat] || "", link: c.link || "", approx: c.approx ? 1 : 0 } })) } as any;
      if (m.getSource("cctv-src")) (m.getSource("cctv-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("cctv-src", { type: "geojson", data: fc });
        m.addLayer({
          id: "cctv-pt", type: "circle", source: "cctv-src",
          paint: {
            // 景點鏡頭只有 62 支但可看性高，畫大一點以免淹沒在數千支路口鏡頭裡
            "circle-radius": ["interpolate", ["linear"], ["zoom"],
              6, ["case", ["==", ["get", "cat"], "scenic"], 4, 2.2],
              12, ["case", ["==", ["get", "cat"], "scenic"], 8, 5]],
            "circle-color": ["match", ["get", "cat"],
              "freeway", CAM_CAT_COLOR.freeway,
              "highway", CAM_CAT_COLOR.highway,
              "river", CAM_CAT_COLOR.river,
              "flood", CAM_CAT_COLOR.flood,
              "scenic", CAM_CAT_COLOR.scenic,
              "#bdbdbd"],
            "circle-stroke-width": ["case", ["==", ["get", "cat"], "scenic"], 1.6, 1],
            "circle-stroke-color": ["case", ["==", ["get", "cat"], "scenic"], "#0b2b12", "#20160a"],
            "circle-opacity": 0.9,
          },
        });
        m.on("mouseenter", "cctv-pt", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "cctv-pt", () => { m.getCanvas().style.cursor = ""; });
        m.on("click", "cctv-pt", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          cctvPopRef.current?.remove();
          const src = p.img ? `${p.img}${p.img.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 20000)}` : "";
          const imgHtml = src ? `<img src="${src}" style="width:280px;max-width:70vw;border-radius:6px;margin-top:5px" onerror="this.replaceWith(Object.assign(document.createElement('div'),{textContent:'（此鏡頭目前取不到畫面）',style:'opacity:.6;font-size:11px;margin-top:5px'}))"/>` : "";
          const tag = CAM_CAT_NAME[p.cat] || "";
          const col = CAM_CAT_COLOR[p.cat] || "#bdbdbd";
          const linkHtml = p.link ? `<br/><a href="${p.link}" target="_blank" rel="noopener" style="color:#7ec8ff;font-size:11px">在 YouTube 開啟直播 ↗</a>` : "";
          cctvPopRef.current = new mapboxgl.Popup({ offset: 10, className: "hover-tip", maxWidth: "300px" }).setLngLat((f.geometry as any).coordinates).setHTML(
            `<div class="qpop"><b><span style="color:${col}">●</span> ${p.name || ""}</b> <span style="opacity:.6;font-size:11px">${tag}</span><br/><span style="opacity:.85">${p.desc || ""}</span>${imgHtml}${linkHtml}<br/><span style="opacity:.6;font-size:11px">${p.src || ""}</span></div>`
          ).addTo(m);
        });
      }
      m.setLayoutProperty("cctv-pt", "visibility", "visible");
      applyCamFilter(camTypes); // 套用目前勾選的類別
      const counts: Record<string, number> = {};
      for (const c of (d.cats || [])) counts[c.cat] = c.count;
      setCamCounts(counts);
      const dead = (d.feeds || []).filter((f: any) => !f.ok).map((f: any) => f.name.replace(/\(.*/, ""));
      setCctvInfo(`即時影像 ${d.count} 支　點擊看即時畫面${dead.length ? `　※${dead.join("、")}官方服務目前中斷` : ""}`);
    } catch { setCctvInfo("即時影像載入失敗"); }
  }
  // ===== 即時海流(NRT 地轉流，箭頭) =====
  // 從原生 u/v 格網重新取樣：格距隨縮放連續調整，讓「螢幕上的箭頭密度」不論縮放都維持在 z6.77 的樣子。
  // 只取樣目前視窗範圍(箭頭數量恆定、效能穩)；放大超過原生解析度時用雙線性內插補密。
  const CUR_ANCHOR_Z = 6.77;
  function renderCurrents() {
    const m = mapRef.current; if (!m) return;
    const grid = curGridRef.current;
    if (!grid || !grid.map.size) { setDeckLayers("currents", []); return; }
    const { map: gm, lon0, lat0, lonMax, latMax, g } = grid;
    const zoom = m.getZoom();
    // 螢幕像素密度 ∝ step × 2^zoom；固定在 z6.77 的值 → step = g × 2^(6.77 − zoom)。
    let step = g * Math.pow(2, CUR_ANCHOR_Z - zoom);
    step = Math.max(g / 4, Math.min(4, step)); // 夾在 g/4(補密上限) ~ 4°
    curStepRef.current = step;
    // 雙線性內插取樣海流場
    const sample = (lon: number, lat: number): { u: number; v: number } | null => {
      const fx = (lon - lon0) / g, fy = (lat - lat0) / g;
      const i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fx - i0, ty = fy - j0;
      const c00 = gm.get(i0 + "_" + j0), c10 = gm.get((i0 + 1) + "_" + j0), c01 = gm.get(i0 + "_" + (j0 + 1)), c11 = gm.get((i0 + 1) + "_" + (j0 + 1));
      if (!c00 || !c10 || !c01 || !c11) { const c = c00 || c10 || c01 || c11; return c ? { u: c.u, v: c.v } : null; }
      return {
        u: (c00.u * (1 - tx) + c10.u * tx) * (1 - ty) + (c01.u * (1 - tx) + c11.u * tx) * ty,
        v: (c00.v * (1 - tx) + c10.v * tx) * (1 - ty) + (c01.v * (1 - tx) + c11.v * tx) * ty,
      };
    };
    const b = m.getBounds(); const pad = step * 2;
    const w = Math.max(lon0, b.getWest() - pad), e = Math.min(lonMax, b.getEast() + pad);
    const s = Math.max(lat0, b.getSouth() - pad), n = Math.min(latMax, b.getNorth() + pad);
    const arrows: any[] = [];
    for (let lat = Math.ceil(s / step) * step; lat <= n; lat += step) {
      for (let lon = Math.ceil(w / step) * step; lon <= e; lon += step) {
        const r = sample(lon, lat); if (!r) continue;
        const spd = Math.hypot(r.u, r.v); if (spd < 0.03) continue;
        arrows.push({ pos: [lon, lat], ang: (Math.atan2(r.v, r.u) * 180) / Math.PI, c: curColor(spd), sz: 12 + Math.min(spd, 1.5) * 10 });
        if (arrows.length > 4000) break; // 保險上限
      }
    }
    setDeckLayers("currents", [
      new IconLayer({
        id: "cur-arrows",
        data: arrows,
        getPosition: (d: any) => d.pos,
        getIcon: () => ({ url: ARROW_SVG, width: 160, height: 60, anchorX: 80, anchorY: 30, mask: true }),
        getAngle: (d: any) => d.ang,
        getColor: (d: any) => [...d.c, 235],
        getSize: (d: any) => d.sz,
        sizeUnits: "pixels", sizeMinPixels: 8, sizeMaxPixels: 34,
        billboard: true, pickable: false,
        parameters: { depthTest: false }, // 正俯視(pitch 0)也不被地形深度吃掉
      }),
    ]);
  }
  async function toggleCurrents() {
    const m = mapRef.current; if (!m) return;
    const on = !currentsOn;
    if (!on) {
      if (curMoveRef.current) { m.off("moveend", curMoveRef.current); curMoveRef.current = null; }
      curVecsRef.current = []; curGridRef.current = null; curStepRef.current = 0;
      setDeckLayers("currents", []); setCurrentsOn(false); setCurrentsInfo(""); return;
    }
    setCurrentsOn(true); setCurrentsInfo("海流載入中…");
    try {
      const d = await fetch("/api/live?ds=currents").then((r) => r.json());
      if (!d.ok || !(d.vecs || []).length) { setCurrentsInfo("海流資料暫無"); return; }
      curVecsRef.current = d.vecs;
      // 建立原生格網索引：偵測格距 g、原點、範圍
      let lon0 = Infinity, lat0 = Infinity, lonMax = -Infinity, latMax = -Infinity;
      const lonsSet = new Set<number>();
      for (const v of d.vecs) { lon0 = Math.min(lon0, v.lon); lat0 = Math.min(lat0, v.lat); lonMax = Math.max(lonMax, v.lon); latMax = Math.max(latMax, v.lat); lonsSet.add(v.lon); }
      const lons = [...lonsSet].sort((a, b) => a - b);
      let g = 0.25; for (let i = 1; i < lons.length; i++) { const dd = lons[i] - lons[i - 1]; if (dd > 0.001) { g = Math.min(g, dd); } }
      const gmap = new Map<string, { u: number; v: number }>();
      for (const v of d.vecs) { gmap.set(Math.round((v.lon - lon0) / g) + "_" + Math.round((v.lat - lat0) / g), { u: v.u, v: v.v }); }
      curGridRef.current = { map: gmap, lon0, lat0, lonMax, latMax, g };
      renderCurrents();
      if (!curMoveRef.current) { curMoveRef.current = () => renderCurrents(); m.on("moveend", curMoveRef.current); }
      setCurrentsOn(true);
      setCurrentsInfo(`即時海流 ${d.date || ""}　箭頭方向=流向、顏色=流速(密度隨縮放固定)\n來源：NRT 地轉流 · NOAA AOML CoastWatch`);
    } catch { setCurrentsInfo("海流載入失敗"); }
  }
  // ===== 解放軍基地及設施(社群 OSINT + 東海油氣平台) =====
  function applyPlaFilter(types: Set<string>) {
    const m = mapRef.current; if (!m || !m.getLayer("pla-pt")) return;
    m.setFilter("pla-pt", ["in", ["get", "cat"], ["literal", Array.from(types)]] as any);
  }
  function togglePlaType(t: string) {
    setPlaTypes((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); applyPlaFilter(n); plaPopRef.current?.remove(); return n; });
  }
  async function togglePla() {
    const m = mapRef.current; if (!m) return;
    const on = !plaOn;
    if (!on) { if (m.getLayer("pla-pt")) m.setLayoutProperty("pla-pt", "visibility", "none"); plaPopRef.current?.remove(); setPlaOn(false); setPlaInfo(""); return; }
    setPlaOn(true); setPlaInfo("解放軍設施載入中…");
    try {
      const d = await fetch("/api/live?ds=pla").then((r) => r.json());
      if (!d.ok || !(d.pts || []).length) { setPlaInfo("資料暫時無法取得(社群 uMap 常不穩)"); return; }
      const fc = { type: "FeatureCollection", features: d.pts.map((p: any) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { name: p.name, cat: p.cat, note: p.note || "", src: p.src || "osint", approx: p.approx ? 1 : 0 } })) } as any;
      const colorByCat: any = ["match", ["get", "cat"], ...PLA_CATS.flatMap(([k, c]) => [k, c]), "#b0bec5"];
      if (m.getSource("pla-src")) (m.getSource("pla-src") as mapboxgl.GeoJSONSource).setData(fc);
      else {
        m.addSource("pla-src", { type: "geojson", data: fc });
        m.addLayer({
          id: "pla-pt", type: "circle", source: "pla-src",
          paint: {
            // 油氣平台畫大一點(它是重點新增)
            "circle-radius": ["interpolate", ["linear"], ["zoom"],
              4, ["case", ["==", ["get", "cat"], "油氣平台"], 4, 2.2],
              10, ["case", ["==", ["get", "cat"], "油氣平台"], 7, 5]],
            "circle-color": colorByCat,
            "circle-stroke-width": ["case", ["==", ["get", "cat"], "油氣平台"], 1.4, 0.7],
            "circle-stroke-color": "rgba(0,0,0,0.6)", "circle-opacity": 0.9,
          },
        });
        m.on("mouseenter", "pla-pt", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "pla-pt", () => { m.getCanvas().style.cursor = ""; });
        m.on("click", "pla-pt", (e) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties as any;
          plaPopRef.current?.remove();
          const col = PLA_COLOR[p.cat] || "#b0bec5";
          const isPlat = p.cat === "油氣平台";
          const noteHtml = p.note ? `<br/><span style="opacity:.8;font-size:11.5px">${p.note}</span>` : "";
          const srcLine = isPlat
            ? `日本外務省確認・CSIS AMTI 座標　${p.approx ? "※此點為概略/合併標記" : ""}`
            : "社群整理·非官方 OSINT，僅供參考";
          plaPopRef.current = new mapboxgl.Popup({ offset: 10, className: "hover-tip", maxWidth: "280px" }).setLngLat((f.geometry as any).coordinates).setHTML(
            `<div class="qpop"><b>${p.name || ""}</b><br/><span style="color:${col}">●</span> ${p.cat || "其他"}${noteHtml}<br/><span style="opacity:.6;font-size:11px">${srcLine}</span></div>`
          ).addTo(m);
        });
      }
      m.setLayoutProperty("pla-pt", "visibility", "visible");
      applyPlaFilter(plaTypes);
      const counts: Record<string, number> = {};
      for (const p of d.pts) counts[p.cat] = (counts[p.cat] || 0) + 1;
      setPlaCounts(counts);
      setPlaInfo(`解放軍設施 ${d.pts.length} 處（社群 OSINT）＋東海油氣平台 ${d.platformCount || 0} 座（日本外務省/AMTI）　可用左側面板篩類別`);
    } catch { setPlaInfo("解放軍設施載入失敗"); }
  }
  // ===== 資訊下載區(防災/民防參考文件) =====
  async function toggleResources() {
    const next = !resOpen;
    setResOpen(next);
    if (next && !resList.length) {
      try { const d = await fetch("/resources.json").then((r) => r.json()); setResList(d.resources || []); } catch { /* ignore */ }
    }
  }
  const BASEMAP_LABEL = { dark: "原始", topo: "等高線", sat: "空照", nphoto: "正射(NLSC)", nmap: "電子地圖(NLSC)", rudy: "魯地圖(戶外)", gibs: "紅外雲圖", vis: "衛星空照圖" } as const;
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
        <strong>The Almanac　島嶼年鑑</strong>
        <span>Island Weather, Alerts &amp; News · 台灣各層面即時公開資料</span>
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
      {menuOpen && (basemap === "gibs" || basemap === "vis") && (
        <button className={"coast-btn" + (coastOn ? " on" : "")} onClick={toggleCoast} title="海陸輪廓線：把全球海岸線(台灣/離島/日本/中國/越南…)以亮線疊在最上層。僅在紅外雲圖/衛星空照圖底圖時可用">{coastOn ? "輪廓 ✓" : "輪廓"}</button>
      )}
      <div className={"layer-menu" + (menuOpen ? "" : " hidden")}>
        <button className={"focus-btn" + (focusOpen ? " on" : "")} onClick={() => setFocusOpen((v) => !v)} title="今日焦點：依嚴重度、來源層級、多來源佐證與時效計分排序，並自動壓低公關稿與例行公告">★ 今日焦點</button>
        <button className={"news-btn" + (newsOpen ? " on" : "")} onClick={() => setNewsOpen((o) => !o)} title="消息分類篩選(新聞與群眾回報)，面板顯示於左側">◂ 消息</button>
        <button className={"basemap-btn" + (basemap !== "dark" ? " on" : "")} onClick={cycleBasemap}title="切換底圖：原始 → 等高線 → 空照 → 紅外雲圖(向日葵Himawari每10分) → 衛星空照圖(VIIRS真彩每日)">底圖：{BASEMAP_LABEL[basemap]}</button>
        <button className={"rain-btn" + (rainOn ? " on" : "")} onClick={toggleRain} title="即時雨量 3D 水柱">雨量</button>
        <button className={"quake-btn" + (quakeOn ? " on" : "")} onClick={toggleQuake} title="近期地震：震央 + 震度擴散範圍">地震</button>
        <button className={"temp-btn" + (tempOn ? " on" : "")} onClick={toggleTemp} title="即時氣溫 3D 柱">氣溫</button>
        <button className={"sta-btn" + (staOn ? " on" : "")} onClick={toggleSta} title="測站位置(氣象/雨量/地震)">測站</button>
        <button className={"ty-btn" + (typhoonMode > 0 ? " on" : "")} onClick={cycleTyphoon} title="颱風：CWA 官方即時路徑(過去/現在/預報 + 暴風圈)">{typhoonMode === 0 ? "颱風" : "颱風：路徑"}</button>
        <button className={"ocean-btn" + (oceanMode > 0 ? " on" : "")} onClick={cycleOcean} title="海溫循環：關 → 色溫底圖 → 色溫底圖+溫度數字（NASA JPL MUR SST 每日）">{oceanMode === 0 ? "海溫" : oceanMode === 1 ? "海溫：色溫" : "海溫：色溫+數字"}</button>
        <button className={"river-btn" + (riverMode > 0 ? " on" : "")} onClick={cycleRiver} title="河流循環：關 → 河流線+河名 → 河流+即時水位高度">{riverMode === 0 ? "河流" : riverMode === 1 ? "河流：線" : "河流：即時水位"}</button>
        <button className={"ship-btn" + (shipsOn ? " on" : "")} onClick={toggleShips} title="中國籍船舶 AIS + 近7天航跡">中國船</button>
        <button className={"peak-btn" + (peaksOn ? " on" : "")} onClick={togglePeaks} title="台灣山岳:百岳/小百岳分層">山岳</button>
        <button className={"lake-btn" + (lakeOn ? " on" : "")} onClick={toggleLake} title="堰塞湖監測(林保署):馬太鞍溪/萬里溪為真實湖體">堰塞湖</button>
        <button className={"gz-btn" + (gzOn ? " on" : "")} onClick={toggleGrayZone} title="中國軍事/灰色地帶入侵紀錄：拉時間軸自選區間">中國入侵</button>
        <button className={"cctv-btn" + (cctvOn ? " on" : "")} onClick={toggleCctv} title="即時影像：國道(高公局)橘、省道(公路局)黃、河川(水利署)藍、路口淹水紫。點擊看即時畫面">即時影像</button>
        <button className={"currents-btn" + (currentsOn ? " on" : "")} onClick={toggleCurrents} title="即時海流(NRT 地轉流)：箭頭=流向、顏色=流速">海流</button>
        <button className={"pla-btn" + (plaOn ? " on" : "")} onClick={togglePla} title="解放軍基地及設施(社群 OSINT，非官方)">解放軍設施</button>
        <button className={"cable-btn" + (cableOn ? " on" : "")} onClick={toggleCable} title="海纜事件(斷纜/維護)：資料 smc.peering.tw，原始來源含數位發展部/中華電信。紅=斷線、黃=部分、藍=維護">🔌 海纜事件</button>
        <button className={"gw-btn" + (gwOn ? " on" : "")} onClick={toggleGfw} title="海上異常事件(Global Fishing Watch)：近30天臺海周邊的海上會遇、異常滯留、AIS 訊號中斷。橘=會遇、黃=滯留、紅=AIS中斷，白框=涉中國籍">🛰 海上異常</button>
        <button className={"pd-btn" + (pdOn ? " on" : "")} onClick={togglePlaDaily} title="共軍每日動態：國防部每日「中共解放軍臺海周邊海、空域動態」，將近14日各空域累計架次標在代表位置">📋 共軍動態</button>
        <button className={"basin-btn" + (basinMode > 0 ? " on" : "")} onClick={cycleBasin} title="集水區面積雨量循環：關 → 近1小時 → 近24小時(流域內雨量站面積平均)">{basinMode === 0 ? "集水區雨量" : basinMode === 1 ? "集水區：近1時" : "集水區：近24時"}</button>
        <button className={"landslide-btn" + (landslideOn ? " on" : "")} onClick={toggleLandslide} title="山崩與地滑地質敏感區(經濟部地礦中心)：疊在正射/等高線底圖上判讀高風險邊坡，行前避開">⛰ 山崩地滑</button>
        <button className={"shade-btn" + (shadeOn ? " on" : "")} onClick={toggleShade} title="光達地形暈渲(20m 多向陰影)：半透明疊在底圖上，強化稜線/溪谷立體感">🗻 地形暈渲</button>
        <button className={"slope-btn" + (slopeOn ? " on" : "")} onClick={toggleSlope} title="坡度圖(20m 光達)：越暖色越陡，登山風險判讀">📐 坡度圖</button>
        <button className={"tree-btn" + (treesOn ? " on" : "")} onClick={toggleTrees} title="台灣巨木地圖(找樹的人·空載光達)：立體樹依真實樹高，可調高度誇張度">🌲 巨木地圖</button>
        <button className={"wf-btn" + (wfOn ? " on" : "")} onClick={() => togglePoi("wf")} title="野溪瀑布(跟著小飛玩)：業餘整理祕境點位，僅供參考">💧 瀑布</button>
        <button className={"hs-btn" + (hsOn ? " on" : "")} onClick={() => togglePoi("hs")} title="野溪溫泉(跟著小飛玩)：業餘整理祕境點位，僅供參考">♨ 野溪溫泉</button>
        <button className={"res-btn" + (resOpen ? " on" : "")} onClick={toggleResources} title="資訊下載：防災／民防參考文件(小橘書、災害管理手冊)">📥 資訊下載</button>
      </div>
      <div className="layer-info-col">
        {gibsInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{gibsInfo}</div>}
        {riversInfo && <div className="li">{riversInfo}</div>}
        {rainInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{rainInfo}</div>}
        {quakeInfo && <div className="li">{quakeInfo}</div>}
        {tempInfo && <div className="li">{tempInfo}</div>}
        {typhoonInfo && <div className="li">{typhoonInfo}</div>}
        {oceanInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{oceanInfo}</div>}
        {wallInfo && <div className="li">{wallInfo}</div>}
        {shipsInfo && <div className="li">{shipsInfo}</div>}
        {peaksInfo && <div className="li">{peaksInfo}</div>}
        {lakeInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{lakeInfo}</div>}
        {gzInfo && <div className="li">{gzInfo}</div>}
        {cctvInfo && <div className="li">{cctvInfo}</div>}
        {currentsInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{currentsInfo}</div>}
        {plaInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{plaInfo}</div>}
        {cableInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{cableInfo}</div>}
        {gwInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{gwInfo}</div>}
        {pdInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{pdInfo}</div>}
        {basinInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{basinInfo}</div>}
        {treesInfo && <div className="li" style={{ whiteSpace: "pre-line" }}>{treesInfo}</div>}
        {wfInfo && <div className="li">{wfInfo}</div>}
        {hsInfo && <div className="li">{hsInfo}</div>}
      </div>
      {resOpen && (
        <div className="res-overlay" onClick={() => setResOpen(false)}>
          <div className="res-card" onClick={(e) => e.stopPropagation()}>
            <div className="res-head">
              <b>資訊下載　防災／民防參考文件</b>
              <button className="res-x" onClick={() => setResOpen(false)}>✕</button>
            </div>
            <div className="res-sub">連結指向各發行機關官方頁面（非本站轉存），確保為最新版本。</div>
            {resList.length === 0 && <div className="res-sub">載入中…</div>}
            {resList.map((r, i) => (
              <div className="res-item" key={i}>
                <div className="res-title">{r.title}</div>
                {r.subtitle && <div className="res-st">{r.subtitle}</div>}
                <div className="res-meta">{r.org}　·　{r.year}　·　{r.lang}</div>
                <div className="res-desc">{r.desc}</div>
                <div className="res-tags">{(r.tags || []).map((t: string, j: number) => <span className="res-tag" key={j}>{t}</span>)}</div>
                <div className="res-links">
                  {(r.links || []).map((l: any, j: number) => (
                    <a className="res-link" key={j} href={l.url} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {focusOpen && (
        <div className="focus-panel">
          <div className="fp-head">
            <span>★ 今日焦點</span>
            <span className="fp-sub">{focus.length ? `近7日 ${focus.length} 則值得注意` : "計算中／暫無達標事件"}</span>
          </div>
          {focus.map((e, i) => {
            const cat = ((e.categories || "").split(",")[0] || "policy") as string;
            const d = e.published_at ? new Date(e.published_at) : null;
            const when = d ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
            return (
              <div key={e.hash || i} className="fp-item" onClick={() => flyToEvent(e)}>
                <span className="fp-rank" style={{ background: COLOR[cat] || "#888" }}>{i + 1}</span>
                <div className="fp-body">
                  <div className="fp-title">{e.title}</div>
                  <div className="fp-meta">
                    {when}　{e.source_name}{e.county ? "・" + e.county : ""}
                    {e._n > 1 && <span className="fp-corr">{e._n} 源佐證</span>}
                  </div>
                </div>
              </div>
            );
          })}
          {!focus.length && <div className="fp-empty">目前沒有超過門檻的事件（公關稿與例行公告已自動過濾）</div>}
        </div>
      )}
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
      {cctvOn && (
        <div className="cam-panel">
          {([["freeway", "國道"], ["highway", "省道"], ["river", "河川"], ["flood", "淹水"], ["scenic", "景點"]] as const).map(([k, label]) => (
            <label key={k} className="sta-opt">
              <input type="checkbox" checked={camTypes.has(k)} onChange={() => toggleCamType(k)} />
              <span className="sta-dot" style={{ background: CAM_CAT_COLOR[k] }} />{label}
              <span style={{ opacity: 0.55, marginLeft: 4 }}>{camCounts[k] ?? 0}</span>
            </label>
          ))}
        </div>
      )}
      {treesOn && (
        <div className="peak-panel" style={{ top: 300 }}>
          <label>樹高誇張 <b>{treeExag}×</b>
            <input type="range" min={1} max={30} step={1} value={treeExag} onChange={(e) => { const v = Number(e.target.value); setTreeExag(v); treeExagRef.current = v; renderTreeCones(v); }} />
          </label>
          <span style={{ fontSize: 11, opacity: 0.6 }}>1×＝真實比例(遠看極小)，放大以看清立體樹</span>
        </div>
      )}
      {plaOn && (
        <div className="pla-panel">
          {PLA_CATS.filter(([k]) => (plaCounts[k] ?? 0) > 0).map(([k, c]) => (
            <label key={k} className="sta-opt">
              <input type="checkbox" checked={plaTypes.has(k)} onChange={() => togglePlaType(k)} />
              <span className="sta-dot" style={{ background: c }} />{k}
              <span style={{ opacity: 0.55, marginLeft: 4 }}>{plaCounts[k] ?? 0}</span>
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
      {currentsOn && (
        <div className="sst-legend">
          <span className="qlg-title">流速 m/s</span>
          {[0.15, 0.45, 0.75, 1.05, 1.35].map((s) => (<span key={s} className="qlg-sw" style={{ background: `rgb(${curColor(s).join(",")})` }}>{s.toFixed(1)}</span>))}
        </div>
      )}
      {zoomInfo && (
        <div style={{ position: "absolute", left: 8, bottom: 40, zIndex: 5, background: "rgba(18,20,24,.82)", color: "#e6eaf0", font: "12px/1.4 system-ui,sans-serif", padding: "4px 8px", borderRadius: 6, pointerEvents: "none", whiteSpace: "nowrap" }}>{zoomInfo}</div>
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
