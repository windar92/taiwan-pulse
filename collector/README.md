# AIS 常駐收集器

一條 WebSocket 長連線持續接收 AISStream，批次寫入 Neon。取代原本「GitHub Actions 每 5 分鐘開 55 秒」的做法。

**為什麼換**：AIS 是串流服務，用排程模擬串流每天燒掉約 1,440 分鐘 Actions，中間還有空隙會漏船。常駐一條連線資源更省、密度更高（連續無縫）。

| | 舊做法（GitHub Actions） | 新做法（常駐） |
|---|---|---|
| 覆蓋 | 每 5 分鐘的 55 秒，有空隙 | 連續無縫 |
| 成本 | ~1,440 Actions 分鐘/天 | 0 |
| 資源 | 每次重建 runner | 約 50MB 記憶體、CPU 幾乎 0 |

---

## 一、先在本機試跑（確認會動）

```bash
cd collector
npm install
copy .env.example .env       # macOS/Linux 用 cp
```

編輯 `.env`，填入兩個值：

- `AISSTREAM_KEY`：AISStream 金鑰
- `DATABASE_URL`：跟 Vercel 環境變數裡那個 Neon 連線字串**完全一樣**

```bash
npm start
```

正常會看到：

```
[2026-08-14 03:12:00] AIS 常駐收集器啟動（每 60s 寫入一次）
[2026-08-14 03:12:01] 已連線 AISStream，開始接收
[2026-08-14 03:13:01] 寫入 47 艘（累計訊息 8231／中國籍 512／重連 0）
```

確認有在「寫入 N 艘」就成功了，`Ctrl+C` 結束。

---

## 二、搬上 Oracle Cloud Always Free（24/7 不靠自家電腦）

### 1. 開帳號

到 <https://cloud.oracle.com> 註冊。

- 需要信用卡驗證，**但 Always Free 資源不會扣款**（會預授權約 US$1 再退回）
- 註冊時選的 **Home Region 之後不能改**，建議選 `Japan East (Tokyo)` 或 `Singapore`，離台灣近
- 註冊後確認帳號狀態是 **Always Free 有效**

### 2. 開一台 VM

Console → 左上漢堡選單 → **Compute** → **Instances** → **Create instance**

- **Name**：`ais-collector`
- **Image**：Ubuntu 22.04（或 24.04）
- **Shape**：點 *Change shape* → **Ampere**（ARM）→ `VM.Standard.A1.Flex`
  - OCPU 設 **1**、Memory 設 **6 GB**（Always Free 額度是 4 OCPU/24GB，用 1 核就夠，留額度給以後）
  - 若 Ampere 顯示 out of capacity，改選 `VM.Standard.E2.1.Micro`（AMD，也是 Always Free）
- **SSH keys**：選 *Generate a key pair for me*，**把私鑰下載存好**（等下要用）
- 按 **Create**，等狀態變 `RUNNING`，記下 **Public IP address**

### 3. 連進去

Windows PowerShell：

```powershell
# 把私鑰權限收好（第一次才需要）
icacls .\ssh-key.key /inheritance:r /grant:r "$($env:USERNAME):(R)"

ssh -i .\ssh-key.key ubuntu@<你的公有IP>
```

### 4. 裝 Node 並放上程式

```bash
# 裝 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 取得程式（repo 是 public，直接 clone）
git clone https://github.com/windar92/taiwan-pulse.git
cd taiwan-pulse/collector
npm install

# 填金鑰
cp .env.example .env
nano .env      # 貼上 AISSTREAM_KEY 與 DATABASE_URL，Ctrl+O 存檔、Ctrl+X 離開
```

先手動跑一次確認正常：

```bash
node ais-collector.mjs
```

看到「寫入 N 艘」就對了，`Ctrl+C` 停掉。

### 5. 設成開機自動、掛掉自動重啟

```bash
sudo tee /etc/systemd/system/ais-collector.service > /dev/null <<'EOF'
[Unit]
Description=Taiwan Pulse AIS Collector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/taiwan-pulse/collector
ExecStart=/usr/bin/node ais-collector.mjs
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ais-collector
```

### 6. 檢查狀態

```bash
systemctl status ais-collector      # 看是不是 active (running)
journalctl -u ais-collector -f      # 即時看 log，Ctrl+C 離開
```

看到持續出現「寫入 N 艘」就完成了。之後 VM 重開機也會自動啟動。

---

## 三、關掉 GitHub Actions 的舊排程

常駐收集器上線並確認有在寫入後，把 `.github/workflows/ships.yml` 停用，避免重複收集又繼續燒 Actions 分鐘：

- GitHub → repo → **Actions** → 左側 **ships-collect** → 右上 `...` → **Disable workflow**

（或直接刪掉 `ships.yml`。建議先觀察一兩天確認常駐版穩定再刪。）

---

## 常見問題

**Q：VM 會不會被 Oracle 回收？**
Always Free 的 ARM 機器若長期閒置（CPU 極低）有可能被回收，但這支程式有持續網路與 CPU 活動，正常不會。

**Q：斷線了怎麼辦？**
腳本本身有自動重連（連上過 3 秒重試、連不上 15 秒退避），systemd 另外還有 `Restart=always` 雙保險。

**Q：資料庫會不會被寫爆？**
每分鐘批次寫一次，只寫「這分鐘內有更新的中國籍船」。另有自動清理：`ships` 保留 24 小時、`ship_tracks` 保留 7 天。

**Q：本機 Windows 想長期跑？**
用「工作排程器」建立「登入時啟動」的工作，動作設 `node`、引數 `ais-collector.mjs`、起始位置設 collector 資料夾即可。
