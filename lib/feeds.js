// 策展來源清單（皆免金鑰，已查證）。新增來源只要在這裡加一筆。
// type: rss = 標準 RSS/Atom；json-landslide = 水保署土石流警戒 JSON
// county: 該來源預設所屬縣市（標題若無更細地名，就用縣市中心定位、縣市界當影響範圍）
// forceCats: 該來源所有項目強制掛上的分類（例如射擊通報＝警戒管制）
export const FEEDS = [
  // 中央社（全台綜合，靠分類器判類型）
  { id: "cna-local", name: "中央社·地方", url: "https://feeds.feedburner.com/rsscna/local", type: "rss" },
  { id: "cna-social", name: "中央社·社會", url: "https://feeds.feedburner.com/rsscna/social", type: "rss" },
  { id: "cna-politics", name: "中央社·政治", url: "https://feeds.feedburner.com/rsscna/politics", type: "rss" },
  { id: "cna-mainland", name: "中央社·兩岸", url: "https://feeds.feedburner.com/rsscna/mainland", type: "rss" },
  { id: "cna-aipl", name: "中央社·軍事外交", url: "https://feeds.feedburner.com/rsscna/aipl", type: "rss" },

  // 中央部會／署
  { id: "cga", name: "海洋委員會海巡署", url: "https://www.cga.gov.tw/GipOpen/wSite/rss?ctNode=650&mp=999", type: "rss" },
  { id: "fa-shooting", name: "漁業署·射擊通報", url: "https://www.fa.gov.tw/wm_DATA.php?data=Shooting_bulletin", type: "rss", forceCats: ["warning"] },
  { id: "swcb-landslide", name: "水保署·土石流/崩塌警戒", url: "https://ls.ardswc.gov.tw/api/LandslideAlertOpenData", type: "json-landslide", forceCats: ["disaster"] },

  // 直轄市／縣市政府（UTF-8 RSS；預設縣市即影響範圍）
  { id: "gov-taipei", name: "臺北市政府", url: "https://www.gov.taipei/OpenData.aspx?SN=7DEC7150E6BAD606", type: "rss", county: "臺北市" },
  { id: "gov-ntpc", name: "新北市政府", url: "https://www.ntpc.gov.tw/LatestNews", type: "rss", county: "新北市" },
  { id: "gov-tycg", name: "桃園市政府", url: "https://www.tycg.gov.tw/OpenData.aspx?SN=50C7BB8497F3C8C2", type: "rss", county: "桃園市" },
  { id: "gov-taichung", name: "臺中市政府", url: "https://www.taichung.gov.tw/10179/564770/rss?nodeId=9962", type: "rss", county: "臺中市" },
  { id: "gov-tainan", name: "臺南市政府", url: "https://www.tainan.gov.tw/OpenData.aspx?SN=24474215983F6554", type: "rss", county: "臺南市" },
  { id: "gov-kcg", name: "高雄市政府", url: "https://www.kcg.gov.tw/OpenData.aspx?SN=D33B55D537402BAA", type: "rss", county: "高雄市" },
  { id: "gov-klcg", name: "基隆市政府", url: "https://www.klcg.gov.tw/tw/klcg1/3168-RSS.html", type: "rss", county: "基隆市" },
  { id: "gov-miaoli", name: "苗栗縣政府", url: "https://www.miaoli.gov.tw/OpenData.aspx?SN=F871C7470FAF2E95", type: "rss", county: "苗栗縣" },
  { id: "gov-chcg", name: "彰化縣政府", url: "http://www.chcg.gov.tw/ch2/rssnews2b.aspx", type: "rss", county: "彰化縣" },
  { id: "gov-kinmen", name: "金門縣政府", url: "https://www.kinmen.gov.tw/OpenData.aspx?SN=82FC652523030D44", type: "rss", county: "金門縣" },
];
