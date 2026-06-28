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
  const [sel, setSel] = useState<Sel | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState(false);
  const [optOrder, setOptOrder] = useState<string[]>(REPORT_OPTIONS);

  const refreshOrder = () =>
    fetch("/api/feedback").then((r) => r.json()).then((d) => {
      if (d?.ok) { const s = d.stats || {}; setOptOrder([...REPORT_OPTIONS].sort((a, b) => (s[b] || 0) - (s[a] || 0))); }
    }).catch(() => {});

  useEffect(() => { refreshOrder(); }, []);

  useEffect(() => {
    if (!containerRef.current || !TOKEN) return;
    const home = loadHome();
    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current, style: "mapbox://styles/mapbox/dark-v11",
      projection: { name: "mercator" }, center: [home.lng, home.lat], zoom: home.zoom || 7.3, pitch: 25,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    hoverRef.current = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "hover-tip" });

    map.on("style.load", async () => {
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
          "circle-color": ["match", ["get", "cat"], "disaster", COLOR.disaster, "safety", COLOR.safety, "warning", COLOR.warning, "policy", COLOR.policy, "ecology", COLOR.ecology, "activity", COLOR.activity, "report", COLOR.report, "#888"],
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

  function recenter() { const m = mapRef.current; if (!m) return; const h = loadHome(); m.flyTo({ center: [h.lng, h.lat], zoom: h.zoom || 7.3, duration: 1100 }); }
  function memorize() { const m = mapRef.current; if (!m) return; const c = m.getCenter(); localStorage.setItem(HOME_KEY, JSON.stringify({ lng: c.lng, lat: c.lat, zoom: m.getZoom() })); setMemoSaved(true); setTimeout(() => setMemoSaved(false), 1600); }
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
      <div className="brand"><strong>台灣情報脈動</strong><span>各地即時消息與公部門公開資料</span></div>

      <div className="center-control" onMouseEnter={() => setShowMemo(true)} onMouseLeave={() => setShowMemo(false)}>
        {showMemo && <button className="memo-btn" onClick={memorize} title="把目前畫面中心設為我的置中位置">{memoSaved ? "已記憶 ✓" : "記憶"}</button>}
        <button className="ctr-btn" onClick={recenter} title="回到我的置中位置">⌖</button>
      </div>

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
