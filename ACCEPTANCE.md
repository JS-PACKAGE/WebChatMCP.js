# WebChatMCP.js 驗收紀錄

只記錄實際執行過、有觀察結果的項目。「未驗證」項目不得勾選。測試環境：macOS arm64、Node v26.10.0、npm 11.19.1、TypeScript 5.9.3、Playwright 1.63.0（內建 Chromium）。

## Gate A — 規格可執行

| 項目 | 方法 | 結果 |
|---|---|---|
| 建置 | `npx tsc -p tsconfig.json` | 零錯誤，`dist/WebChatMCP.js` 等產出齊全 ✔ |
| DESIGN.md 自動產生 | `node tools/gen-design.mjs`（來源 `src/config.ts`） | ✔ 產生成功；含模型選單選擇器、環境變數、時間參數 |
| 常數集中 | 選擇器／網址／時間參數僅存於 `src/config.ts` | ✔（測試守護 DESIGN.md 與 package.json 版本一致性） |
| 文件六件套 | `PLAN.md`／`ACCEPTANCE.md`／`DESIGN.md`（自動產生）／`AGENTS.md`／`CLAUDE.md`（`@AGENTS.md`）／`README.md`（英／繁中／日三語） | ✔ |

## Gate B — 核心流程

| 項目 | 方法 | 結果 |
|---|---|---|
| MCP handshake | `npm test`：spawn `dist/WebChatMCP.js`、initialize | serverInfo=`webchatmcp.js` ✔ |
| 工具清單 | `tools/list` | 5 工具：`webchat_login`／`webchat_ask`／`webchat_models`／`webchat_status`／`webchat_close` ✔；`webchat_ask` 含 `prompt` 與 `model` 參數 ✔ |
| HTTP 直連（Streamable HTTP） | `npm test`：spawn 後 `POST /mcp` initialize＋tools/list | 200＋`Mcp-Session-Id` 會話管理正常、工具清單 5 項一致 ✔ |
| HTTP port 可配置 | 測試以 `WEBCHATMCP_PORT` 指定隨機 port；`port=0` 停用 | 自訂 port 可連線 ✔；`port=0` 時 `http.enabled=false` 且 stdio 不受影響 ✔ |
| 監聽位址 | 預設 `127.0.0.1`（loopback），`WEBCHATMCP_HOST=0.0.0.0` 可開放 | ✔（預設值與環境變數行為；0.0.0.0 實際開放未驗證） |
| webchat_status | `tools/call`（瀏覽器未啟動） | `browserRunning=false`、`loggedIn=unknown`、`chatgptUrl` 正確、含 `http` 連線狀態 ✔ |
| 瀏覽器啟動＋導航 | 無頭暫存 profile 實跑（Playwright persistent context） | Chromium 啟動、導航 `chatgpt.com` 成功 ✔ |
| 三態誠實性 | 全新無頭 profile 停在 Cloudflare「Just a moment...」 | 探測回 `unknown`，未誤判為已登入 ✔；15 秒未自動放行（實測），已實作挑戰偵測＋明確錯誤訊息 |
| webchat_login 人工登入全流程 | — | **未驗證**（需使用者實際登入） |
| webchat_ask 臨時聊天送提示＋回覆擷取 | — | **未驗證**（需登入後實測） |
| webchat_models 清單擷取／model 切換 | — | **未驗證**（需登入後實測） |

## Gate C — 交付驗收

| 項目 | 方法 | 結果 |
|---|---|---|
| 單元測試 | `npm test` | 3 通過／0 失敗 ✔ |
| OG 分享圖 | PIL IHDR 核對＋目視檢查 | `og.png` 1200×630、`og@2x.png` 2400×1260 ✔；英文文案、無錯字、無重疊裁切、構圖平衡 ✔ |
| favicon.ico | PIL 解析 ICO 目錄＋目視 48px | 16／32／48 三尺寸齊 ✔；W 字樣清晰置中 ✔ |
| OG 標籤 | `index.html` `<head>` 檢查 | og:title／description／image／url＋twitter:card 全英文、`og:image` 指向 `assets/social/og.png` ✔ |
| 官網 | `curl` 實測 | `https://webchatmcp.js-package.xyz/` 回 200 ✔；`/assets/social/og.png` 200（70,979 B）✔；`/favicon.ico` 200（2,505 B）✔ |
| 推送 | `git push origin main`＋GitHub contents API | main 更新至 `2955c8a`，根目錄 18 項檔案齊全 ✔ |

## 已知問題與未驗證項目

- **未驗證（需真實 ChatGPT 登入）**：`webchat_login` 人工登入全流程、`webchat_ask` 完整送提示與回覆擷取、`webchat_models` 清單擷取、`model` 切換。上述功能的自動化邏輯已完成並通過靜態驗證（建置、MCP 契約、工具註冊），實際對話流程待首次真人登入後驗收。
- 無頭模式（`WEBCHATMCP_HEADLESS=1`）全新 profile 會被 Cloudflare 挑戰擋下（實測 15 秒內未自動放行）；預設可視模式不受影響，首次登入必須使用可視瀏覽器。
- ChatGPT UI 改版可能使選擇器失效；全部集中於 `src/config.ts`，修復只需改選擇器並重跑 `npm run build`。
