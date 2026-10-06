# Oh My Pi 外掛：`webchat` 模型提供商

讓 [Oh My Pi（omp）](https://github.com/can1357/oh-my-pi) 把 WebChatMCP 當成**模型提供商**，名稱就是 `webchat`：
在 omp 裡選 `webchat/chatgpt`、`webchat/claude`、`webchat/grok`、`webchat/gemini`，對話就會經由 WebChatMCP 伺服器，
在 ChatGPT／Claude／Grok／Gemini 的無痕／臨時聊天中完成。

> 這是 **omp 的擴充（extension）**，位於 `plugins/omp/`；和上層 `plugins/*.json`（新增聊天服務的資料外掛）是兩回事，
> 後者只會讀 `plugins/` 這一層的 `.json`，不會碰這個子目錄。

## 先決條件

WebChatMCP 伺服器要在跑（外掛是用 HTTP 連它）：

```bash
curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash     # 安裝並啟動背景服務，預設 http://127.0.0.1:8321/mcp
```

## 安裝到 omp

用本目錄的腳本（不需要 root／系統管理員；裝完請重啟 omp）：

```bash
# Linux / macOS：以符號連結安裝（之後 git pull 就會跟著更新）；--copy 改為複製、--force 取代既有的同名目標
plugins/omp/install.sh
plugins/omp/uninstall.sh            # 反安裝；--purge 另刪模型快取
```

```powershell
# Windows（PowerShell）：以複製安裝，更新倉庫後重跑即可更新
powershell -ExecutionPolicy Bypass -File plugins\omp\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\omp\uninstall.ps1      # -Purge 另刪模型快取
```

目標是 `~/.omp/agent/extensions/webchat`（可用 `PI_CODING_AGENT_DIR` 或 `OMP_EXTENSIONS_DIR` 改）。腳本只動自己裝的東西：
目標已存在而且不是本腳本裝的就拒絕覆蓋；反安裝只移除指向本倉庫的連結或帶安裝標記的複製。

不想安裝也可以只在這次執行載入：`omp -e /path/to/WebChatMCP.js/plugins/omp/webchat`，
或把這個路徑寫進 `~/.omp/agent/config.yml` 的 `extensions:`。

## 使用

```bash
omp --model webchat/chatgpt                 # 該服務「目前選用」的模型
omp --model "webchat/gemini/3.5 Flash-Lite" # 指定模型（先執行 /webchat-refresh 才會有這些）
omp --model webchat/claude -p "用一句話解釋 MCP"
```

| 指令（omp 內） | 作用 |
|---|---|
| `/webchat-refresh` | 向伺服器取得各服務目前可用的模型，更新 `webchat` 的模型清單（快取在 `~/.omp/agent/webchat-models.json`；每個服務約 10 秒） |
| `/webchat-login [服務]` | 檢查登入狀態，必要時彈出視窗讓你人工登入（已登入不開視窗；預設 `chatgpt`） |
| `/webchat-logout [服務]` | 登出該服務（不開視窗） |

模型 id：`<服務>` ＝該服務目前選的模型；`<服務>/<模型標籤>` ＝指定模型（標籤本身可含斜線與空白）。
ChatGPT、Gemini 不登入也能用；Claude、Grok 要先 `/webchat-login`（見主 README）。

## 設定（環境變數）

| 變數 | 意義 |
|---|---|
| `WEBCHATMCP_URL` | 伺服器位址（預設 `http://127.0.0.1:8321/mcp`） |
| `WEBCHATMCP_OMP_TIMEOUT` | 單次回覆等待上限，秒（10–600，預設 300） |
| `WEBCHATMCP_OMP_INCLUDE_SYSTEM` | 設 `1` 才把 omp 的系統提示一起送出（預設不送，見下） |
| `WEBCHATMCP_OMP_CACHE` | 模型快取檔位置（預設 `~/.omp/agent/webchat-models.json`） |

## 行為與限制

- **沒有工具呼叫、不吃圖片、沒有串流**：網頁聊天只回傳文字，而且是整段一次回來（所以 omp 裡看起來是等一陣子才出現）。
  適合拿來做問答、審閱、摘要、改寫這類純文字角色，**不適合當會呼叫 `bash`／`edit` 的主要 coding agent**。
- **每次都是全新的無痕聊天，沒有記憶**：多輪對話時外掛會把整段對話（使用者／助理／工具結果的文字）攤平成一個提示再送出；
  對話越長，每次送出的內容越長，也越慢。思考過程與工具呼叫不會送出。
- **omp 的系統提示預設不送**：它在描述網頁聊天用不到的工具，而且動輒數萬字元。要送請設 `WEBCHATMCP_OMP_INCLUDE_SYSTEM=1`。
- **沒有計價與 token 用量**：成本與用量一律是 0；上下文長度寫的是保守值（128k），實際上限取決於各網站。
- **中止**：omp 按中止會立刻結束這個回合，但網站那邊的生成仍會跑完（伺服器端沒有取消）。
- 提示與回覆會經過所選服務，適用該服務的資料使用政策。

## 開發

核心邏輯（MCP 用戶端、提示組裝、串流事件）在 `core.js`，不依賴 omp，測試在 `tests/omp.test.mjs`；
`index.js` 只負責接上 omp（`pi.registerProvider`、指令）。整個外掛不需要額外相依套件。
