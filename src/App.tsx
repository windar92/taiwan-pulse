import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

// 全台總覽開場視角（沿用 mini-taiwan-pulse 的取景）
const TAIWAN_CENTER: [number, number] = [121.12, 23.43];

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !TOKEN) return;
    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: TAIWAN_CENTER,
      zoom: 7.2,
      pitch: 48,
      bearing: 0,
      antialias: true,
    });
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    map.on("style.load", () => {
      // 3D 地形
      map.setFog({});
    });
    return () => map.remove();
  }, []);

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
        <span>以地圖呈現各地即時消息與公開資料</span>
      </div>
    </>
  );
}
