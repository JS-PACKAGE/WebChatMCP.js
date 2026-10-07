# Codex 外掛：名稱結尾為 `(WEB)` 的網頁模型

讓 Codex 的模型選單多出擷取到的網頁模型（如 `ChatGPT · GPT-5.5 (WEB)`）。沒有模型標籤的服務名稱（`ChatGPT (WEB)` 這類）不會進清單。
選了這些模型，對話就經由 WebChatMCP 在 ChatGPT／Claude／Grok／Gemini 的無痕／臨時聊天中完成；選官方模型則完全照舊。

> 這是**程式碼外掛**（`plugins/codex/`）：伺服器啟動時載入 `bridge.js`，不是上層 `plugins/*.json` 那種資料外掛。

## 運作方式

Codex 的自訂 provider 只支援 OpenAI Responses 協定，而且一個 session 只能用一個 provider；要讓網頁模型和官方模型出現在同一份選單，
只能把 Codex 的 `openai_base_url` 指向本機的 WebChatMCP（`http://127.0.0.1:8321/v1`）：

- `GET /v1/models`：取得官方清單，再併入網頁模型（顯示名稱結尾 `(WEB)`）。
- `POST /v1/responses`：模型 slug 是 `webchat/<服務>[/<模型標籤>]` 就送進網頁聊天、以 SSE 回覆；**其他請求原樣轉送官方後端**
  （只轉送標頭與本文，不讀、不記、不存任何 token；ChatGPT 登入走 `chatgpt.com/backend-api/codex`，API key 走 `api.openai.com/v1`）。
- Codex 會先試 WebSocket；伺服器一律拒絕，Codex 就改用 HTTPS（已實測會自動降級）。

## 安裝／反安裝

先確認 WebChatMCP 伺服器在跑（`script/install.sh` 安裝的背景服務即可），而且是支援橋接的版本。**伺服器沒開時，官方模型也會連不上**——所以安裝腳本會先檢查橋接可用，不可用就不動任何設定。

```bash
# Linux / macOS
plugins/codex/install.sh                       # 加 --refresh-models 會順便向各服務擷取模型清單（每個服務約 10 秒；要讀思考深度的服務得逐一切換模型，會久很多）
plugins/codex/uninstall.sh                     # 反安裝；--purge 另刪安裝前的備份
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\codex\install.ps1            # -RefreshModels 同上
powershell -ExecutionPolicy Bypass -File plugins\codex\uninstall.ps1          # -Purge 另刪安裝前的備份
```

兩支腳本都會：

1. **關閉所有執行中的 Codex**（CLI、`app-server`、桌面 App）。先請它們結束（macOS 桌面 App 用 AppleScript quit，其他送 SIGTERM／`taskkill`），10 秒後仍在的才強制結束；
   **如果關不掉，腳本會列出殘留的行程、提示你手動關閉，並且不動任何設定**（`--no-close`／`-NoClose` 可略過這一步，改完設定要自己重啟 Codex）。
   從 Codex 裡面執行腳本會把腳本自己關掉，所以腳本偵測到這種情況會直接拒絕，請改在 Codex 之外的終端機執行。
2. 修改 `~/.codex/config.toml`（`CODEX_HOME` 可改位置）：只加／移除一段標記區塊 `openai_base_url = "http://127.0.0.1:8321/v1"`。
   原本就有的 `openai_base_url` 會被記在 `~/.codex/webchatmcp-codex.json`，反安裝時放回；安裝前的原檔備份在 `config.toml.webchatmcp.bak`。
   不需要 root／系統管理員；腳本需要 Node.js（PATH 裡的 `node` 或 `~/.webchatmcp/node`）。

port 不是 8321 時：`plugins/codex/install.sh --url http://127.0.0.1:<port>/v1`。

## 模型清單

- 清單只有擷取到的模型標籤（`ChatGPT · GPT-5.5 (WEB)` 這類）。沒有模型的四個服務名稱不會加入。
- 要先擷取：安裝時加 `--refresh-models`，之後可隨時對伺服器執行
  `curl -X POST http://127.0.0.1:8321/v1/webchat/refresh`（會驅動瀏覽器，未登入的服務會被略過）。清單快取在 `~/.webchatmcp/codex-models.json`。
