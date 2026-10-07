# WebChatMCP.js 執行規範

執行 Agent 工作說明。本檔是實作契約：模組邊界、介面、指令與提交紀律全部以此為準。

## 1. 權威文件與優先序

1. 需求原文：功能衝突以需求為準（第一版＝內建瀏覽器登入 ChatGPT＋提示走臨時聊天；使用者已核准擴充為 ChatGPT／Claude／Grok／Gemini 四服務、訪客可用、模型與思考深度列表、登出）。
2. `DESIGN.md`：常數唯一來源；常數衝突以此為準（與 `src/config.ts` 同步，自動產生）。
3. 本檔：架構與介面契約。
4. `PLAN.md`：里程碑、驗收硬指標、交付前自檢。

使用者明確核准的調整優先於以上；其他衝突須回報使用者，不自行改設計。

## 2. 硬性限制（逐條來自 PLAN.md）

- 執行環境 Node.js ≥ 22、語言 TypeScript（ESM，`"type": "module"`）；建置器只用 `tsc`，無 bundler。
- MCP transport：stdio 與 Streamable HTTP **同時啟用**（`src/http.ts`）；HTTP port／host 於 `src/config.ts` `SERVER` 區塊，`WEBCHATMCP_PORT`／`WEBCHATMCP_HOST` 覆蓋，`port=0` 停用；port 衝突只降級為 stdio，不得崩潰。stdio 模式下 **stdout 專供 JSON-RPC，日誌一律 stderr**。
- 內建瀏覽器＝Playwright persistent context；登入狀態持久化於 profile 目錄（預設 `~/.webchatmcp/profile`）。
- 登入只透過使用者在可視瀏覽器中人工操作；**禁止**讀、寫、記錄任何密碼或 cookie 內容。
- 每次 `webchat_ask` 開啟**全新的**無痕聊天，不寫入帳號聊天紀錄：ChatGPT `?temporary-chat=true`、Claude `?incognito=`、Grok `/c#private`、Gemini 載入後點「臨時對話」按鈕（網址無法直接進入；訪客沒有此按鈕）。
- 未登入也必須能使用：ChatGPT、Gemini 以訪客模式可用；Claude、Grok 必須登入（Grok 訪客被登入牆擋住）。瀏覽器預設無頭，僅人工登入／Cloudflare 驗證需要時才顯示；`webchat_login` 先查詢登入狀態，已登入不顯示視窗；`webchat_logout` 不顯示視窗。
- 常數集中於 `src/config.ts`；其他程式碼不得寫死其已定義的選擇器、網址與時間參數。
- `DESIGN.md` 由 `tools/gen-design.mjs` 自動產生，**禁止手改**。
- 狀態探測回 `true / false / unknown` 三態；找不到畫面指標不得猜測。
- 文件內以「執行 Agent」泛稱 AI，不綁定特定工具名。
- `script/` 腳本須可遠端執行（`curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash`、PowerShell 用 `& ([scriptblock]::Create((irm …/install.ps1).TrimStart([char]0xFEFF)))`）：整份腳本包在函式裡最後才執行、缺 git／Node.js 要自動補齊並 `git clone`；除 Linux 缺 git 時以套件管理員（sudo）安裝外，不得需要 root／系統管理員權限；更新前必須先關掉執行中的服務（含殘留的 `WebChatMCP.js` 行程）；下載 Node.js／MinGit 須驗證 SHA-256；反安裝預設不得刪除登入 profile（須明確加 `--purge-profile`／`-PurgeProfile`）；遠端安裝的原始碼只在 `--purge` 時刪除，使用者自己的倉庫絕不刪除。
- **每個外掛都必須附安裝與反安裝腳本。** 需要裝進其他程式的外掛放在 `plugins/<名稱>/`，且目錄內必備 `install.sh`、`uninstall.sh`（Linux／macOS）與 `install.ps1`、`uninstall.ps1`（Windows，UTF-8 with BOM）四支，並有 README.md 說明用法：不需要 root／系統管理員；安裝可重跑（冪等）且遇到非本腳本安裝的同名目標預設拒絕覆蓋（須明確加 `--force`／`-Force`）；以安裝標記（符號連結指向本倉庫，或標記檔）辨識「本腳本裝的」，反安裝只移除這些、其餘一律不動；反安裝預設保留使用者資料（快取、設定、登入 profile），須明確加 `--purge`／`-Purge` 才刪快取與設定；安裝後提醒需要的後續動作（例如重啟）。純資料的聊天服務外掛（`plugins/*.json`）由伺服器自動載入，不需要安裝步驟，使用者自己的放 `~/.webchatmcp/plugins/`。新增外掛時，這四支腳本與其測試（至少 sh 與 ps1 的語法檢查加沙盒實跑一次安裝／反安裝）是交付條件。
- **README.md 與 index.html 必須同步。** 修改 `README.md` 時，凡是使用者需要知道的資訊（安裝／更新／反安裝、指令與參數、環境變數、連線設定、功能與限制、外掛）都要同步寫進 `index.html`（官網首頁是繁體中文，內容與 README 繁中版一致；指令區塊須逐字相同）；只屬於 README 的內容（多語言版本、貢獻或授權細節）可以不放。同一批提交，不得只改其中之一。
- 授權 Apache-2.0；根目錄 `LICENSE` 為全文，不得更換。

