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
  { id: "cna-intworld", name: "中央社·國際", url: "https://feeds.feedburner.com/rsscna/intworld", type: "rss" },

  // === 主：公共媒體（中央社見上、公視）=========================================
  { id: "pts", name: "公視新聞", url: "https://news.pts.org.tw/xml/newsfeed.xml", type: "rss" },

  // === 輔：深度／中間偏中立 ====================================================
  { id: "twreporter", name: "報導者", url: "https://www.twreporter.org/a/rss2.xml", type: "rss" },
  // 鏡新聞未提供公開 RSS，改由 Google News 以 site: 限定該站（與 lib/intel.js 同一手法）
  { id: "mnews", name: "鏡新聞", url: "https://news.google.com/rss/search?q=site:mnews.tw+when:2d&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", type: "rss" },

  // === 次：民間商業媒體（僅供補充，計分權重最低；已排除中天／中時集團）==========
  { id: "ltn", name: "自由時報", url: "https://news.ltn.com.tw/rss/all.xml", type: "rss" },
  { id: "udn", name: "聯合報", url: "https://udn.com/rssfeed/news/2?ch=news", type: "rss" },
  { id: "setn", name: "三立新聞", url: "https://www.setn.com/rss.aspx", type: "rss" },
  { id: "ftv", name: "民視新聞", url: "https://news.ftv.com.tw/hinetnews/ftvnews.xml", type: "rss" },
  { id: "ettoday", name: "ETtoday", url: "https://feeds.feedburner.com/ettoday/realtime", type: "rss" },
  { id: "newtalk", name: "新頭殼", url: "https://newtalk.tw/rss/news", type: "rss" },
  { id: "storm", name: "風傳媒", url: "https://www.storm.mg/feeds/all", type: "rss" },

  // 中央部會／署 + 災防
  { id: "cga", name: "海洋委員會海巡署", url: "https://www.cga.gov.tw/GipOpen/wSite/rss?ctNode=650&mp=999", type: "rss" },
  { id: "fa-shooting", name: "漁業署·射擊通報", url: "https://www.fa.gov.tw/wm_DATA.php?data=Shooting_bulletin", type: "rss", forceCats: ["warning"] },
  { id: "swcb-landslide", name: "水保署·土石流/崩塌警戒", url: "https://ls.ardswc.gov.tw/api/LandslideAlertOpenData", type: "json-landslide", forceCats: ["disaster"] },
  { id: "cwa-warning", name: "中央氣象署·警特報", url: "https://www.cwa.gov.tw/rss/Data/cwa_warning.xml", type: "rss", forceCats: ["disaster"] },
  { id: "ncdr-alerts", name: "NCDR·災防告警", url: "https://alerts.ncdr.nat.gov.tw/JSONAtomFeeds.ashx", type: "json-ncdr" },
  { id: "water-outage", name: "台水·停水資訊", url: "https://web.water.gov.tw/wateroffapi/openData/export/json", type: "json-water" },
  { id: "nia", name: "內政部移民署", url: "https://www.immigration.gov.tw/5385/7229/7238/rss", type: "rss" },

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
  { id: "gov-nantou", name: "南投縣政府", url: "https://www.nantou.gov.tw/big5/news2rss.php", type: "rss", county: "南投縣" },
  { id: "gov-yunlin", name: "雲林縣政府", url: "https://www.yunlin.gov.tw/OpenData.aspx?SN=1D1119667FA73762", type: "rss", county: "雲林縣" },
  { id: "gov-chiayi-city", name: "嘉義市政府", url: "https://www.chiayi.gov.tw/OpenData.aspx?SN=880E46BF63C27EC0", type: "rss", county: "嘉義市" },
];
