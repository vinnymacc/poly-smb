# Poly Smart-Money Tracker

盯一批 Polymarket 錢包,每 30 分鐘抓一次新動作,按運動分類,用 Telegram 通知你。
每筆通知含:誰、何時、哪個市場、哪一邊、點位、金額、鏈上連結。

獨立工具,跟 `poly` 網站專案無關。資料也存進本地 SQLite(`smartmoney.db`),為未來做後台儀表板鋪路。

## 它怎麼運作

```
Windows 工作排程器 (每 30 分鐘)
  → node poll
      1. 讀 config/watchlist.json 的地址
      2. 對每個地址打 Polymarket Data API /activity
         (內建 DNS-over-HTTPS 繞過本機 DNS 封鎖 — 不需 VPN、不用改系統 DNS)
      3. 跟 SQLite 已存的 txHash 比對 → 只留新動作
         (某地址第一次跑只建 baseline、不通知,避免噴歷史)
      4. 用市場 slug/標題分類成 MLB / NBA / SOCCER / OTHER
      5. 寫進 SQLite + 發 Telegram
```

**抗封鎖:** `src/http.ts` 用 Cloudflare DoH 拿真 IP 再直連,所以你電腦的 DNS 把
Polymarket 導去封鎖頁也沒關係。換任何機器/網路都能跑。

## 設定 (一次性)

1. **安裝套件** (已完成,若搬機器重跑):
   ```
   npm install
   ```

2. **填要盯的地址** — 編輯 `config/watchlist.json`,把 `0xREPLACE...` 換成真實地址,
   `label` 改成你自己看得懂的代號:
   ```json
   { "addresses": [
     { "address": "0x9d84ce0306f8551e02efef1680475fc0f1dc1344", "label": "鯨魚A" }
   ]}
   ```

3. **設 Telegram** — 複製 `.env.example` 成 `.env`,照裡面說明填 bot token + chat id。

## 跑跑看

```
npm run poll
```

- 第一次跑:每個地址只「建 baseline」,不通知(這是正常的,避免一開機噴幾百則舊紀錄)。
- 之後跑:只通知 baseline 之後的新動作。
- 沒填 `.env`:訊息會印在 console 而不是送 Telegram(方便先看格式)。

## 設定每 30 分鐘自動跑 (Windows 工作排程器)

在這個資料夾開 PowerShell,跑(把路徑換成實際 node / 專案路徑,README 下方有現成指令):

```powershell
$node = (Get-Command node).Source
$proj = "C:\Users\USER\.vscode\poly-smartmoney"
$tsx  = "$proj\node_modules\tsx\dist\cli.mjs"
schtasks /Create /SC MINUTE /MO 30 /TN "PolySmartMoney" `
  /TR "`"$node`" `"$tsx`" `"$proj\src\poll.ts`"" /ST 00:00 /F
```

- 查狀態:`schtasks /Query /TN "PolySmartMoney"`
- 手動跑一次:`schtasks /Run /TN "PolySmartMoney"`
- 移除:`schtasks /Delete /TN "PolySmartMoney" /F`

> 注意:電腦關機/睡眠時排程不會跑。要 24 小時不漏拓,之後可把同一份程式搬到 VPS(程式不用改)。

## 每日 MLB 賽前報告 (另一條獨立通知線)

除了上面每 15 分鐘的全動態,還有一支「每日 MLB 賽前報告」:列出台灣當天會打的所有 MLB
場次(= 美國前一天的賽程),以及哪些聰明錢錢包**現在持有**該場的勝負盤倉位、押哪隊、押多少。

- 入口:`npx tsx src/mlb-report.ts`(跑一次就退出)
- 只看 `config/watchlist.json` 裡 `tags` 含 `MLB` 的錢包
- **只算勝負盤**(押哪隊獲勝);大小分 (Over/Under)、讓分 (spread) 不列
- 同一場兩隊都押會兩邊都列(看金額判斷傾向)
- 完全沒人押任何場 → 不發

每天兩次自動跑(台灣 00:10 + 08:30),透過 `run-mlb-report.vbs` 靜默執行,輸出寫進 `mlb-report.log`:

```powershell
$vbs = "C:\Users\USER\.vscode\poly-smartmoney\run-mlb-report.vbs"
schtasks /Create /SC DAILY /TN "MlbReportMidnight" /TR "wscript.exe `"$vbs`"" /ST 00:10 /F
schtasks /Create /SC DAILY /TN "MlbReportMorning"  /TR "wscript.exe `"$vbs`"" /ST 08:30 /F
```

- 手動跑一次:`schtasks /Run /TN "MlbReportMorning"`
- 移除:`schtasks /Delete /TN "MlbReportMidnight" /F`(另一個同理)

## 檔案

| 檔案 | 做什麼 |
|---|---|
| `src/http.ts` | DoH 抗封鎖 HTTP 層 |
| `src/polymarket.ts` | 打 Data API `/activity` |
| `src/sports.ts` | 市場 → 運動分類 |
| `src/db.ts` | SQLite 存歷史 + 去重 + baseline |
| `src/telegram.ts` | Telegram 通知 + 訊息模板 |
| `src/poll.ts` | 主流程(排程跑這支) |
| `config/watchlist.json` | 要盯的地址 |
| `spike.ts` / `dns-test.ts` | 連線診斷用(平常用不到) |