## 3. 目錄結構

```
dist/WebChatMCP.js     程式本體（tsc 產物；提交前重新 build 驗證，隨倉庫提交）
src/config.ts          單一事實來源（常數、各服務 PROVIDERS 網址與選擇器、時間參數、環境變數名）
src/session.ts         WebChatSession：瀏覽器生命週期、登入／無痕探測、登出、送提示與回覆擷取（以 provider 參數區分服務）
src/providers.ts       各服務的模型選單與思考深度擷取（依 config 的 menu 種類：chatgpt 兩層視圖與滑桿、radio 一般選單含子選單、gemini gem-menu）
src/plugins.ts         外掛載入與驗證：讀 plugins/*.json 與 ~/.webchatmcp/plugins/*.json，註冊成新的 provider（只有資料，不執行程式碼）
plugins/               外掛目錄：README.md 說明格式、_template.json 範本（檔名以 _ 開頭不載入）
plugins/omp/           Oh My Pi 擴充（模型提供商 webchat）：core.js 核心＋index.js 接合＋install／uninstall 的 .sh 與 .ps1；外掛一律放在 plugins/ 下
plugins/pi/            Pi 擴充（模型提供商 webchat）：webchat/core.js 核心＋index.js 接合＋install／uninstall 的 .sh 與 .ps1
plugins/codex/         Codex 擴充（網頁模型，名稱結尾 (WEB)）：bridge.js（Responses 橋接，由 WebChatMCP.ts 動態載入；無 build）＋codex-plugin.mjs（安裝／反安裝核心：改 config.toml、關閉 Codex）＋install／uninstall 的 .sh 與 .ps1
plugins/claude/        Claude Code 擴充（網頁模型，名稱結尾 (WEB)）：bridge.js（Anthropic Messages 橋接，由 WebChatMCP.ts 動態載入；無 build）＋claude-plugin.mjs（安裝／反安裝核心：改 settings.json、關閉 Claude）＋install／uninstall 的 .sh 與 .ps1
plugins/grok/          Grok Build 擴充（網頁模型，名稱結尾 (WEB)）：bridge.js（chat_completions 橋接，由 WebChatMCP.ts 動態載入；無 build）＋grok-plugin.mjs（安裝／反安裝核心：改 config.toml、關閉 grok）＋install／uninstall 的 .sh 與 .ps1
plugins/hermes/        Hermes Agent 擴充（模型提供商 webchat）：bridge.js（chat_completions 橋接，路徑含 /v1）＋hermes-plugin.mjs（安裝到 HERMES_HOME、寫假金鑰）＋webchat/ 提供商 profile＋install／uninstall 的 .sh 與 .ps1
plugins/lib/           程式碼外掛共用模組：bridgekit.js（讀取／解碼請求、原樣轉送上游）、proc.mjs（關閉某程式的所有實例）、tool-protocol.js（網頁模型的工具要求與結果往返：提示組裝、nonce 信封解析與驗證；omp／pi 各帶一份同內容副本於 webchat/tool-protocol.js，改共用檔後須重新複製）
src/http.ts            Streamable HTTP transport：port 監聽、session 管理、CORS
src/scheduler.ts       瀏覽器操作排程（createScheduler）：互斥鎖、閒置關閉、回覆後預載（相容的下一題接手載入中的預載頁）、取消訊號傳到 session
src/WebChatMCP.ts      MCP Server：工具註冊（buildServer 工廠）、stdio＋HTTP 啟動、錯誤包裝
tools/gen-design.mjs   由 src/config.ts 產生 DESIGN.md
tests/session.test.mjs 以攔截路由的假頁面驗證各服務流程（登入判定、訪客、無痕、模型清單、登出）
tests/plugins.test.mjs 外掛格式驗證、載入（略過壞檔與範本）、外掛服務的提問／模型清單／登出
tests/omp.test.mjs     omp 外掛核心邏輯（MCP 用戶端、提示組裝、串流事件、模型 id）
tests/pi.test.mjs     pi 外掛核心邏輯（MCP 用戶端、提示組裝、串流事件、模型 id）
tests/codex.test.mjs   Codex 外掛：slug、模型併入、輸入攤平、SSE、config.toml 編輯、Codex 行程偵測與關閉
tests/claude.test.mjs  Claude 外掛：模型 id、輸入攤平、Messages SSE、settings.json 編輯、Claude 行程偵測
tests/grok.test.mjs    Grok 外掛：模型 id、輸入攤平、chat.completion SSE、config.toml 編輯、grok 行程偵測
tests/tool-protocol.test.mjs  工具往返協定：信封解析與驗證、往返提示、tool_choice／平行呼叫、omp／pi 副本一致
tests/scheduler.test.mjs 排程：相容提問接手載入中的預載、不相容提問取消預載、生成中取消迅速釋放鎖、佇列中取消不呼叫 ask
tests/smoke.test.mjs   node:test（MCP handshake、工具清單、常數一致性）
script/install.sh       Linux／macOS：可遠端執行（curl | bash）；補齊 git／Node.js、clone 原始碼到 ~/.webchatmcp/app、安裝、背景服務（launchd／systemd --user／nohup）、更新（先關掉執行中的服務）、start／stop／restart／status／logs／uninstall
script/uninstall.sh     Linux／macOS 反安裝（轉呼叫 install.sh uninstall）
script/install.ps1      Windows：同上（工作排程器）；檔案須為 UTF-8 with BOM，PowerShell 5.1 才不會把中文讀成亂碼
script/uninstall.ps1    Windows 反安裝（轉呼叫 install.ps1 -Action uninstall）
index.html             官網首頁（GitHub Pages：webchatmcp.js-package.xyz；含 og／twitter 分享標籤，中文分享圖在 assets/social/og.png）
favicon.ico            網站圖示（根目錄，16／32／48）
assets/social/         分享圖 og.png（1200×630）、og@2x.png
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

環境變數（詳見 `DESIGN.md` §2.1／§4.1／§6）：`WEBCHATMCP_PROFILE_DIR`、`WEBCHATMCP_CHANNEL`、`WEBCHATMCP_HEADLESS`（預設無頭；`0` 一律可視）、`WEBCHATMCP_ANSWER_TIMEOUT_MS`、`WEBCHATMCP_IDLE_CLOSE_SECONDS`（閒置幾秒後關閉無頭瀏覽器，預設 600，`0` 停用）、`WEBCHATMCP_PORT`、`WEBCHATMCP_HOST`、`WEBCHATMCP_PLUGINS_DIR`。

連線方式（同時啟用）：
- **stdio**：MCP 用戶端以子程序啟動 `dist/WebChatMCP.js`。
- **HTTP 直連**：`http://127.0.0.1:8321/mcp`（Streamable HTTP；`WEBCHATMCP_PORT` 改 port、`WEBCHATMCP_HOST=0.0.0.0` 開放區網）。