- 重新啟動 Codex 才會看到新清單。

## 思考深度（reasoning）

- 重新擷取時，ChatGPT、Claude、Gemini 會逐一切到每個模型，讀出**該模型各自**的思考深度（可選的深度隨模型而異），所以比只列標籤慢得多（單一模型的 ChatGPT 滑桿要走過每一段）；擷取完會切回原本的模型，結果存進同一個快取檔。
- 網頁上有**兩段以上**的深度（ChatGPT 思考強度滑桿、Claude 努力程度）時，該模型會在 Codex 宣告成 `supported_reasoning_levels`，值就是網頁標籤原樣（例如 `Low`、`Medium`、`High`），預設是擷取時網頁上選的那一段。在 Codex 選了就會在送出前先在網頁設好。
- 只有開關型（Gemini 的延伸思考）或沒有思考設定（Grok）的模型維持單一 `medium`，Codex 送來的 effort 不會轉給網頁。
- 標籤是網頁上的字串，不是 Codex 的標準值（`low`／`high` 等）；網站改版後請重新擷取。`reasoning.effort` 不在該模型清單內時一律忽略。

## 行為與限制

- **支援本機工具往返**：網頁模型以經驗證的 JSON 信封要求 `function` 或 `custom` 工具（包含 freeform `apply_patch`），橋接轉成 Codex 原生 Responses 工具呼叫；由 Codex 在自己的權限與確認流程下執行，結果在下一輪送回網頁模型，直到完成。一般文字不會被當作指令執行；格式錯誤會回 `response.failed`。
- **每次都是全新的無痕聊天，沒有記憶**：每輪重送任務、系統提示、環境資訊、完整對話、先前工具要求與結果，不裁切內容，越長越慢。檔案內容與工具結果會送往所選網頁聊天平台，請留意敏感資料。
- **不吃圖片、不是逐字串流**：網頁回覆整段到齊後才產生 SSE；`reasoning` 與無法表達的內建工具（如 `web_search`、`local_shell`、`image_generation`）安全略過。可接收多個工具要求，但不保證網頁模型可靠遵守協定或平行執行；`parallel_tool_calls: false` 時每輪最多一個要求，模型提出多個時回報格式錯誤，不會悄悄丟棄要求。
- **用量是估算值**（約 4 字元 1 token），網頁模型沒有計價；上下文長度回報 128k（保守值）。
- 中斷（Ctrl+C）並斷開請求連線時，橋接會傳遞取消訊號；伺服器在下一個安全點停止，已送出的提問會盡力按下網頁停止鈕。正在進行的導航或點擊須先結束。
- 轉送官方請求需要 Node.js 22.15+（Codex 的 ChatGPT 登入請求以 zstd 壓縮，橋接需要解壓才能判斷模型）；較舊的 Node 會把壓縮的請求原樣轉送官方，但無法判斷網頁模型。
- 官方後端連不到時，`/v1/models` 仍會回傳網頁模型。
- Windows 的行程偵測與關閉、Linux 桌面尚未在實機驗證（macOS 已實測：安裝、反安裝、關閉 Codex、網頁模型提問、官方請求轉送）。

## 設定（環境變數，設在伺服器端）

| 變數 | 意義 |
|---|---|
| `WEBCHATMCP_CODEX_BRIDGE` | 設 `0` 停用橋接（HTTP 仍提供 MCP） |
| `WEBCHATMCP_CODEX_UPSTREAM` | 覆蓋非網頁模型的上游網址（測試或自架代理用） |
| `WEBCHATMCP_CODEX_MODELS` | 模型清單快取檔位置 |

## 開發

`bridge.js`（Responses 橋接，無 build）、`codex-plugin.mjs`（安裝／反安裝核心：config.toml 編輯與關閉 Codex），四支腳本只是呼叫它。測試在 `tests/codex.test.mjs`。
