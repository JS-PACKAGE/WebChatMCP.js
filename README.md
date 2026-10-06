# WebChatMCP.js

**Website:** https://webchatmcp.js-package.xyz · **Source:** https://github.com/JS-PACKAGE/WebChatMCP.js · **License:** Apache-2.0

[English](#english) · [繁體中文](#繁體中文) · [日本語](#日本語)

An MCP server with a built-in browser. It sends your prompt through the **private / temporary chat** of **ChatGPT, Claude, Grok or Gemini** and returns the answer — nothing is written to the account's chat history. Logging in is optional for ChatGPT and Gemini (they also work as a guest); Claude and Grok need a login.

---

## English

### What is it?
WebChatMCP.js is a local MCP (Model Context Protocol) server. It embeds a persistent Chromium browser (Playwright) so an MCP client can drive the web interface of ChatGPT, Claude, Grok and Gemini: prompts flow through private chats and answers come back as tool results. Every tool takes a `provider` (`chatgpt` default, `claude`, `grok`, `gemini`).

### Features
- Built-in browser with persistent profile — logins survive restarts; one profile holds all four services.
- Works **without logging in** on ChatGPT and Gemini (guest). Claude and Grok require a login (a Grok guest is asked to sign up after sending and gets `logged_out`).
- Every `webchat_ask` opens a brand-new private chat: no history.
  | Service | How the private chat is entered |
  |---|---|
  | ChatGPT | `https://chatgpt.com/?temporary-chat=true` |
  | Claude | `https://claude.ai/new?incognito=` |
  | Grok | `https://grok.com/c#private` |
  | Gemini | `https://gemini.google.com/app`, then the **Temporary chat** button is clicked (the URL cannot enter it directly; guests have no such button) |
- The answer text is captured from the service's own response bubble and returned to the MCP client.
- `webchat_models` lists the models **and the thinking depth** (ChatGPT slider, Claude effort, Gemini extended thinking) of your account, live from the menus; `webchat_ask` can switch the model per prompt.
- `webchat_logout` signs out without showing any window; `webchat_login` checks first and only shows a window when a manual login is really needed.
- Honest state probing: login and private-chat detection return `true / false / unknown`, never guesses.
- Clear error codes (`logged_out`, `composer_not_found`, `no_response`, …) instead of silent failures.

### Requirements
- Node.js ≥ 22
- Optional: an account on the service you want to use (required for Claude and Grok)
- The browser is headless by default; a window only appears when a manual login (or a Cloudflare / age check) needs you

### Install
```bash
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git
cd WebChatMCP.js
npm install
npx playwright install chromium   # one-time: the built-in browser
npm run build
```

### Automatic install, background service and update (scripts)
The scripts in `script/` set up Node.js (if it is missing or older than 22, an official build is downloaded to `~/.webchatmcp/node` and its SHA-256 is verified), the dependencies and the built-in browser, build the project, then register and start it as a **background service**. No administrator rights needed.

| OS | Script | Background mechanism |
|---|---|---|
| macOS | `script/install.sh` | launchd LaunchAgent (starts at login, restarts on crash) |
| Linux | `script/install.sh` | systemd `--user` (falls back to `nohup`) |
| Windows | `script/install.ps1` | Task Scheduler (starts at logon, hidden window, restarts on failure) |

**Remote one-line install** (installs git and Node.js if missing, `git clone`s the source into `~/.webchatmcp/app` (Windows: `%USERPROFILE%\.webchatmcp\app`), then installs and starts the service):

```bash
# macOS / Linux
curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash
curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash -s -- update     # update
```

```powershell
# Windows (PowerShell)
& ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF)))            # install
& ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF))) update     # update
```

Missing git is installed with Homebrew on macOS (or by triggering the Command Line Tools installer), with the package manager on Linux (needs sudo unless root), and as MinGit under `%USERPROFILE%\.webchatmcp\git` on Windows (SHA-256 verified). Or clone the repository yourself and run the scripts from inside it:

```bash
# macOS / Linux
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git && cd WebChatMCP.js
script/install.sh                # install and start (default action: install)
script/install.sh update         # update: stops the running service → git pull → rebuild → restart
script/install.sh status         # status  (also: start / stop / restart / logs / uninstall)
```

```powershell
# Windows (PowerShell)
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git; cd WebChatMCP.js
powershell -ExecutionPolicy Bypass -File script\install.ps1            # install and start
powershell -ExecutionPolicy Bypass -File script\install.ps1 update     # update (same as above)
powershell -ExecutionPolicy Bypass -File script\install.ps1 status     # also: start / stop / restart / logs / uninstall
```

- **Update** first runs `git fetch` and does nothing when you are already up to date (`--force` / `-Force` rebuilds anyway). Otherwise it stops the running service and any leftover `WebChatMCP.js` processes (including instances an MCP client started over stdio), updates, then starts the service again. It aborts if the working tree has uncommitted changes.
- The service is reached over HTTP: `http://127.0.0.1:8321/mcp`. Put environment variables in `~/.webchatmcp/webchatmcp.env` (Windows: `%USERPROFILE%\.webchatmcp\webchatmcp.env`) as `KEY=VALUE` lines, then `restart`.
- The service and a stdio instance share one browser profile — pick one connection style.
- **Self-start**: after install the service starts automatically at login (on Linux also at boot without a login when linger is enabled) and restarts if it crashes; `status` shows the auto-start state. macOS uses a LaunchAgent, Linux `systemd --user` (crontab `@reboot` in the `nohup` fallback), Windows Task Scheduler (at logon).
- **Uninstall**: `script/uninstall.sh` (Windows: `script\uninstall.ps1`) stops the running service, then removes the **service registration and its autostart setup** (launchd plist / systemd unit / crontab `@reboot` / scheduled task, plus linger if the script enabled it). The source, the logged-in profile and the env file are kept by default (`--purge` / `-Purge` also removes Node.js, git, logs, the env file and the source downloaded by a remote install; `--purge-profile` / `-PurgeProfile` also deletes the profile).
- If the browser cannot start on Linux, run `npx playwright install-deps chromium` as root. The Windows script has not been verified on a real Windows machine.

### MCP client configuration
```json
{
  "mcpServers": {
    "webchatmcp": {
      "command": "node",
      "args": ["/absolute/path/to/WebChatMCP.js/dist/WebChatMCP.js"]
    }
  }
}
```

Or connect directly over HTTP (Streamable HTTP) — no child process needed:

```
http://127.0.0.1:8321/mcp
```

Both transports run at the same time. The port is written in `src/config.ts` (`SERVER.httpPort`, default `8321`) and can be overridden with `WEBCHATMCP_PORT`; `WEBCHATMCP_HOST=0.0.0.0` exposes it to the LAN (`0` disables HTTP).

### First run
1. Guest use needs no setup: call `webchat_ask` with your prompt (`provider` defaults to `chatgpt`).
2. To use your account (or Claude / Grok): call `webchat_login` with the `provider`. If you are already logged in, it returns immediately and shows no window; otherwise a window opens, you log in manually, and it is hidden again.
3. To sign out: call `webchat_logout` (no window).

If login opens a new tab, the server follows it. Fast replies are captured even when they appear immediately on send. Grok asks you to confirm your age once; the server never fills that in for you — run `webchat_login` with `provider=grok` and answer it in the window. After updating or rebuilding, restart the MCP server to load the new code (the saved profile is retained).

### Tools
Every tool except `webchat_close` accepts `provider?` (`chatgpt` | `claude` | `grok` | `gemini`, default `chatgpt`; `webchat_status` defaults to the service of the current page).

| Tool | Input | Output |
|---|---|---|
| `webchat_login` | `provider?`, `timeout_seconds?` | login status JSON (`alreadyLoggedIn`) |
| `webchat_logout` | `provider?` | JSON: cleared domains and the login state afterwards |
| `webchat_ask` | `provider?`, `prompt`, `model?`, `timeout_seconds?` | the answer text (a note is appended for guest use or unconfirmed private mode) |
| `webchat_models` | `provider?` | JSON: `models` and `thinking` lists (`label`, `current`) |
| `webchat_status` | `provider?` | browser / login / private-chat state JSON |
| `webchat_close` | — | close the built-in browser (logins stay saved) |

### Plugins (`plugins/`)
A single JSON file adds another chat service. Put it in `plugins/` or in the user directory `~/.webchatmcp/plugins/`; it is loaded at startup and joins the `provider` option of every tool (files whose name starts with `_` are templates and are not loaded). A plugin is just data — URLs and DOM selectors — and no code is executed. See [`plugins/README.md`](plugins/README.md) for the format and fields and [`plugins/_template.json`](plugins/_template.json) for a template; an invalid plugin is skipped and the reason goes to stderr. Only install plugins you trust.

**Oh My Pi plugin**: `plugins/omp/` holds an omp extension that makes WebChatMCP a model provider named `webchat` (`omp --model webchat/chatgpt`). Install and uninstall with the scripts (no root/administrator needed):

```bash
# Linux / macOS
plugins/omp/install.sh
plugins/omp/uninstall.sh            # uninstall; --purge also deletes the model cache
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File plugins\omp\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\omp\uninstall.ps1      # -Purge also deletes the model cache
```

Every plugin ships install and uninstall scripts. The omp plugin has no tool calls and no streaming; install details and limits are in [`plugins/omp/README.md`](plugins/omp/README.md).

### Environment variables
| Variable | Meaning |
|---|---|
| `WEBCHATMCP_PROFILE_DIR` | Browser profile directory (default `~/.webchatmcp/profile`) |
| `WEBCHATMCP_CHANNEL` | `chromium` (default) / `chrome` / `msedge` |
| `WEBCHATMCP_HEADLESS` | Default headless (window shown only for a manual login); `0` always shows the browser |
| `WEBCHATMCP_ANSWER_TIMEOUT_MS` | Answer wait limit (default `120000`) |
| `WEBCHATMCP_PORT` | HTTP port (default `8321`; `0` disables HTTP) |
| `WEBCHATMCP_HOST` | HTTP bind address (default `127.0.0.1`; `0.0.0.0` exposes to LAN — no auth, use with care) |
| `WEBCHATMCP_PLUGINS_DIR` | User plugin directory (default `~/.webchatmcp/plugins`; several directories separated by the OS path delimiter) |

### Notes
- Cloudflare may challenge fresh automated browsers. If the headless check cannot confirm login (including a challenge page), `webchat_login` switches to a visible window so you can pass it manually, then hides it again.
- `webchat_logout` clears the service's cookies from the profile. For Gemini that means `google.com`, which signs the built-in profile out of Google as a whole. It never touches other sites' cookies.
- The thinking-depth list of ChatGPT is read by stepping its slider with the arrow keys and restoring the original position; it briefly changes the setting.
- The HTTP endpoint has **no authentication**. It binds to `127.0.0.1` by default; exposing it (`0.0.0.0`) lets anyone on your network drive your chat sessions — only do this on trusted networks.
- The server never reads or stores passwords, cookies or tokens itself — login happens only through your own manual typing in the browser.
- Prompts and answers pass through the chosen service: that service's data usage policy applies.

---

## 繁體中文

### 這是什麼？
WebChatMCP.js 是本機 MCP（Model Context Protocol）伺服器。它內建持久化的 Chromium 瀏覽器（Playwright），讓 MCP 用戶端可以操作 **ChatGPT、Claude、Grok、Gemini** 的網頁介面：提示送進**無痕／臨時聊天**，回覆以工具結果回傳。每個工具都可用 `provider` 選服務（預設 `chatgpt`，另有 `claude`、`grok`、`gemini`）。

### 功能
- 內建瀏覽器＋持久化 profile——登入狀態重啟不失效，同一個 profile 放四個服務。
- ChatGPT、Gemini **不登入也能使用**（訪客）；Claude 與 Grok 必須登入（Grok 訪客送出後會被要求註冊，回 `logged_out`）。
- 每次 `webchat_ask` 都開啟全新的無痕聊天，不留歷史：
  | 服務 | 進入無痕的方式 |
  |---|---|
  | ChatGPT | `https://chatgpt.com/?temporary-chat=true` |
  | Claude | `https://claude.ai/new?incognito=` |
  | Grok | `https://grok.com/c#private` |
  | Gemini | 開啟 `https://gemini.google.com/app` 後點「**臨時對話**」按鈕（網址無法直接進入；訪客沒有此按鈕） |
- 回覆文字直接擷取自服務的回應氣泡，回傳給 MCP 用戶端。
- `webchat_models` 即時列出帳號可用的模型**與思考深度**（ChatGPT 滑桿、Claude 努力程度、Gemini 延伸思考）；`webchat_ask` 可逐題指定模型。
- `webchat_logout` 登出不跳出畫面；`webchat_login` 先查詢登入狀態，真的需要人工登入才顯示視窗。
- 誠實探測：登入與無痕判定回 `true / false / unknown`，絕不猜測。
- 明確錯誤碼（`logged_out`、`composer_not_found`、`no_response` 等），不靜默失敗。

### 需求
- Node.js ≥ 22
- 選用：想用的服務的帳號（Claude 與 Grok 必須有）
- 預設無頭；只有人工登入（或 Cloudflare／年齡確認需要你處理）時才會顯示視窗

### 安裝
```bash
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git
cd WebChatMCP.js
npm install
npx playwright install chromium   # 首次：安裝內建瀏覽器
npm run build
```

### 自動安裝、背景執行與更新（腳本）
`script/` 內的腳本會補齊 Node.js（沒有或低於 22 時，下載官方版本到 `~/.webchatmcp/node` 並驗證 SHA-256）、相依套件與內建瀏覽器，建置後註冊成**背景服務**並啟動，不需要系統管理員權限。

| 系統 | 腳本 | 背景方式 |
|---|---|---|
| macOS | `script/install.sh` | launchd LaunchAgent（登入時自動啟動、異常結束自動重啟） |
| Linux | `script/install.sh` | systemd `--user`（不可用時退回 `nohup`） |
| Windows | `script/install.ps1` | 工作排程器（登入時啟動、隱藏視窗、失敗自動重啟） |

**遠端一行安裝**（沒有 git、Node.js 會自動補齊，並 `git clone` 原始碼到 `~/.webchatmcp/app`（Windows 為 `%USERPROFILE%\.webchatmcp\app`），再安裝並啟動）：

```bash
# macOS / Linux
curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash
curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash -s -- update     # 更新
```

```powershell
# Windows（PowerShell）
& ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF)))            # 安裝
& ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF))) update     # 更新
```

缺 git 時：macOS 用 Homebrew（沒有就觸發命令列工具安裝）、Linux 用套件管理員（非 root 需要 sudo）、Windows 下載 MinGit 到 `%USERPROFILE%\.webchatmcp\git` 並驗證 SHA-256。以下是自己先 clone 倉庫再執行的方式：

```bash
# macOS / Linux
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git && cd WebChatMCP.js
script/install.sh                # 安裝並啟動（預設動作 install）
script/install.sh update         # 更新：自動關掉執行中的服務 → git pull → 重新建置 → 重新啟動
script/install.sh status         # 狀態  （另有 start / stop / restart / logs / uninstall）
```

```powershell
# Windows（PowerShell）
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git; cd WebChatMCP.js
powershell -ExecutionPolicy Bypass -File script\install.ps1            # 安裝並啟動
powershell -ExecutionPolicy Bypass -File script\install.ps1 update     # 更新（同上）
powershell -ExecutionPolicy Bypass -File script\install.ps1 status     # 另有 start / stop / restart / logs / uninstall
```

- **更新**會先 `git fetch` 檢查有沒有新版，沒有就什麼都不做（加 `--force`／`-Force` 可強制重新建置）。有新版時，先關掉執行中的服務與殘留的 `WebChatMCP.js` 行程（包含 MCP 用戶端以 stdio 啟動的實例），再更新，完成後把服務啟動回來。工作區有未提交的修改時會中止更新。
- 服務以 HTTP 提供連線：`http://127.0.0.1:8321/mcp`。環境變數寫在 `~/.webchatmcp/webchatmcp.env`（Windows 為 `%USERPROFILE%\.webchatmcp\webchatmcp.env`），格式 `KEY=VALUE`，改完 `restart` 生效。
- 背景服務與 stdio 實例共用同一個瀏覽器 profile，建議只選其中一種連線方式。
- **自起動**：安裝後服務會在登入時自動啟動（Linux 啟用 linger 時，開機不登入也會啟動），異常結束會自動重啟；`status` 會顯示「自動啟動」狀態。macOS 用 LaunchAgent、Linux 用 `systemd --user`（退回 `nohup` 時用 crontab 的 `@reboot`）、Windows 用工作排程器（登入時）。
- **反安裝**：`script/uninstall.sh`（Windows 為 `script\uninstall.ps1`）會先停掉執行中的服務，再移除**服務註冊與自起動設定**（launchd plist／systemd unit／crontab `@reboot`／排程工作，以及由腳本啟用的 linger）。原始碼、登入 profile 與設定檔預設保留（加 `--purge`／`-Purge` 連 Node.js、git、日誌與設定檔（含遠端安裝下載的原始碼）一起刪，加 `--purge-profile`／`-PurgeProfile` 才會刪掉登入 profile）。
- Linux 瀏覽器起不來時，用 root 執行 `npx playwright install-deps chromium`。Windows 腳本尚未在 Windows 實機上驗證。

### MCP 用戶端設定
```json
{
  "mcpServers": {
    "webchatmcp": {
      "command": "node",
      "args": ["/absolute/path/to/WebChatMCP.js/dist/WebChatMCP.js"]
    }
  }
}
```

或以 HTTP 直連（Streamable HTTP），不必啟動子程序：

```
http://127.0.0.1:8321/mcp
```

兩種連線同時啟用。port 寫在 `src/config.ts`（`SERVER.httpPort`，預設 `8321`），可用 `WEBCHATMCP_PORT` 覆蓋；`WEBCHATMCP_HOST=0.0.0.0` 開放區網（`0` 停用 HTTP）。

### 首次使用
1. 訪客使用（ChatGPT、Gemini）不需設定：直接呼叫 `webchat_ask` 送出提示（`provider` 預設 `chatgpt`）。
2. 想用自己的帳號（或使用 Claude／Grok）：以 `provider` 呼叫 `webchat_login`。已登入就立刻回傳、不顯示視窗；否則開啟視窗讓你人工登入，完成後收回。
3. 要登出：呼叫 `webchat_logout`（不顯示視窗）。

登入若開啟新分頁，伺服器會切換過去；立即出現的快速回覆也能擷取。Grok 首次使用會要你確認年齡，伺服器不會代填——請以 `provider=grok` 呼叫 `webchat_login`，在視窗中自行回答。更新或重新 build 後，請重啟 MCP 伺服器以載入新程式碼（原有 profile 保留）。

### 工具
除 `webchat_close` 外，每個工具都接受 `provider?`（`chatgpt`｜`claude`｜`grok`｜`gemini`，預設 `chatgpt`；`webchat_status` 預設為目前頁面所屬的服務）。

| 工具 | 輸入 | 輸出 |
|---|---|---|
| `webchat_login` | `provider?`、`timeout_seconds?` | 登入狀態 JSON（含 `alreadyLoggedIn`） |
| `webchat_logout` | `provider?` | JSON：清除的網域與登出後的登入狀態 |
| `webchat_ask` | `provider?`、`prompt`、`model?`、`timeout_seconds?` | 回覆文字（以訪客送出或無法確認無痕時附註記） |
| `webchat_models` | `provider?` | JSON：`models` 與 `thinking` 清單（`label`、`current`） |
| `webchat_status` | `provider?` | 瀏覽器／登入／無痕狀態 JSON |
| `webchat_close` | — | 關閉內建瀏覽器（登入狀態保留） |

### 外掛（`plugins/`）
用一個 JSON 檔就能新增其他聊天服務：放進 `plugins/` 或使用者目錄 `~/.webchatmcp/plugins/`，啟動時載入，並加入所有工具的 `provider` 選項（檔名以 `_` 開頭的是範本，不會載入）。外掛只是網址與 DOM 選擇器的資料，不會執行任何程式碼。格式、欄位與寫法見 [`plugins/README.md`](plugins/README.md) 與範本 [`plugins/_template.json`](plugins/_template.json)；格式錯誤的外掛會被略過，原因寫在 stderr。請只放你信任的外掛。

**Oh My Pi 外掛**：`plugins/omp/` 內有 omp 的擴充，讓 omp 把 WebChatMCP 當成模型提供商 `webchat`（`omp --model webchat/chatgpt`）。以腳本安裝與反安裝（不需要 root／系統管理員）：

```bash
# Linux / macOS
plugins/omp/install.sh
plugins/omp/uninstall.sh            # 反安裝；--purge 另刪模型快取
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\omp\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\omp\uninstall.ps1      # -Purge 另刪模型快取
```

每個外掛都附安裝與反安裝腳本。omp 外掛沒有工具呼叫、沒有串流；安裝細節與限制見 [`plugins/omp/README.md`](plugins/omp/README.md)。

### 環境變數
| 變數 | 意義 |
|---|---|
| `WEBCHATMCP_PROFILE_DIR` | 瀏覽器 profile 目錄（預設 `~/.webchatmcp/profile`） |
| `WEBCHATMCP_CHANNEL` | `chromium`（預設）／`chrome`／`msedge` |
| `WEBCHATMCP_HEADLESS` | 預設無頭（僅人工登入時顯示視窗）；設 `0` 則一律顯示瀏覽器 |
| `WEBCHATMCP_ANSWER_TIMEOUT_MS` | 等待回覆上限（預設 `120000`） |
| `WEBCHATMCP_PORT` | HTTP port（預設 `8321`；`0` 停用 HTTP） |
| `WEBCHATMCP_HOST` | HTTP 監聽位址（預設 `127.0.0.1`；`0.0.0.0` 開放區網——無認證，慎用） |
| `WEBCHATMCP_PLUGINS_DIR` | 使用者外掛目錄（預設 `~/.webchatmcp/plugins`；多個目錄以系統路徑分隔符號分開） |

### 注意事項
- Cloudflare 可能對全新自動化瀏覽器出驗證頁；無頭探測無法確認登入（含驗證頁）時，`webchat_login` 會切換為可視視窗讓你人工通過，完成後再收回無頭。
- `webchat_logout` 會清除該服務在 profile 中的 cookie。Gemini 對應 `google.com`，等於把內建瀏覽器整個登出 Google；不會動到其他網站的 cookie。
- ChatGPT 的思考深度清單是用方向鍵逐段走過滑桿讀取，再還原到原位置；過程中設定會短暫變動。
- HTTP endpoint **無任何認證**，預設只綁 `127.0.0.1`；開放（`0.0.0.0`）等同讓同網路任何人操作你的聊天會話，只建議在可信網路上使用。
- 伺服器本身不讀、不存任何密碼、cookie 或 token——登入只透過你自己在瀏覽器中操作。
- 提示與回覆會經過所選服務，適用該服務的資料使用政策。

---

## 日本語

### これは何？
WebChatMCP.js はローカルの MCP（Model Context Protocol）サーバーです。永続化された Chromium ブラウザ（Playwright）を内蔵し、MCP クライアントから **ChatGPT・Claude・Grok・Gemini** の Web 画面を操作します。プロンプトは**シークレット／一時チャット**に送られ、回答はツール結果として返ります。すべてのツールで `provider`（既定 `chatgpt`、ほか `claude`・`grok`・`gemini`）を選べます。

### 機能
- 内蔵ブラウザ＋永続プロファイル——ログインは再起動後も保持。1 つのプロファイルに 4 サービスを保存。
- ChatGPT・Gemini は**ログインなしでも利用可能**（ゲスト）。Claude と Grok はログイン必須（Grok はゲストで送信すると登録を求められ、`logged_out` を返します）。
- `webchat_ask` のたびに新しいシークレットチャットを開き、履歴に残りません：
  | サービス | シークレットに入る方法 |
  |---|---|
  | ChatGPT | `https://chatgpt.com/?temporary-chat=true` |
  | Claude | `https://claude.ai/new?incognito=` |
  | Grok | `https://grok.com/c#private` |
  | Gemini | `https://gemini.google.com/app` を開き「**一時チャット**」ボタンをクリック（URL では入れません。ゲストにはこのボタンがありません） |
- 回答テキストは各サービスの応答バブルから直接取得して返却。
- `webchat_models` でアカウントで使えるモデルと**思考の深さ**（ChatGPT のスライダー、Claude の努力レベル、Gemini の拡張思考）を一覧化；`webchat_ask` でプロンプトごとにモデル指定が可能。
- `webchat_logout` は画面を出さずにログアウト；`webchat_login` はまずログイン状態を確認し、手動ログインが必要なときだけウィンドウを表示。
- 正直な状態判定：ログイン／シークレットの検出は `true / false / unknown`、推測しません。
- 明確なエラーコード（`logged_out`、`composer_not_found`、`no_response` など）。

### 要件
- Node.js ≥ 22
- 任意：使いたいサービスのアカウント（Claude と Grok は必須）
- ブラウザは既定でヘッドレス。手動ログイン（または Cloudflare／年齢確認）が必要なときだけウィンドウを表示

### インストール
```bash
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git
cd WebChatMCP.js
npm install
npx playwright install chromium   # 初回のみ
npm run build
```

### 自動インストール・バックグラウンド実行・更新（スクリプト）
`script/` のスクリプトは、Node.js（22 未満または未導入なら `~/.webchatmcp/node` に公式版を SHA-256 検証付きで取得）・依存パッケージ・内蔵ブラウザを用意してビルドし、**バックグラウンドサービス**として登録・起動します。管理者権限は不要です。

| OS | スクリプト | バックグラウンド方式 |
|---|---|---|
| macOS | `script/install.sh` | launchd LaunchAgent（ログイン時に自動起動・異常終了で再起動） |
| Linux | `script/install.sh` | systemd `--user`（使えない場合は `nohup`） |
| Windows | `script/install.ps1` | タスク スケジューラ（ログオン時に起動・ウィンドウ非表示・失敗時に再起動） |

**リモート一行インストール**（git と Node.js が無ければ自動で用意し、`git clone` したソースを `~/.webchatmcp/app`（Windows は `%USERPROFILE%\.webchatmcp\app`）に置いて、インストール〜起動まで行います）：

```bash
# macOS / Linux
curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash
curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash -s -- update     # 更新
```

```powershell
# Windows（PowerShell）
& ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF)))            # インストール
& ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF))) update     # 更新
```

git が無い場合：macOS は Homebrew（無ければコマンドラインツールのインストールを起動）、Linux はパッケージマネージャ（root 以外は sudo が必要）、Windows は MinGit を `%USERPROFILE%\.webchatmcp\git` に取得して SHA-256 を検証します。以下はリポジトリを自分で clone した場合の手順です：

```bash
# macOS / Linux
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git && cd WebChatMCP.js
script/install.sh                # インストールして起動（既定は install）
script/install.sh update         # 更新：実行中のサービスを自動停止 → git pull → 再ビルド → 再起動
script/install.sh status         # 状態  （start / stop / restart / logs / uninstall も可）
```

```powershell
# Windows（PowerShell）
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git; cd WebChatMCP.js
powershell -ExecutionPolicy Bypass -File script\install.ps1            # インストールして起動
powershell -ExecutionPolicy Bypass -File script\install.ps1 update     # 更新（同上）
powershell -ExecutionPolicy Bypass -File script\install.ps1 status     # start / stop / restart / logs / uninstall も可
```

- **更新**は、まず `git fetch` で新しい版があるか確認し、なければ何もせず終了します（`--force`／`-Force` で再ビルド）。ある場合は実行中のサービスと残っている `WebChatMCP.js` プロセス（MCP クライアントが stdio で起動したものを含む）を停止してから更新し、完了後にサービスを起動し直します。未コミットの変更があると更新は中止します。
- サービスは HTTP で接続します：`http://127.0.0.1:8321/mcp`。環境変数は `~/.webchatmcp/webchatmcp.env`（Windows は `%USERPROFILE%\.webchatmcp\webchatmcp.env`）に `KEY=VALUE` で書き、`restart` で反映します。
- サービスと stdio 実体は同じブラウザプロファイルを共有するため、どちらか一方の接続方式を使ってください。
- **自起動**：インストールするとサービスはログイン時（Linux は linger が有効ならログインなしで起動時）に自動起動し、異常終了しても再起動します。`status` に「自動起動」の状態が出ます。macOS は LaunchAgent、Linux は `systemd --user`（`nohup` 時は crontab の `@reboot`）、Windows はタスク スケジューラ（ログオン時）です。
- **反インストール**：`script/uninstall.sh`（Windows は `script\uninstall.ps1`）は実行中のサービスを止め、**サービス登録と自起動の設定**（launchd の plist／systemd の unit／crontab の `@reboot`／タスク スケジューラのタスク、スクリプトが有効にした linger）を削除します。ソース・ログイン済みプロファイル・設定ファイルは残ります（`--purge`／`-Purge` で Node.js・git・ログ・設定（リモートインストールのソースも）、`--purge-profile`／`-PurgeProfile` でプロファイルも削除）。
- Linux でブラウザが起動しない場合は、root で `npx playwright install-deps chromium` を実行してください。Windows 用スクリプトは Windows 実機では未検証です。

### MCP クライアント設定
```json
{
  "mcpServers": {
    "webchatmcp": {
      "command": "node",
      "args": ["/absolute/path/to/WebChatMCP.js/dist/WebChatMCP.js"]
    }
  }
}
```

または HTTP で直接接続（Streamable HTTP）——子プロセス不要：

```
http://127.0.0.1:8321/mcp
```

両方の接続を同時に有効化。ポートは `src/config.ts`（`SERVER.httpPort`、既定 `8321`）に記載され、`WEBCHATMCP_PORT` で上書き可能；`WEBCHATMCP_HOST=0.0.0.0` で LAN に開放（`0` で HTTP 無効化）。

### 初回の流れ
1. ゲスト利用（ChatGPT・Gemini）は設定不要：`webchat_ask` にプロンプトを渡すだけ（`provider` 既定は `chatgpt`）。
2. 自分のアカウント（または Claude／Grok）を使う：`provider` を指定して `webchat_login`。ログイン済みなら即返却しウィンドウは出ません。未ログインならウィンドウが開き手動でログイン、完了後に再び隠します。
3. ログアウト：`webchat_logout`（ウィンドウなし）。

ログインで新しいタブが開いた場合、サーバーはそのタブを使用します。即座に表示される回答も取得できます。Grok は初回に年齢確認を求めますが、サーバーは代わりに入力しません——`provider=grok` で `webchat_login` を呼び、ウィンドウで自分で回答してください。更新・ビルド後は MCP サーバーを再起動してください（保存済みプロファイルは保持されます）。

### ツール
`webchat_close` 以外のすべてのツールが `provider?`（`chatgpt`｜`claude`｜`grok`｜`gemini`、既定 `chatgpt`；`webchat_status` は現在のページのサービスが既定）を受け付けます。

| ツール | 入力 | 出力 |
|---|---|---|
| `webchat_login` | `provider?`、`timeout_seconds?` | ログイン状態 JSON（`alreadyLoggedIn` 付き） |
| `webchat_logout` | `provider?` | JSON：クリアしたドメインとログアウト後のログイン状態 |
| `webchat_ask` | `provider?`、`prompt`、`model?`、`timeout_seconds?` | 回答テキスト（ゲスト送信やシークレット未確認時は注記付き） |
| `webchat_models` | `provider?` | JSON：`models` と `thinking` の一覧（`label`、`current`） |
| `webchat_status` | `provider?` | ブラウザ／ログイン／シークレット状態 JSON |
| `webchat_close` | — | 内蔵ブラウザを終了（ログインは保持） |

### プラグイン（`plugins/`）
JSON ファイル 1 つで他のチャットサービスを追加できます。`plugins/` またはユーザーディレクトリ `~/.webchatmcp/plugins/` に置くと、起動時に読み込まれ、すべてのツールの `provider` に加わります（ファイル名が `_` で始まるものはテンプレートで読み込まれません）。プラグインは URL と DOM セレクタだけのデータで、コードは実行されません。形式・フィールド・書き方は [`plugins/README.md`](plugins/README.md) と [`plugins/_template.json`](plugins/_template.json) を参照してください。不正なプラグインはスキップされ、理由が stderr に出ます。信頼できるプラグインだけを置いてください。

**Oh My Pi プラグイン**：`plugins/omp/` に omp の拡張があり、omp が WebChatMCP をモデルプロバイダー `webchat` として使えるようになります（`omp --model webchat/chatgpt`）。スクリプトでインストール／アンインストールします（root・管理者権限は不要）：

```bash
# Linux / macOS
plugins/omp/install.sh
plugins/omp/uninstall.sh            # アンインストール；--purge でモデルキャッシュも削除
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\omp\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\omp\uninstall.ps1      # -Purge でモデルキャッシュも削除
```

どのプラグインにもインストール／アンインストール用スクリプトが付属します。omp プラグインはツール呼び出し・ストリーミングに対応しません。詳細と制限は [`plugins/omp/README.md`](plugins/omp/README.md) を参照してください。

### 環境変数
| 変数 | 意味 |
|---|---|
| `WEBCHATMCP_PROFILE_DIR` | ブラウザプロファイルの場所（既定 `~/.webchatmcp/profile`） |
| `WEBCHATMCP_CHANNEL` | `chromium`（既定）／`chrome`／`msedge` |
| `WEBCHATMCP_HEADLESS` | 既定はヘッドレス（手動ログイン時のみ表示）；`0` で常に表示 |
| `WEBCHATMCP_ANSWER_TIMEOUT_MS` | 回答待ち上限（既定 `120000`） |
| `WEBCHATMCP_PORT` | HTTP ポート（既定 `8321`；`0` で HTTP 無効） |
| `WEBCHATMCP_HOST` | HTTP バインド先（既定 `127.0.0.1`；`0.0.0.0` で LAN 開放——認証なし、注意） |
| `WEBCHATMCP_PLUGINS_DIR` | ユーザープラグインの場所（既定 `~/.webchatmcp/plugins`；複数はパス区切り文字で区切る） |

### 注意
- 新規の自動化ブラウザには Cloudflare の検証がかかることがあります。ヘッドレスでログインを確認できない場合（検証ページ含む）、`webchat_login` は表示ウィンドウに切り替えて手動通過を促し、完了後に再びヘッドレスへ戻します。
- `webchat_logout` はプロファイル内の当該サービスの Cookie を削除します。Gemini は `google.com` が対象で、内蔵プロファイルが Google 全体からログアウトされます。他サイトの Cookie には触れません。
- ChatGPT の思考の深さは、矢印キーでスライダーを一段ずつ動かして読み取り、元の位置に戻します。その間、設定が一時的に変わります。
- HTTP エンドポイントには認証がありません。既定では `127.0.0.1` のみにバインドします。`0.0.0.0` で公開すると、同じネットワークの誰でもあなたのチャットセッションを操作できます。信頼できるネットワークでのみ使用してください。
- サーバー自体はパスワード・Cookie・トークンを読み書きしません。ログインは必ずご自身の手動操作によるものです。
- プロンプトと回答は選択したサービスを経由します（そのサービスのデータポリシーが適用されます）。
