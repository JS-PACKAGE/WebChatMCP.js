# WebChatMCP.js 實作計畫

依需求「內建瀏覽器登入 ChatGPT，之後每次呼叫把提示文字送進 ChatGPT 臨時（無痕）聊天視窗」實作 MCP Server。本檔為單一實作計畫。

## 1. 強制執行範圍（硬規則）

1. 執行環境 Node.js ≥ 22、語言 TypeScript（ESM）；產物 `dist/WebChatMCP.js` 為程式本體。
2. MCP transport：**stdio 與 Streamable HTTP 同時啟用**。HTTP port（預設 8321）與監聽位址（預設 `127.0.0.1`，可開放 `0.0.0.0`）寫在 `src/config.ts` 的 `SERVER` 區塊，以 `WEBCHATMCP_PORT`／`WEBCHATMCP_HOST` 覆蓋；`port=0` 停用 HTTP；port 衝突不得崩潰（stdio 續服）。stdio 模式下 stdout 專供 JSON-RPC，日誌一律 stderr。
3. 內建瀏覽器＝Playwright persistent context：登入狀態持久化於 profile 目錄，重啟不失效。
4. 登入只透過使用者在可視瀏覽器中人工操作；**禁止**以任何形式讀、寫、記錄密碼或 cookie 內容。
5. 提示一律走全新臨時（無痕）聊天：每次 `webchat_ask` 開新對話，不寫入帳號聊天紀錄。
6. 常數集中於 `src/config.ts`（唯一事實來源）；`DESIGN.md` 由 `tools/gen-design.mjs` 自動產生，禁止手改。
7. 狀態探測只回 `true / false / unknown` 三態；找不到畫面指標不得猜測。
8. 文件六件套：`PLAN.md`、`ACCEPTANCE.md`、`DESIGN.md`（自動產生）、`AGENTS.md`、`CLAUDE.md`（引用 AGENTS.md）、`README.md`（三語）。
9. 文件內以「執行 Agent」泛稱 AI，不綁定特定工具名。
10. 授權 Apache-2.0（根目錄 `LICENSE` 為全文，不得更換）。

## 2. 倉庫結構

```
dist/WebChatMCP.js        程式本體（tsc 產物，提交前重新 build 驗證）
src/config.ts             單一事實來源（常數、選擇器、時間參數、環境變數名）
src/chatgpt.ts            瀏覽器會話與臨時聊天自動化（ChatGPTSession）
src/http.ts               Streamable HTTP transport（port 連線、session 管理、CORS）
src/WebChatMCP.ts         MCP Server 主程式（工具註冊、stdio＋HTTP 啟動）
tools/gen-design.mjs      由 src/config.ts 產生 DESIGN.md
tests/smoke.test.mjs      node:test（MCP handshake、工具清單、一致性）
index.html                官網首頁（GitHub Pages，webchatmcp.js-package.xyz）
PLAN.md  DESIGN.md  ACCEPTANCE.md  AGENTS.md  CLAUDE.md  README.md
CNAME  LICENSE  .nojekyll  package.json  tsconfig.json  .gitignore
```

## 3. 里程碑

| M | 內容 | 驗收硬指標 |
|---|---|---|
| M0 | 倉庫骨架、文件六件套、npm 套件與 TypeScript 建置 | `npm run build` 成功、`DESIGN.md` 自動產生 |
| M1 | 內建瀏覽器＋登入持久化（webchat_login／webchat_status） | 瀏覽器可開啟 ChatGPT、登入偵測三態正確 |
| M2 | 臨時聊天送提示＋回傳回覆（webchat_ask／webchat_close） | 提示送出、回覆擷取、穩定判定與逾時語意 |
| M3 | 測試、官網、驗收與交付 | `npm test` 全綠、官網 200、ACCEPTANCE 實測記錄 |

## 4. MCP 工具契約

連線：stdio 子程序啟動，或 HTTP 直連 `http://127.0.0.1:8321/mcp`（Streamable HTTP，port 可改）。

| 工具 | 輸入 | 輸出 |
|---|---|---|
| `webchat_login` | `timeout_seconds?` | JSON：`loggedIn / elapsedMs / profileDir / currentUrl / guidance` |
| `webchat_ask` | `prompt`、`model?`、`timeout_seconds?` | ChatGPT 回覆純文字；`completed=false` 時加前綴提示；`temporaryChat≠true` 時加尾註 |
| `webchat_models` | — | JSON：`count / models[]`（每項 `label / current`；依帳號等級即時擷取，不寫死） |
| `webchat_status` | — | JSON：`browserRunning / loggedIn / temporaryChat / profileDir / currentUrl` |
| `webchat_close` | — | JSON：`closed / profileDir` |

## 5. 驗收硬指標

1. `npm test` 全數通過（MCP initialize＋tools/list＋webchat_status 實跑）。
2. `node tools/gen-design.mjs` 產生的 `DESIGN.md` 與提交版本一致（測試守護）。
3. `webchat_ask` 回傳文字來自 `[data-message-author-role="assistant"]` 最後一則，不擷取使用者訊息。
4. 逾時（無回覆）回 `no_response`；未登入回 `logged_out`；輸入框不存在回 `composer_not_found`。
5. 無頭全新 profile 撞 Cloudflare 挑戰時，探測必須回 `unknown`，不得誤判為已登入。
6. `webchat_models` 只回真實擷取清單；擷取失敗回錯誤碼（`browser_error`／`logged_out`），不得回假清單。`model` 比對不中回 `model_not_found`；`webchat_ask` 的 `thinking` 比對不中（或該服務沒有思考設定）回 `thinking_not_found`，且已選的設定不被改動。
7. HTTP 連線：`POST /mcp` initialize＋tools/list 實跑成功（含 `Mcp-Session-Id` 會話管理）；`WEBCHATMCP_PORT=0` 時 HTTP 停用不影響 stdio。

## 6. 交付前自檢

- [ ] `npm run build` 無錯誤，`dist/` 與 `src/` 同步提交。
- [ ] `npm test` 全綠。
- [ ] `DESIGN.md` 由工具重新產生且無 diff。
- [ ] README 三語（English／繁體中文／日本語）齊備。
- [ ] `LICENSE`（Apache-2.0）、`CNAME`（webchatmcp.js-package.xyz）、`.nojekyll` 未被更動。
- [ ] ACCEPTANCE.md 只勾選實測通過項；未驗證項目明列。
- [ ] 官網 `https://webchatmcp.js-package.xyz/` 回 200。
- [ ] GitHub Release v1.0 發佈：可直接執行壓縮包（含 `dist/`，不含 `node_modules`）＋ `SHA256SUMS`，下載後複算 SHA-256 一致。
