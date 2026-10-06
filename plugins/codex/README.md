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
plugins/codex/install.sh                       # 加 --refresh-models 會順便向各服務擷取模型清單（每個服務約 10 秒）
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

## 行為與限制

- **沒有工具呼叫、不吃圖片、沒有串流**：網頁聊天只回傳文字，整段一次回來。Codex 的系統提示、工具定義、工具呼叫與思考都不會送出，只送使用者與助理的文字；
  所以這些模型適合問答、審閱、改寫，**不能讓 Codex 去執行指令或改檔**。
- **每次都是全新的無痕聊天，沒有記憶**：多輪對話時整段對話會攤平成一個提示，越長越慢。
- **用量是估算值**（約 4 字元 1 token），網頁模型沒有計價；上下文長度回報 128k（保守值）。
- 中斷（Ctrl+C）會取消尚未開始的請求；已經在網頁上生成的回覆無法取消。
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
