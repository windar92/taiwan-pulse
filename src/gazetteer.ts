// 輕量台灣地名 → 座標對照（縣市 + 六都主要行政區），用於把新聞/公告標題就地定位到地圖上。
// 非精準地理編碼，是「標題含哪個地名就放到該地中心」的近似做法（免費、無需 API）。
export type Place = { name: string; lng: number; lat: number };

export const PLACES: Place[] = [
  // 縣市
  { name: "基隆", lng: 121.7392, lat: 25.1276 },
  { name: "桃園", lng: 121.301, lat: 24.9937 },
  { name: "新竹縣", lng: 121.1252, lat: 24.8387 },
  { name: "新竹", lng: 120.9686, lat: 24.8047 },
  { name: "苗栗", lng: 120.8214, lat: 24.5602 },
  { name: "彰化", lng: 120.5161, lat: 24.0518 },
  { name: "南投", lng: 120.685, lat: 23.9609 },
  { name: "雲林", lng: 120.5311, lat: 23.7092 },
  { name: "嘉義縣", lng: 120.574, lat: 23.4518 },
  { name: "嘉義", lng: 120.4491, lat: 23.4801 },
  { name: "屏東", lng: 120.6188, lat: 22.6813 },
  { name: "宜蘭", lng: 121.7195, lat: 24.7021 },
  { name: "花蓮", lng: 121.6015, lat: 23.9871 },
  { name: "臺東", lng: 121.1132, lat: 22.7583 },
  { name: "台東", lng: 121.1132, lat: 22.7583 },
  { name: "澎湖", lng: 119.5793, lat: 23.5712 },
  { name: "金門", lng: 118.3186, lat: 24.4321 },
  { name: "連江", lng: 119.9399, lat: 26.1608 },
  { name: "馬祖", lng: 119.9399, lat: 26.1608 },
  // 台北市
  { name: "中正區", lng: 121.518, lat: 25.032 },
  { name: "大同區", lng: 121.513, lat: 25.063 },
  { name: "中山區", lng: 121.533, lat: 25.064 },
  { name: "松山區", lng: 121.557, lat: 25.05 },
  { name: "大安區", lng: 121.543, lat: 25.026 },
  { name: "萬華區", lng: 121.499, lat: 25.035 },
  { name: "信義區", lng: 121.571, lat: 25.031 },
  { name: "士林區", lng: 121.524, lat: 25.092 },
  { name: "北投區", lng: 121.501, lat: 25.132 },
  { name: "內湖區", lng: 121.588, lat: 25.069 },
  { name: "南港區", lng: 121.607, lat: 25.054 },
  { name: "文山區", lng: 121.57, lat: 24.989 },
  // 新北市
  { name: "板橋", lng: 121.459, lat: 25.011 },
  { name: "三重區", lng: 121.488, lat: 25.072 },
  { name: "中和", lng: 121.498, lat: 24.999 },
  { name: "永和", lng: 121.514, lat: 25.011 },
  { name: "新莊", lng: 121.45, lat: 25.036 },
  { name: "新店", lng: 121.541, lat: 24.967 },
  { name: "土城", lng: 121.443, lat: 24.972 },
  { name: "蘆洲", lng: 121.473, lat: 25.085 },
  { name: "樹林", lng: 121.42, lat: 24.991 },
  { name: "汐止", lng: 121.629, lat: 25.064 },
  { name: "淡水", lng: 121.441, lat: 25.169 },
  { name: "三峽", lng: 121.369, lat: 24.934 },
  { name: "新北", lng: 121.4657, lat: 25.0118 },
  // 桃園市
  { name: "中壢", lng: 121.225, lat: 24.953 },
  { name: "平鎮", lng: 121.218, lat: 24.943 },
  { name: "八德", lng: 121.285, lat: 24.929 },
  { name: "龜山", lng: 121.337, lat: 25.013 },
  { name: "龍潭", lng: 121.216, lat: 24.864 },
  { name: "大溪", lng: 121.286, lat: 24.88 },
  // 台中市
  { name: "西屯", lng: 120.642, lat: 24.181 },
  { name: "北屯", lng: 120.685, lat: 24.183 },
  { name: "南屯", lng: 120.643, lat: 24.138 },
  { name: "大里", lng: 120.677, lat: 24.099 },
  { name: "太平區", lng: 120.718, lat: 24.126 },
  { name: "豐原", lng: 120.717, lat: 24.255 },
  { name: "沙鹿", lng: 120.566, lat: 24.233 },
  { name: "大甲", lng: 120.622, lat: 24.349 },
  { name: "台中", lng: 120.6736, lat: 24.1477 },
  { name: "臺中", lng: 120.6736, lat: 24.1477 },
  // 台南市
  { name: "中西區", lng: 120.205, lat: 22.992 },
  { name: "安平", lng: 120.16, lat: 23.001 },
  { name: "安南", lng: 120.184, lat: 23.047 },
  { name: "永康", lng: 120.257, lat: 23.026 },
  { name: "新營", lng: 120.316, lat: 23.305 },
  { name: "台南", lng: 120.21, lat: 23.0 },
  { name: "臺南", lng: 120.21, lat: 23.0 },
  // 高雄市
  { name: "新興區", lng: 120.302, lat: 22.631 },
  { name: "苓雅", lng: 120.316, lat: 22.621 },
  { name: "鹽埕", lng: 120.286, lat: 22.624 },
  { name: "鼓山", lng: 120.281, lat: 22.643 },
  { name: "三民區", lng: 120.312, lat: 22.647 },
  { name: "左營", lng: 120.294, lat: 22.69 },
  { name: "楠梓", lng: 120.326, lat: 22.728 },
  { name: "前鎮", lng: 120.317, lat: 22.598 },
  { name: "小港", lng: 120.338, lat: 22.565 },
  { name: "鳳山", lng: 120.356, lat: 22.627 },
  { name: "岡山", lng: 120.295, lat: 22.796 },
  { name: "高雄", lng: 120.3014, lat: 22.6273 },
  // 直轄市本體（放最後，讓區名優先命中）
  { name: "台北", lng: 121.5637, lat: 25.0375 },
  { name: "臺北", lng: 121.5637, lat: 25.0375 },
  // 常見簡稱
  { name: "北市", lng: 121.5637, lat: 25.0375 },
  { name: "中市", lng: 120.6736, lat: 24.1477 },
  { name: "南市", lng: 120.21, lat: 23.0 },
  { name: "高市", lng: 120.3014, lat: 22.6273 },
];

// 依名稱長度由長到短排序，讓「中正區」「新竹縣」這類較精確的地名優先命中。
const SORTED = [...PLACES].sort((a, b) => b.name.length - a.name.length);

// 在文字中找出第一個（最精確的）地名，回傳座標；找不到回 null。
export function geocode(text: string): [number, number] | null {
  if (!text) return null;
  for (const p of SORTED) {
    if (text.includes(p.name)) {
      // 加一點微小抖動，避免同一地點多筆完全重疊
      const jitter = () => (Math.random() - 0.5) * 0.012;
      return [p.lng + jitter(), p.lat + jitter()];
    }
  }
  return null;
}
