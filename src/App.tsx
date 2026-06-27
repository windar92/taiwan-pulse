import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { geocode } from "./gazetteer";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;
const HOME_KEY = "tp-home";
const DEFAULT_HOME = { lng: 120.95, lat: 23.8, zoom: 7.3 };

type Cat = "news" | "gov" | "activity" | "disaster" | "quake" | "report";

const CATS: { id: Cat; label: string; color: string }[] = [
  { id: "news", label: "新聞", color: "#4fc3f7" },
  { id: "gov", label: "政府", color: "#ffb74d" },
  { id: "activity", label: "活動", color: "#ba68c8" },
  { id: "disaster", label: "災害", color: "#e57373" },
  { id: "quake", label: "地震", color: "#ff7043" },
  { id: "report", label: "回報牆", color: "#66bb6a" },
];

function loadHome() {
  try {
    const v = JSON.parse(localStorage.getItem(HOME_KEY) || "null");
    if (v && typeof v.lng === "number") return v;
  } catch {}
  return DEFAULT_HOME;
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [visible, setVisible] = useState<Set<Cat>>(new Set(CATS.map((c) => c.id)));
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [showMemo, setShowMemo] = useState(false);
  const [memoSaved, setMemoSaved] = useState(false);
  const fetchTimer = useRef<number | undefined>(undefined);

  // 建立地圖
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
      pitch: 30,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("style.load", () => {
      map.addSource("intel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "intel-pts",
        type: "circle",
        source: "intel",
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "category"], "quake"],
            ["+", 5, ["*", 1.6, ["coalesce", ["get", "mag"], 3]]],
            7,
          ],
          "circle-color": [
            "match",
            ["get", "category"],
            "news", "#4fc3f7",
            "gov", "#ffb74d",
            "activity", "#ba68c8",
            "disaster", "#e57373",
            "quake", "#ff7043",
            "report", "#66bb6a",
            "#888",
          ],
          "circle-opacity": 0.82,
          "circle-stroke-width": 1.4,
          "circle-stroke-color": "rgba(255,255,255,0.85)",
        },
      });

      const popup = new mapboxgl.Popup({ closeButton: true, maxWidth: "320px" });
      map.on("click", "intel-pts", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as any;
        const link = p.link
          ? `<a href="${p.link}" target="_blank" rel="noopener" style="color:#4fc3f7">開啟原文 ↗</a>`
          : "";
        popup
          .setLngLat((f.geometry as any).coordinates)
          .setHTML(
            `<div style="font:13px/1.5 sans-serif;color:#111">
               <div style="font-weight:700;margin-bottom:4px">${p.title || ""}</div>
               <div style="color:#444;margin-bottom:6px">${p.summary || ""}</div>
               <div style="font-size:11px;color:#888">${p.tag || ""}${p.source ? " · " + p.source : ""}</div>
               <div style="margin-top:6px">${link}</div>
             </div>`,
          )
          .addTo(map);
      });
      map.on("mouseenter", "intel-pts", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "intel-pts", () => (map.getCanvas().style.cursor = ""));

      loadData();
      map.on("moveend", () => {
        window.clearTimeout(fetchTimer.current);
        fetchTimer.current = window.setTimeout(loadData, 600);
      });
    });

    return () => map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 套用圖層可見性
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("intel-pts")) return;
    map.setFilter("intel-pts", ["in", ["get", "category"], ["literal", Array.from(visible)]]);
  }, [visible]);

  async function loadData() {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    const z = map.getZoom();
    const radius = z < 8.5 ? "全國" : "10km";
    setLoading(true);
    try {
      const params = new URLSearchParams({ lat: c.lat.toFixed(3), lng: c.lng.toFixed(3), radius, time: "3天" });
      const [profile, reportsRes] = await Promise.all([
        fetch(`/api/profile?${params}`).then((r) => r.json()).catch(() => null),
        fetch(`/api/reports?lat=${c.lat.toFixed(3)}&lng=${c.lng.toFixed(3)}&radius=${radius}&days=7`).then((r) => r.json()).catch(() => null),
      ]);
      const features: any[] = [];
      const tally: Record<string, number> = {};
      const add = (cat: Cat, lng: number, lat: number, props: any) => {
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { category: cat, ...props } });
        tally[cat] = (tally[cat] || 0) + 1;
      };
      const geoItems = (items: any[], cat: Cat, tag: string) => {
        for (const it of items || []) {
          const g = geocode(`${it.title || ""} ${it.summary || ""}`);
          if (!g) continue;
          add(cat, g[0], g[1], { title: it.title, summary: it.summary, source: it.source, link: it.link, tag });
        }
      };
      if (profile && profile.ok) {
        geoItems([...(profile.news || []), ...(profile.nationalNews || [])], "news", "新聞");
        geoItems(profile.government, "gov", "政府");
        geoItems(profile.activities, "activity", "活動");
        geoItems(profile.disasters, "disaster", "災害");
        for (const q of profile.earthquakes || []) {
          if (typeof q.lng === "number" && typeof q.lat === "number")
            add("quake", q.lng, q.lat, { title: `地震 M${q.mag} ${q.place || ""}`, summary: `深度 ${q.depthKm ?? "?"} km`, source: "USGS", link: q.url, tag: "地震", mag: q.mag });
        }
      }
      if (reportsRes && reportsRes.ok) {
        for (const r of reportsRes.reports || []) {
          if (typeof r.lng === "number" && typeof r.lat === "number")
            add("report", r.lng, r.lat, { title: r.title, summary: r.body, source: r.kind, link: "", tag: r.verdict || "群眾回報" });
        }
      }
      (map.getSource("intel") as mapboxgl.GeoJSONSource)?.setData({ type: "FeatureCollection", features } as any);
      setCounts(tally);
    } finally {
      setLoading(false);
    }
  }

  function recenter() {
    const map = mapRef.current;
    if (!map) return;
    const home = loadHome();
    map.flyTo({ center: [home.lng, home.lat], zoom: home.zoom || 7.3, duration: 1200 });
  }
  function memorize() {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    localStorage.setItem(HOME_KEY, JSON.stringify({ lng: c.lng, lat: c.lat, zoom: map.getZoom() }));
    setMemoSaved(true);
    setTimeout(() => setMemoSaved(false), 1600);
  }
  function toggle(cat: Cat) {
    setVisible((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  }

  if (!TOKEN) {
    return (
      <div className="token-missing">
        <div>
          <strong>尚未設定 Mapbox token</strong>
          <p>請在部署環境設定 <code>VITE_MAPBOX_TOKEN</code> 後重新建置。</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div id="map" ref={containerRef} />

      <div className="brand">
        <strong>台灣情報脈動</strong>
        <span>以地圖呈現各地即時消息與公開資料{loading ? " · 更新中…" : ""}</span>
      </div>

      {/* 置中 + 記憶 按鈕（地圖右側、導航控制下方） */}
      <div className="center-control" onMouseEnter={() => setShowMemo(true)} onMouseLeave={() => setShowMemo(false)}>
        {showMemo && (
          <button className="memo-btn" onClick={memorize} title="把目前畫面中心設為我的置中位置">
            {memoSaved ? "已記憶 ✓" : "記憶"}
          </button>
        )}
        <button className="ctr-btn" onClick={recenter} title="回到我的置中位置">⌖</button>
      </div>

      {/* 圖層圖例 / 開關 */}
      <div className="legend">
        {CATS.map((c) => (
          <button
            key={c.id}
            className={"legend-item" + (visible.has(c.id) ? "" : " off")}
            onClick={() => toggle(c.id)}
          >
            <span className="dot" style={{ background: c.color }} />
            {c.label}
            <span className="cnt">{counts[c.id] || 0}</span>
          </button>
        ))}
      </div>
    </>
  );
}
