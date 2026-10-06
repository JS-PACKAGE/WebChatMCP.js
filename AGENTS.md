# WebChatMCP.js 執行規範

執行 Agent 工作說明。本檔是實作契約：模組邊界、介面、指令與提交紀律全部以此為準。

## 1. 權威文件與優先序

1. 需求原文：功能衝突以需求為準（第一版＝內建瀏覽器登入 ChatGPT＋提示走臨時聊天）。
2. `DESIGN.md`：常數唯一來源；常數衝突以此為準（與 `src/config.ts` 同步，自動產生）。
3. 本檔：架構與介面契約。
4. `PLAN.md`：里程碑、驗收硬指標、交付前自檢。

使用者明確核准的調整優先於以上；其他衝突須回報使用者，不自行改設計。

## 2. 硬性限制（逐條來自 PLAN.md）

- 執行環境 Node.js ≥ 22、語言 TypeScript（ESM，`"type": "module"`）；建置器只用 `tsc`，無 bundler。
- MCP transport：stdio 與 Streamable HTTP **同時啟用**（`src/http.ts`）；HTTP port／host 於 `src/config.ts` `SERVER` 區塊，`WEBCHATMCP_PORT`／`WEBCHATMCP_HOST` 覆蓋，`port=0` 停用；port 衝突只降級為 stdio，不得崩潰。stdio 模式下 **stdout 專供 JSON-RPC，日誌一律 stderr**。
- 內建瀏覽器＝Playwright persistent context；登入狀態持久化於 profile 目錄（預設 `~/.webchatmcp/profile`）。
- 登入只透過使用者在可視瀏覽器中人工操作；**禁止**讀、寫、記錄任何密碼或 cookie 內容。
- 每次 `webchat_ask` 開啟**全新的**臨時（無痕）聊天（`?temporary-chat=true`），不寫入帳號聊天紀錄。
- 常數集中於 `src/config.ts`；其他程式碼不得寫死其已定義的選擇器、網址與時間參數。
- `DESIGN.md` 由 `tools/gen-design.mjs` 自動產生，**禁止手改**。
- 狀態探測回 `true / false / unknown` 三態；找不到畫面指標不得猜測。
- 文件內以「執行 Agent」泛稱 AI，不綁定特定工具名。
- 授權 Apache-2.0；根目錄 `LICENSE` 為全文，不得更換。

## 3. 目錄結構

```
dist/WebChatMCP.js     程式本體（tsc 產物；提交前重新 build 驗證，隨倉庫提交）
src/config.ts          單一事實來源（常數、選擇器、時間參數、環境變數名）
src/chatgpt.ts         ChatGPTSession：瀏覽器生命週期、登入／臨時聊天探測、送提示與回覆擷取
src/http.ts            Streamable HTTP transport：port 監聽、session 管理、CORS
src/WebChatMCP.ts      MCP Server：工具註冊（buildServer 工廠）、stdio＋HTTP 啟動、錯誤包裝
tools/gen-design.mjs   由 src/config.ts 產生 DESIGN.md
tests/smoke.test.mjs   node:test（MCP handshake、工具清單、常數一致性）
index.html             官網首頁（GitHub Pages：webchatmcp.js-package.xyz）
PLAN.md DESIGN.md ACCEPTANCE.md AGENTS.md CLAUDE.md README.md
CNAME LICENSE .nojekyll package.json tsconfig.json .gitignore
```

## 4. 指令

```
npm install                     # 安裝相依
npx playwright install chromium # 安裝內建瀏覽器（首次）
npm run build                   # tsc → dist/
npm run gen:design              # 重新產生 DESIGN.md（改 src/config.ts 後必跑）
npm test                        # node --test tests/*.test.mjs
npm start                       # 以 stdio 啟動 MCP Server
```

環境變數（詳見 `DESIGN.md` §2.1／§4.1）：`WEBCHATMCP_PROFILE_DIR`、`WEBCHATMCP_CHANNEL`、`WEBCHATMCP_HEADLESS`、`WEBCHATMCP_ANSWER_TIMEOUT_MS`、`WEBCHATMCP_PORT`、`WEBCHATMCP_HOST`。

連線方式（同時啟用）：
- **stdio**：MCP 用戶端以子程序啟動 `dist/WebChatMCP.js`。
- **HTTP 直連**：`http://127.0.0.1:8321/mcp`（Streamable HTTP；`WEBCHATMCP_PORT` 改 port、`WEBCHATMCP_HOST=0.0.0.0` 開放區網）。

## 5. MCP 工具契約

| 工具 | 輸入 | 輸出 |
|---|---|---|
| `webchat_login` | `timeout_seconds?`（10–900，預設 180） | JSON：`loggedIn / elapsedMs / profileDir / currentUrl / guidance` |
| `webchat_ask` | `prompt`（必填）、`model?`、`timeout_seconds?`（10–600，預設 120） | ChatGPT 回覆純文字；`completed=false` 時加前綴提示；`temporaryChat≠true` 時加尾註 |
| `webchat_models` | — | JSON：`count / models[]`（每項 `label / current`；依帳號等級即時擷取） |
| `webchat_status` | — | JSON：`browserRunning / loggedIn / temporaryChat / profileDir / currentUrl / chatgptUrl / temporaryChatUrl / channel` |
| `webchat_close` | — | JSON：`closed / profileDir` |

回覆擷取契約：只取 `[data-message-author-role="assistant"]` 最後一則（`.markdown/.prose` 優先）；完成判定＝連續 `TIMEOUTS.stableChecks` 次取樣文字不變且無 `stop-button`。

## 6. 錯誤碼

| code | 語意 |
|---|---|
| `logged_out` | 未登入即呼叫 `webchat_ask`；先 `webchat_login` |
| `browser_error` | 瀏覽器啟動／導航失敗，或停留在驗證（Cloudflare challenge）頁 |
| `composer_not_found` | 找不到 `#prompt-textarea`（UI 大改版徵兆；改 `src/config.ts` 選擇器） |
| `send_failed` | 送出按鈕與 Enter 皆失敗 |
| `no_response` | 逾時未見回覆或回覆內容為空 |
| `model_not_found` | `model` 指定的模型不在選單清單內；先 `webchat_models` 查看 |
| `timeout` | 一般逾時 |

錯誤一律以 JSON 包裝回工具結果（`isError: true`），不得讓例外打進 stdout 破壞 JSON-RPC。

## 7. 提交紀律

- **分功能提交**：一個 commit 對應一個功能，message 帶 `M0:`–`M3:` 前綴；整包提交禁止。
- **全部完成並驗證後再一次推送**（push 不隨單一 commit 進行；推送前 `git log` 應為逐功能分節）。
- 提交前：`npm run build`、`npm test`、`npm run gen:design` 三者皆過，且 `dist/` 與 `src/` 同步。
- `DESIGN.md` 若有 diff，代表 `src/config.ts` 改了卻沒重新產生——先跑 `npm run gen:design`。

## 8. 安全紀律

- 不以任何形式儲存、回傳、記錄密碼、cookie 值或 token。
- `profile/` 目錄為使用者私人資料，列入 `.gitignore`，測試須用暫存目錄隔離。
- 工具只操作 ChatGPT 自家頁面；不做任意網頁導航、不執行遠端腳本。
- HTTP endpoint **無任何認證**：預設只綁 `127.0.0.1`；對外開放（`0.0.0.0`）等同讓同網路任何人操作使用者的 ChatGPT 會話，README 須明示風險。
