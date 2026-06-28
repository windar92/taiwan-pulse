import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;
const HOME_KEY = "tp-home";
const DEFAULT_HOME = { lng: 120.95, lat: 23.8, zoom: 7.3 };
const COUNTY_GEOJSON = "https://raw.githubusercontent.com/g0v/twgeojson/master/json/twCounty2010.geo.json";

type Cat = "disaster" | "safety" | "warning" | "policy" | "ecology" | "activity" | "report";
const CATS: { id: Cat; label: string; color: string }[] = [
  { id: "disaster", label: "自然災害", color: "#ef5350" },
  { id: "safety", label: "公共安全", color: "#ff8a65" },
  { id: "warning", label: "警戒管制", color: "#ffd54f" },
  { id: "policy", label: "政策民生", color: "#4fc3f7" },
  { id: "ecology", label: "生態", color: "#81c784" },
  { id: "activity", label: "活動", color: "#ba68c8" },
  { id: "report", label: "回報牆", color: "#26c6da" },
];
const PRIORITY: Cat[] = ["disaster", "safety", "warning", "policy", "ecology", "activity"];
const COLOR: Record<string, string> = Object.fromEntries(CATS.map((c) => [c.id, c.color]));

function loadHome() {
  try {
    const v = JSON.parse(localStorage.getItem(HOME_KEY) || "null");
    if (v && typeof v.lng === "number") return v;
  } catch {}
  return DEFAULT_HOME;
}
const norm = (s: string) => (s || "").replace(/台/g, "臺");

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const countyKeyRef = useRef<string>("COUNTYNAME");
  const [visible, setVisible] = useState<Set<Cat>>(new Set(CATS.map((c) => c.id)));
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [showMemo, setShowMemo] = useState(false);
  const [memoSaved, setMemoSaved] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !TOKEN) return;
    const home = loadHome();
    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      projection: { name: "mercator" },
      center: [home.lng, home.lat],
      zoom: home.zoom || 7.3,
      pitch: 25,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("style.load", async () => {
      // 縣市界（影響範圍高亮用）
      try {
        const gj = await fetch(COUNTY_GEOJSON).then((r) => r.json());
        const props = gj.features?.[0]?.properties || {};
        countyKeyRef.current =
          Object.keys(props).find((k) => /[縣市]$/.test(String(props[k]))) || "COUNTYNAME";
        map.addSource("tw-county", { type: "geojson", data: gj });
        map.addLayer({
          id: "county-hl-fill", type: "fill", source: "tw-county",
          paint: { "fill-color": "#ffffff", "fill-opacity": 0.12 },
          filter: ["==", ["get", countyKeyRef.current], "___none___"],
        });
        map.addLayer({
          id: "county-hl-line", type: "line", source: "tw-county",
          paint: { "line-color": "#ffd54f", "line-width": 2.2, "line-opacity": 0.9 },
          filter: ["==", ["get", countyKeyRef.current], "___none___"],
        });
      } catch {}

      map.addSource("intel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "intel-pts", type: "circle", source: "intel",
        paint: {
          "circle-radius": ["case", ["==", ["get", "cat"], "report"], 6, 7],
          "circle-color": ["match", ["get", "cat"],
            "disaster", COLOR.disaster, "safety", COLOR.safety, "warning", COLOR.warning,
            "policy", COLOR.policy, "ecology", COLOR.ecology, "activity", COLOR.activity,
            "report", COLOR.report, "#888"],
          "circle-opacity": 0.85, "circle-stroke-width": 1.3, "circle-stroke-color": "rgba(255,255,255,0.85)",
        },
      });

      const popup = new mapboxgl.Popup({ closeButton: true, maxWidth: "330px" });
      const highlight = (county: string | null) => {
        const k = countyKeyRef.current;
        const f: any = county
          ? ["any", ["==", ["get", k], norm(county)], ["==", ["get", k], county]]
          : ["==", ["get", k], "___none___"];
        if (map.getLayer("county-hl-fill")) map.setFilter("county-hl-fill", f);
        if (map.getLayer("county-hl-line")) map.setFilter("county-hl-line", f);
      };
      map.on("mouseenter", "intel-pts", (e) => {
        map.getCanvas().style.cursor = "pointer";
        highlight((e.features?.[0]?.properties as any)?.county || null);
      });
      map.on("mouseleave", "intel-pts", () => {
        map.getCanvas().style.cursor = "";
        highlight(null);
      });
      map.on("click", "intel-pts", (e) => {
        const f = e.features?.[0]; if (!f) return;
        const p = f.properties as any;
        highlight(p.county || null);
        const link = p.url ? `<a href="${p.url}" target="_blank" rel="noopener" style="color:#4fc3f7">開啟原文 ↗</a>` : "";
        const tags = (p.cats || "").split(",").map((c: string) => CATS.find((x) => x.id === c)?.label || c).join("・");
        popup.setLngLat((f.geometry as any).coordinates).setHTML(
          `<div style="font:13px/1.55 sans-serif;color:#111">
             <div style="font-weight:700;margin-bottom:4px">${p.title || ""}</div>
             <div style="color:#444;margin-bottom:6px">${p.summary || ""}</div>
             <div style="font-size:11px;color:#888">${tags}${p.source ? " · " + p.source : ""}${p.county ? " · " + p.county : ""}</div>
             <div style="margin-top:6px">${link}</div>
           </div>`).addTo(map);
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
    const map = mapRef.current;
    if (!map) return;
    const [evRes, rpRes] = await Promise.all([
      fetch(`/api/events?days=7`).then((r) => r.json()).catch(() => null),
      fetch(`/api/reports?radius=%E5%85%A8%E5%9C%8B&days=14`).then((r) => r.json()).catch(() => null),
    ]);
    const features: any[] = [];
    const tally: Record<string, number> = {};
    const primary = (cats: string): Cat => {
      const arr = (cats || "").split(",");
      return (PRIORITY.find((c) => arr.includes(c)) as Cat) || "policy";
    };
    if (evRes?.ok) {
      for (const e of evRes.events || []) {
        if (typeof e.lng !== "number") continue;
        const cat = primary(e.categories);
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: [e.lng, e.lat] },
          properties: { cat, cats: e.categories, title: e.title, summary: e.summary, source: e.source_name, url: e.url, county: e.county } });
        tally[cat] = (tally[cat] || 0) + 1;
      }
    }
    if (rpRes?.ok) {
      for (const r of rpRes.reports || []) {
        if (typeof r.lng !== "number") continue;
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: [r.lng, r.lat] },
          properties: { cat: "report", cats: "report", title: r.title, summary: r.body, source: r.kind, url: "", county: "" } });
        tally.report = (tally.report || 0) + 1;
      }
    }
    (map.getSource("intel") as mapboxgl.GeoJSONSource)?.setData({ type: "FeatureCollection", features } as any);
    setCounts(tally);
  }

  function recenter() {
    const map = mapRef.current; if (!map) return;
    const h = loadHome();
    map.flyTo({ center: [h.lng, h.lat], zoom: h.zoom || 7.3, duration: 1100 });
  }
  function memorize() {
    const map = mapRef.current; if (!map) return;
    const c = map.getCenter();
    localStorage.setItem(HOME_KEY, JSON.stringify({ lng: c.lng, lat: c.lat, zoom: map.getZoom() }));
    setMemoSaved(true); setTimeout(() => setMemoSaved(false), 1600);
  }
  function toggle(cat: Cat) {
    setVisible((p) => { const n = new Set(p); n.has(cat) ? n.delete(cat) : n.add(cat); return n; });
  }

  if (!TOKEN) return <div className="token-missing"><div><strong>尚未設定 Mapbox token</strong></div></div>;

  return (
    <>
      <div id="map" ref={containerRef} />
      <div className="brand">
        <strong>台灣情報脈動</strong>
        <span>各地即時消息與公部門公開資料</span>
      </div>
      <div className="center-control" onMouseEnter={() => setShowMemo(true)} onMouseLeave={() => setShowMemo(false)}>
        {showMemo && (
          <button className="memo-btn" onClick={memorize} title="把目前畫面中心設為我的置中位置">
            {memoSaved ? "已記憶 ✓" : "記憶"}
          </button>
        )}
        <button className="ctr-btn" onClick={recenter} title="回到我的置中位置">⌖</button>
      </div>
      <div className="legend">
        {CATS.map((c) => (
          <button key={c.id} className={"legend-item" + (visible.has(c.id) ? "" : " off")} onClick={() => toggle(c.id)}>
            <span className="dot" style={{ background: c.color }} />{c.label}
            <span className="cnt">{counts[c.id] || 0}</span>
          </button>
        ))}
      </div>
    </>
  );
}