## 5. MCP 工具契約

每個工具（`webchat_close`、`webchat_release` 除外）都有 `provider?`：`chatgpt`｜`claude`｜`grok`｜`gemini`，預設 `chatgpt`；`webchat_status` 預設為目前頁面所屬的服務。

| 工具 | 輸入 | 輸出 |
|---|---|---|
| `webchat_login` | `provider?`、`timeout_seconds?`（10–900，預設 180） | JSON：`provider / loggedIn / alreadyLoggedIn / elapsedMs / profileDir / currentUrl / guidance`；先無頭查詢，已登入不顯示視窗 |
| `webchat_logout` | `provider?` | JSON：`provider / loggedOut / loggedIn / clearedDomains / guidance`；不顯示視窗 |
| `webchat_ask` | `provider?`、`prompt`（必填）、`model?`、`thinking?`、`timeout_seconds?`（10–600，預設 120） | 回覆純文字；`completed=false` 時加前綴提示；以訪客送出或 `temporaryChat≠true` 時加尾註；`thinking` 取自 `webchat_models` 的 `thinking[].label`，在選完 `model` 之後才套用 |
| `webchat_models` | `provider?` | JSON：`provider / count / models[] / thinkingCount / thinking[]`（每項 `label / current`；依帳號等級即時擷取；`thinking` 為思考深度，無此設定的服務為空） |
| `webchat_status` | `provider?` | JSON：`browserRunning / provider / loggedIn / temporaryChat / profileDir / currentUrl / chatUrl / privateChatUrl / guestAllowed / channel / http` |
| `webchat_close` | — | JSON：`closed / profileDir` |
| `webchat_warmup` | `provider?`、`model?` | JSON：`provider / warmed`；在背景瀏覽器先載好該服務的無痕聊天頁，帶 `model` 時連模型也先選好（供宿主在使用者切到網頁模型時呼叫）；無法預先載入（可視視窗、驗證頁、需登入）回 `warmed=false`，不報錯；`model` 選不到只是不預先設定，錯誤留給 `webchat_ask` 回報 |
| `webchat_release` | — | JSON：`released`；沒有網頁模型在用時關閉背景（無頭）瀏覽器；可視視窗不動 |

