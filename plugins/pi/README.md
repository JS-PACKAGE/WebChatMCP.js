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
| `/webchat-login [服務…]` | 檢查登入狀態，必要時彈出視窗讓你人工登入（已登入不開視窗；省略＝ChatGPT、Claude、Grok、Gemini 都檢查） |
| `/webchat-logout [服務]` | 登出該服務（不開視窗；省略＝`chatgpt`） |

模型 id 只有 `<服務>/<模型標籤>`（標籤可含斜線與空白）。`webchat/chatgpt` 這種沒有模型的名稱不會出現在清單裡。
ChatGPT、Gemini 不登入也能用；Claude、Grok 要先 `/webchat-login`（見主 README）。

## 設定（環境變數）

| 變數 | 意義 |
|---|---|
| `WEBCHATMCP_URL` | 伺服器位址（預設 `http://127.0.0.1:8321/mcp`） |
| `WEBCHATMCP_PI_TIMEOUT` | 單次回覆等待上限，秒（10–600，預設 300） |
| `WEBCHATMCP_PI_INCLUDE_SYSTEM` | 設 `1` 才把 pi 的系統提示一起送出（預設不送，見下） |
| `WEBCHATMCP_PI_CACHE` | 模型快取檔位置（預設 `~/.pi/agent/webchat-models.json`） |

## 行為與限制

- **沒有工具呼叫、不吃圖片、沒有串流**：網頁聊天只回傳文字，而且是整段一次回來（所以 pi 裡看起來是等一陣子才出現）。
  適合拿來做問答、審閱、摘要、改寫這類純文字角色，**不適合當會呼叫 `bash`／`edit` 的主要 coding agent**。
- **每次都是全新的無痕聊天，沒有記憶**：多輪對話時外掛會把整段對話（使用者／助理／工具結果的文字）攤平成一個提示再送出；
  對話越長，每次送出的內容越長，也越慢。思考過程與工具呼叫不會送出。
- **pi 的系統提示預設不送**：它在描述網頁聊天用不到的工具，而且動輒數萬字元。要送請設 `WEBCHATMCP_PI_INCLUDE_SYSTEM=1`。
- **沒有計價與 token 用量**：成本與用量一律是 0；上下文長度寫的是保守值（128k），實際上限取決於各網站。
- **中止**：pi 按中止會立刻結束這個回合，但網站那邊的生成仍會跑完（伺服器端沒有取消）。
- 提示與回覆會經過所選服務，適用該服務的資料使用政策。

## 開發

核心邏輯（MCP 用戶端、提示組裝、串流事件）在 `core.js`，不依賴 pi，測試在 `tests/pi.test.mjs`；
`index.js` 只負責接上 pi（`pi.registerProvider`、指令）。整個外掛不需要額外相依套件。
