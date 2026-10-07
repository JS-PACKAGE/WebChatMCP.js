# Claude 外掛：名稱結尾為 `(WEB)` 的網頁模型

讓 Claude Code 的 `/model` 選單多出擷取到的網頁模型（如 `ChatGPT · GPT-5.5 (WEB)`）。沒有模型標籤的服務名稱不會進清單。
選了這些模型，對話就經由 WebChatMCP 在 ChatGPT／Claude／Grok／Gemini 的無痕／臨時聊天中完成；選官方模型則照舊。

> 這是**程式碼外掛**（`plugins/claude/`）：伺服器啟動時載入 `bridge.js`，不是上層 `plugins/*.json` 那種資料外掛。

## 運作方式

Claude Code 只會把模型請求送到 `ANTHROPIC_BASE_URL`，所以安裝腳本在 `~/.claude/settings.json` 寫入：

- `env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8321/claude"`：所有請求改走本機的 WebChatMCP。
  - model 是 `webchat/<服務>[/<模型標籤>]` → 送進網頁聊天、以 SSE 回覆。
  - **其他請求原樣轉送 `https://api.anthropic.com`**（只轉送標頭與本文，不讀、不記、不存任何 token；Claude 訂閱登入與 API key 都照常運作）。
- `modelPicker`：把 `(WEB)` 模型加進 `/model` 選單（排在你原本的項目後面；你自己的 `modelPicker` 項目原樣保留）。

## 安裝／反安裝

先確認 WebChatMCP 伺服器在跑（`script/install.sh` 安裝的背景服務即可），而且是支援橋接的版本。**伺服器沒開時，官方模型也會連不上**——所以安裝腳本會先檢查橋接可用，不可用就不動任何設定。

```bash
# Linux / macOS
plugins/claude/install.sh                       # 加 --refresh-models 會向各服務擷取模型清單（每個服務約 10 秒）
plugins/claude/uninstall.sh                     # 反安裝；--purge 另刪安裝前的備份
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\claude\install.ps1            # -RefreshModels 同上
powershell -ExecutionPolicy Bypass -File plugins\claude\uninstall.ps1          # -Purge 另刪安裝前的備份
```

兩支腳本都會：

1. **關閉所有執行中的 Claude**（Claude Code CLI、Claude 桌面 App）。先請它們結束（macOS 桌面 App 用 AppleScript quit，其他送 SIGTERM／`taskkill`），10 秒後仍在的才強制結束；
   **如果關不掉，腳本會列出殘留的行程、提示你手動關閉，並且不動任何設定**（`--no-close`／`-NoClose` 可略過這一步，改完設定要自己重啟 Claude）。
   從 Claude 裡面執行腳本會把腳本自己關掉，所以腳本偵測到這種情況會直接拒絕，請改在 Claude 之外的終端機執行。
2. 修改 `~/.claude/settings.json`（`CLAUDE_CONFIG_DIR` 可改位置）：只加／移除 `env.ANTHROPIC_BASE_URL` 與 `modelPicker` 裡 `webchat/` 開頭的項目；
   原本已有的 `ANTHROPIC_BASE_URL` 會拒絕覆蓋（加 `--force`／`-Force` 才取代，並記下、反安裝時還原）。
   安裝前的原檔備份在 `settings.json.webchatmcp.bak`；檔案會依原本縮排重新輸出（內容不變，但原本壓成單行的 JSON 會被展開）。
   不需要 root／系統管理員；腳本需要 Node.js（PATH 裡的 `node` 或 `~/.webchatmcp/node`）。

port 不是 8321 時：`plugins/claude/install.sh --url http://127.0.0.1:<port>/claude`。

## 模型清單

- 清單只有擷取到的模型標籤（`ChatGPT · GPT-5.5 (WEB)` 這類）。沒有模型的四個服務名稱不會加入。
- 要先擷取：安裝時加 `--refresh-models`（會驅動瀏覽器，未登入的服務會被略過）；之後想更新就再執行一次 install。
- 重新啟動 Claude Code 才會看到新清單。

## 行為與限制

- **支援本機工具往返**：Claude Code 將問題與可用工具交給網頁模型；模型只提出工具要求，橋接驗證 JSON 信封後轉為原生 `tool_use`。真正的指令執行與檔案操作由 Claude Code 依自己的權限／確認流程處理，結果再交給網頁模型，直到回答完成。一般文字不會被當成指令執行。
- **每次都是全新的無痕聊天**：每輪重送任務、系統提示、完整對話、先前工具要求與結果，不裁切內容；有工具時也送工具定義。保留 `<system-reminder>` 等宿主指示；思考區塊略過。越長越慢。
- **隱私**：工具讀取的檔案內容與執行結果會隨提示送到所選網頁聊天服務的平台，請勿送出機密。
- **不吃圖片、不是即時逐字串流**：網頁回覆整段取得後才輸出 Messages SSE（文字或工具區塊），也支援非串流 JSON。網頁模型的工具格式與網站可靠性仍可能導致錯誤，不保證平行工具執行；格式錯誤的工具要求會回傳錯誤，不會執行。
- **用量與 token 數是估算值**（約 4 字元 1 token）。Claude Code 不認得 `webchat/...` 這個模型，啟動時會在 stderr 印一行「isn't described by this version's model catalog」的提示，並假設 200k 上下文來決定何時壓縮，實際上限取決於各網站。
- 中斷（Esc）會取消尚未開始的請求；已經在網頁上生成的回覆無法取消。
- **改用自訂 `ANTHROPIC_BASE_URL` 的副作用**（Claude Code 的行為）：連到非 `api.anthropic.com` 的主機時，MCP tool search 預設關閉、Remote Control 停用；
  官方模型的對話本身不受影響。
- 官方後端連不到時，官方模型的請求會得到 502；網頁模型不受影響。
- 轉送官方請求需要 Node.js 22.15+ 才能判斷壓縮過的請求；較舊的 Node 會把壓縮的請求原樣轉送官方，但無法判斷網頁模型。
- Windows 的行程偵測與關閉、Linux 桌面尚未在實機驗證（macOS 已實測：安裝、反安裝、網頁模型提問、官方請求轉送；Claude 桌面 App 的關閉與選單顯示未實測）。

## 設定（環境變數，設在伺服器端）

| 變數 | 意義 |
|---|---|
| `WEBCHATMCP_CLAUDE_BRIDGE` | 設 `0` 停用橋接（HTTP 仍提供 MCP） |
| `WEBCHATMCP_CLAUDE_UPSTREAM` | 覆蓋非網頁模型的上游網址（測試或自架代理用） |

## 開發

`bridge.js`（Messages 橋接，無 build）、`claude-plugin.mjs`（安裝／反安裝核心：settings.json 編輯與關閉 Claude），四支腳本只是呼叫它；
與 Codex 外掛共用的 HTTP 轉送與關閉行程在 `plugins/lib/`。測試在 `tests/claude.test.mjs`。
