# Grok 外掛：名稱結尾為 `(WEB)` 的網頁模型

讓 [Grok Build](https://docs.x.ai/build/overview)（xAI 的 `grok` CLI）的模型選單多出 `ChatGPT (WEB)`、`Claude (WEB)`、`Grok (WEB)`、`Gemini (WEB)`（以及 `ChatGPT · GPT-5.5 (WEB)` 這類指定模型）。
選了這些模型，對話就經由 WebChatMCP 在 ChatGPT／Claude／Grok／Gemini 的無痕／臨時聊天中完成；官方模型完全不受影響。

> 這是**程式碼外掛**（`plugins/grok/`）：伺服器啟動時載入 `bridge.js`，不是上層 `plugins/*.json` 那種資料外掛。

## 運作方式

Grok Build 支援自訂模型 `[model.<id>]`（可指定 `base_url` 與協定），所以不必改全域設定：安裝腳本只在 `~/.grok/config.toml` 結尾加一段標記區塊，
每個網頁模型一個 `[model."webchat/…"]`，`base_url = "http://127.0.0.1:8321/grok"`、`api_backend = "chat_completions"`、`name = "… (WEB)"`。

- **只有 (WEB) 模型會走本機**；官方模型照舊連 xAI，所以 WebChatMCP 伺服器沒開時，官方模型不受影響（只有 (WEB) 模型會失敗）。
- Grok 會把它的登入標頭一起送給自訂模型的 `base_url`；橋接完全不讀、不記、不轉送，也不會連到 xAI。
- 橋接只服務 `webchat/<服務>` 的模型，其他 model 一律回 404（例如 Grok 產生對話標題時用的內建模型——標題因此產生不了，不影響對話）。

## 安裝／反安裝

先確認 WebChatMCP 伺服器在跑（`script/install.sh` 安裝的背景服務即可），而且是支援橋接的版本；安裝腳本會先檢查，不可用就不動任何設定。

```bash
# Linux / macOS
plugins/grok/install.sh                       # 加 --refresh-models 會向各服務擷取模型清單（每個服務約 10 秒）
plugins/grok/uninstall.sh                     # 反安裝；--purge 另刪安裝前的備份
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\grok\install.ps1            # -RefreshModels 同上
powershell -ExecutionPolicy Bypass -File plugins\grok\uninstall.ps1          # -Purge 另刪安裝前的備份
```

兩支腳本都會：

1. **關閉所有執行中的 grok**（TUI、headless、常駐的 leader 行程）。先送 SIGTERM／`taskkill`，10 秒後仍在的才強制結束；
   **如果關不掉，腳本會列出殘留的行程、提示你手動關閉，並且不動任何設定**（`--no-close`／`-NoClose` 可略過這一步，改完設定要自己重啟 grok）。
   從 grok 裡面執行腳本會把腳本自己關掉，所以腳本偵測到這種情況會直接拒絕，請改在 grok 之外的終端機執行。
   名稱相近的 Grok Bot.app 不是 Grok Build，不會被關閉。
2. 修改 `~/.grok/config.toml`（`GROK_HOME` 可改位置）：只加／移除標記區塊；原檔其他內容原樣保留，安裝前的備份在 `config.toml.webchatmcp.bak`（`--purge` 才刪）。
   如果 `config.toml` 已有不是本外掛寫的 `[model."webchat/…"]` 表格，會拒絕安裝（避免重複的 TOML 表格）。
   不需要 root／系統管理員；腳本需要 Node.js（PATH 裡的 `node` 或 `~/.webchatmcp/node`）。

port 不是 8321 時：`plugins/grok/install.sh --url http://127.0.0.1:<port>/grok`。

## 模型清單

- 每個服務固定有一筆「目前選用的模型」（`ChatGPT (WEB)`…）。
- 指定模型（`ChatGPT · GPT-5.5 (WEB)`）要先擷取：安裝時加 `--refresh-models`（會驅動瀏覽器，未登入的服務會被略過）；之後想更新就再執行一次 install。
- 用法：`grok -m webchat/chatgpt -p "…"`，或在 TUI 用 `/model` 選。重新啟動 grok 才會看到新清單。

## 行為與限制

- **沒有工具呼叫、不吃圖片、沒有串流**：網頁聊天只回傳文字，整段一次回來。Grok 的系統提示、工具定義、工具呼叫與環境資訊都不會送出，只送使用者與助理的文字；
  所以這些模型適合問答、審閱、改寫，**不能讓 grok 去執行指令或改檔**。
- **每次都是全新的無痕聊天，沒有記憶**：多輪對話時整段對話會攤平成一個提示，越長越慢。
- **用量是估算值**（約 4 字元 1 token）；上下文長度寫 128k（保守值），實際上限取決於各網站。
- 中斷會取消尚未開始的請求；已經在網頁上生成的回覆無法取消。
- 實測（macOS、grok 1.0.46）：安裝、反安裝、`grok models` 列出模型、`grok -m webchat/chatgpt -p` 取得 ChatGPT 的回覆；TUI 選單上的顯示名稱沒有親眼確認。Windows 的行程偵測與關閉尚未實機驗證。

## 設定（環境變數，設在伺服器端）

| 變數 | 意義 |
|---|---|
| `WEBCHATMCP_GROK_BRIDGE` | 設 `0` 停用橋接（HTTP 仍提供 MCP） |

## 開發

`bridge.js`（chat_completions 橋接，無 build）、`grok-plugin.mjs`（安裝／反安裝核心：config.toml 編輯與關閉 grok），四支腳本只是呼叫它；
與其他外掛共用的 HTTP 輔助與關閉行程在 `plugins/lib/`。測試在 `tests/grok.test.mjs`。