預先載入：`webchat_ask` 回覆後（沒有別的操作排隊時）會自動在背景載好同服務的下一個無痕聊天頁，並把這題用的 `model`／`thinking` 也先設好，下一題若指定同樣的值就直接用；沒指定 `model`／`thinking` 的下一題不得沿用預先設好的值（丟棄改現載）；頁面被其他導航動過也丟棄。已是目前選中的模型不再點選。背景瀏覽器的關閉有兩條路：omp／pi 外掛在使用者切到／切離 `webchat` 模型時呼叫 `webchat_warmup`（帶模型標籤）／`webchat_release`（omp 沒有換模型事件，改為每 500ms 讀一次 `ctx.model`；pi 用 `model_select`）；沒有切換訊號的宿主（Codex 等橋接、一般 MCP 用戶端）靠 `TIMEOUTS.idleCloseSeconds`（環境變數 `WEBCHATMCP_IDLE_CLOSE_SECONDS`，預設 600 秒，`0` 停用）：最後一次通訊後閒置這麼久就關閉無頭瀏覽器，可視視窗不動。

預載與取消：新的瀏覽器操作會取消尚未完成的預載；但同服務、且 `model`／`thinking` 相容（預載沒設，或與這題相同）的 `webchat_ask` 改為排在預載後面、直接接手它載好的頁面，不重新導航。`webchat_ask`／`webchat_login` 收到取消（MCP `notifications/cancelled`、連線關閉、橋接用戶端斷線、omp／pi 中止時送出取消通知）就在下一個安全點停止：尚未送出的提示不得再輸入或送出；已送出則盡力按停止鈕，立即釋放互斥鎖，且不排預載。取消不新增錯誤碼（被取消的 MCP 請求不回應）。

訪客：ChatGPT、Gemini 未登入也能 `webchat_ask`（已實測）；Claude、Grok 必須登入（Grok 訪客送出後被要求註冊，回 `logged_out`）。登入狀態以「可見登入按鈕＝未登入」判定，不因有輸入框就當作已登入。

回覆擷取契約：取各服務 `PROVIDERS[*].selectors.assistantMessage` 的最後一則（`.markdown/.prose` 優先）；完成判定＝連續 `TIMEOUTS.stableChecks` 次取樣文字不變且無停止鈕（`selectors.stopButton`）。

## 6. 錯誤碼

| code | 語意 |
|---|---|
| `logged_out` | 服務需要登入才能用（Claude、Grok），或訪客送出後被登入牆擋住；先 `webchat_login`。`guest=false` 的服務以訪客送出後 `TIMEOUTS.guestWallMs` 仍無回覆且仍未登入就提早回此錯，不等滿逾時。有輸入框且有回覆即使未登入也不報此錯（ChatGPT、Gemini 訪客可用） |
| `browser_error` | 瀏覽器啟動／導航失敗、停留在驗證（Cloudflare challenge）頁、找不到模型選單按鈕，或出現需要本人處理的對話框（如年齡確認） |
| `composer_not_found` | 找不到輸入框且判不出未登入（UI 大改版徵兆；改 `src/config.ts` 的 `PROVIDERS` 選擇器） |
| `send_failed` | 送出按鈕與 Enter 皆失敗 |
| `no_response` | 逾時未見回覆或回覆內容為空 |
| `model_not_found` | `model` 指定的模型不在選單清單內；先 `webchat_models` 查看 |
| `thinking_not_found` | `thinking` 指定的思考深度不在 `webchat_models` 的 `thinking` 清單內，或該服務沒有思考設定（如 Grok） |
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
- 內建只操作四個服務（ChatGPT、Claude、Grok、Gemini）自家頁面；其他網站只有在使用者自己放進外掛目錄的 JSON 外掛宣告時才會連線（外掛只是資料，不執行任何程式碼；網址須 https，`domains` 須是 `baseUrl` 的主機或上層網域，內建服務 id 不可被覆蓋）。不做任意網頁導航、不執行遠端腳本。
- `webchat_logout` 只清除該服務網域的 cookie（以網域條件清除，不讀取 cookie 內容）；不得動其他網站的 cookie。
- 需要使用者本人表態的對話框（例如 Grok 年齡確認）不得代填，回報 `browser_error` 並引導 `webchat_login`；升級／提示類對話框只點「暫時不要」「我知道了」這類略過鈕。
- HTTP endpoint **無任何認證**：預設只綁 `127.0.0.1`；對外開放（`0.0.0.0`）等同讓同網路任何人操作使用者的聊天會話，README 須明示風險。
