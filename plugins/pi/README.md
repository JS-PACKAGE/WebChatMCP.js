# Pi 外掛：`webchat` 模型提供商

讓 [Pi](https://pi.dev) 把 WebChatMCP 當成**模型提供商**，名稱就是 `webchat`。
先 `/webchat-refresh` 取得模型，再選 `webchat/<服務>/<模型標籤>`；對話經由 WebChatMCP 伺服器，
在 ChatGPT／Claude／Grok／Gemini 的無痕／臨時聊天中完成。沒有模型標籤的服務名稱不會進清單。

> 這是 **pi 的擴充（extension）**，位於 `plugins/pi/`；和上層 `plugins/*.json`（新增聊天服務的資料外掛）是兩回事，
> 後者只會讀 `plugins/` 這一層的 `.json`，不會碰這個子目錄。

## 先決條件

WebChatMCP 伺服器要在跑（外掛是用 HTTP 連它）：

```bash
curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash     # 安裝並啟動背景服務，預設 http://127.0.0.1:8321/mcp
```

## 安裝到 pi

用本目錄的腳本（不需要 root／系統管理員；裝完請重啟 pi）：

```bash
# Linux / macOS：以符號連結安裝（之後 git pull 就會跟著更新）；--copy 改為複製、--force 取代既有的同名目標
plugins/pi/install.sh
plugins/pi/uninstall.sh            # 反安裝；--purge 另刪模型快取
```

```powershell
# Windows（PowerShell）：以複製安裝，更新倉庫後重跑即可更新
powershell -ExecutionPolicy Bypass -File plugins\pi\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\pi\uninstall.ps1      # -Purge 另刪模型快取
```

目標是 `~/.pi/agent/extensions/webchat`（可用 `PI_CODING_AGENT_DIR` 或 `PI_EXTENSIONS_DIR` 改）。腳本只動自己裝的東西：
目標已存在而且不是本腳本裝的就拒絕覆蓋；反安裝只移除指向本倉庫的連結或帶安裝標記的複製。

不想安裝也可以只在這次執行載入：`pi -e /path/to/WebChatMCP.js/plugins/pi/webchat`，
或把這個路徑寫進 `~/.pi/agent/settings.json` 的 `extensions` 陣列。

## 使用

```bash
pi --model "webchat/gemini/3.5 Flash-Lite" # 先執行 /webchat-refresh 才會有這些
pi --model "webchat/claude/Haiku 4.5" -p "用一句話解釋 MCP"
```

| 指令（pi 內） | 作用 |
|---|---|
| `/webchat-refresh` | 向伺服器取得各服務目前可用的模型，更新 `webchat` 的模型清單（快取在 `~/.pi/agent/webchat-models.json`；每個服務約 10 秒） |
| `/webchat-login [服務…]` | 檢查登入狀態，必要時彈出視窗讓你人工登入（已登入不開視窗；省略＝伺服器上的所有服務，含 JSON 外掛） |
| `/webchat-logout [服務…]` | 登出這些服務（不開視窗；省略＝伺服器上的所有服務，含 JSON 外掛） |

明確指定服務時直接呼叫工具，省去一次服務探索請求；省略時即時探索，探索失敗則使用內建四個服務。

模型 id 只有 `<服務>/<模型標籤>`（標籤可含斜線與空白）。`webchat/chatgpt` 這種沒有模型的名稱不會出現在清單裡。
ChatGPT、Gemini 不登入也能用；Claude、Grok 要先 `/webchat-login`（見主 README）。

切到 `webchat` 模型時（`model_select`），外掛會請伺服器先載入該服務的無痕聊天頁（`webchat_warmup`），第一題就不必等頁面載入；切換到其他模型或結束 pi 時，請伺服器關閉背景瀏覽器（`webchat_release`）。伺服器連不上時這些通知會被略過，不影響 pi。

## 設定（環境變數）

| 變數 | 意義 |
|---|---|
| `WEBCHATMCP_URL` | 伺服器位址（預設 `http://127.0.0.1:8321/mcp`） |
| `WEBCHATMCP_PI_TIMEOUT` | 單次回覆等待上限，秒（10–600，預設 300） |
| `WEBCHATMCP_PI_CACHE` | 模型快取檔位置（預設 `~/.pi/agent/webchat-models.json`） |

## 行為與限制

- **工具往返**：網頁模型不能讀本機磁碟；外掛將可用工具與任務送給模型，只有通過 JSON 信封驗證的要求才轉成 pi 原生工具呼叫。
  pi 依自己的權限／確認機制執行，再將結果回傳給網頁模型，直到完成；一般文字絕不當作工具執行。
- **每次都是全新的無痕聊天**：每回合重送完整任務與對話，包括助理工具要求（保留 id）及工具結果；思考過程不送。
  無論是否提供工具，都保留系統提示、宿主指示與完整工具結果，不裁切內容。
  MCP SSE 收到完整且 id 相符的結果即交給宿主，不等待串流關閉；這不是網站逐字串流。
- **不吃圖片，沒有即時串流**：網頁回覆整段一次回來才轉成宿主事件。網站 UI／模型是否遵守格式會影響可靠性；
  不保證平行工具執行，對話越長每回合傳輸越慢。
- **沒有計價與 token 用量**：成本與用量一律是 0；上下文長度寫的是保守值（128k），實際上限取決於各網站。
- **中止**：pi 立刻結束這個回合，並送出 MCP 取消通知。伺服器在下一個安全點停止；已送出的提問會盡力按下網頁停止鈕。正在進行的導航或點擊須先結束。
- 任務、系統提示與工具結果（包含讀出的本機檔案內容）都會送到所選網頁服務的平台，適用該服務的資料使用政策；請勿傳送機密資料。

## 開發

核心邏輯（MCP 用戶端、提示組裝、串流事件）在 `core.js`，不依賴 pi，測試在 `tests/pi.test.mjs`；
`index.js` 只負責接上 pi（`pi.registerProvider`、指令）。整個外掛不需要額外相依套件。
