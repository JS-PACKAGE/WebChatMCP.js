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
- `webchat_models` lists the models **and the thinking depth** (ChatGPT slider, Claude effort, Gemini extended thinking) of your account, live from the menus; `webchat_ask` can switch the model (`model`) and then the thinking depth (`thinking`) per prompt, using the labels from `webchat_models`.
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
| `webchat_ask` | `provider?`, `prompt`, `model?`, `thinking?`, `timeout_seconds?` | the answer text (a note is appended for guest use or unconfirmed private mode) |
| `webchat_models` | `provider?` | JSON: `models` and `thinking` lists (`label`, `current`) |
| `webchat_status` | `provider?` | browser / login / private-chat state JSON |
| `webchat_close` | — | close the built-in browser (logins stay saved) |
| `webchat_warmup` | `provider?` | preload the service's private chat page (for host integrations) |
| `webchat_release` | — | close the background browser when no webchat model is in use |

After each answer the server preloads the next private chat page in the background, so the next question skips the page load, and the headless browser stays up until `webchat_release` or `webchat_close`. `webchat_warmup` preloads a service's page ahead of the first question. The Oh My Pi and Pi plugins call both for you: switching to a `webchat` model preloads that service's page, and switching away to another model (or quitting) releases the browser. A visible browser window (login in progress, `WEBCHATMCP_HEADLESS=0`) is never closed or preloaded automatically.

### Plugins (`plugins/`)
A single JSON file adds another chat service. Put it in `plugins/` or in the user directory `~/.webchatmcp/plugins/`; it is loaded at startup and joins the `provider` option of every tool (files whose name starts with `_` are templates and are not loaded). A plugin is just data — URLs and DOM selectors — and no code is executed. See [`plugins/README.md`](plugins/README.md) for the format and fields and [`plugins/_template.json`](plugins/_template.json) for a template; an invalid plugin is skipped and the reason goes to stderr. Only install plugins you trust.

**Oh My Pi plugin**: `plugins/omp/` holds an omp extension that makes WebChatMCP a model provider named `webchat`. Run `/webchat-refresh` first; model ids are `webchat/<service>/<label>`. `/webchat-login` with no argument checks ChatGPT, Claude, Grok and Gemini. Bare service names are not listed. Install and uninstall with the scripts (no root/administrator needed):

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

Every plugin ships install and uninstall scripts. All model plugins (omp, pi, Codex, Claude, Grok, Hermes) support a **local tool round trip**: the host sends your question and its tool list; the web model only *requests* a tool with a strict JSON envelope (bound to a per-request nonce, checked against the host's tool names and required arguments — free text is never executed); the plugin turns it into the host's native tool call; the host runs it under its own permissions and confirmations and the result goes back to the web model, until it answers. Every web chat is a fresh private chat, so each turn re-sends the system prompt (truncated to 24k characters), the history, earlier tool calls and their results (each result truncated to 50k characters). File contents and command output you let the host read are sent to the chosen service's platform. No streaming; install details and limits are in [`plugins/omp/README.md`](plugins/omp/README.md).

**Codex plugin**: `plugins/codex/` adds refreshed web models whose names end in `(WEB)` (e.g. `ChatGPT · GPT-5.5 (WEB)`) to Codex's model picker. Names with no model label, such as `ChatGPT (WEB)`, are not listed. Picking one sends the chat through WebChatMCP's private chat; requests for official models are forwarded untouched to the official backend. The scripts first **close every running Codex** and then edit `openai_base_url` in `~/.codex/config.toml` (if Codex cannot be closed they tell you to close it manually and change nothing); uninstalling restores it:

```bash
# Linux / macOS
plugins/codex/install.sh
plugins/codex/uninstall.sh          # uninstall; --purge also deletes the backup
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File plugins\codex\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\codex\uninstall.ps1      # -Purge also deletes the backup
```

Local tool round trip (Codex runs the tools), no streaming; and while the WebChatMCP server is not running, official models cannot connect either. See [`plugins/codex/README.md`](plugins/codex/README.md).

**Claude plugin**: `plugins/claude/` adds refreshed web models whose names end in `(WEB)` (e.g. `ChatGPT · GPT-5.5 (WEB)`) to Claude Code's `/model` picker. Names with no model label are not listed. Picking one sends the chat through WebChatMCP's private chat; requests for official models are forwarded untouched to `api.anthropic.com`. The scripts first **close every running Claude** (CLI and desktop app) and then set `env.ANTHROPIC_BASE_URL` and `modelPicker` in `~/.claude/settings.json` (if Claude cannot be closed they tell you to close it manually and change nothing); uninstalling restores it:

```bash
# Linux / macOS
plugins/claude/install.sh
plugins/claude/uninstall.sh          # uninstall; --purge also deletes the backup
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File plugins\claude\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\claude\uninstall.ps1      # -Purge also deletes the backup
```

Local tool round trip (Claude Code runs the tools), no streaming; and while the WebChatMCP server is not running, official models cannot connect either. See [`plugins/claude/README.md`](plugins/claude/README.md).

**Grok plugin**: `plugins/grok/` adds refreshed web models whose names end in `(WEB)` (e.g. `ChatGPT · GPT-5.5 (WEB)`) to Grok Build's (`grok` CLI) model picker as custom models. Names with no model label are not listed. Only those models go through WebChatMCP's private chat; official models are untouched. The scripts first **close every running grok** (including the resident leader process) and then add a marked block to `~/.grok/config.toml` (if grok cannot be closed they tell you to close it manually and change nothing); uninstalling removes it:

```bash
# Linux / macOS
plugins/grok/install.sh
plugins/grok/uninstall.sh          # uninstall; --purge also deletes the backup
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File plugins\grok\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\grok\uninstall.ps1      # -Purge also deletes the backup
```

Local tool round trip (Grok Build runs the tools), no streaming. See [`plugins/grok/README.md`](plugins/grok/README.md).

**Pi plugin**: `plugins/pi/` holds a [pi](https://pi.dev) extension that makes WebChatMCP a model provider named `webchat`. Run `/webchat-refresh` first; model ids are `webchat/<service>/<label>`. `/webchat-login` with no argument checks ChatGPT, Claude, Grok and Gemini. Bare service names are not listed. Install and uninstall with the scripts (no root/administrator needed; restart pi afterwards):

```bash
# Linux / macOS
plugins/pi/install.sh
plugins/pi/uninstall.sh            # uninstall; --purge also deletes the model cache
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File plugins\pi\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\pi\uninstall.ps1      # -Purge also deletes the model cache
```

Local tool round trip (pi runs the tools), no streaming. See [`plugins/pi/README.md`](plugins/pi/README.md).

**Hermes plugin**: `plugins/hermes/` registers a Hermes Agent model provider named `webchat` (model id `<service>/<label>` after refresh; bare names like `chatgpt` are not listed). Hermes will not register an API-key provider that has no `env_vars`, and an explicitly selected provider with no key fails immediately — `fallback_models` is empty and is only the picker list when `GET /models` fails, not a credential fallback. The install script therefore writes a dummy `WEBCHAT_API_KEY` (the bridge ignores it) and does **not** change `model.provider`:

```bash
# Linux / macOS
plugins/hermes/install.sh
plugins/hermes/uninstall.sh            # uninstall; --purge also deletes the model cache
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File plugins\\hermes\\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\\hermes\\uninstall.ps1      # -Purge also deletes the model cache
```

Local tool round trip (Hermes runs the tools), no streaming. See [`plugins/hermes/README.md`](plugins/hermes/README.md).

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
| `WEBCHATMCP_CODEX_BRIDGE` | `0` disables the Codex bridge (see `plugins/codex`). `WEBCHATMCP_CODEX_UPSTREAM` = upstream for non-web models, `WEBCHATMCP_CODEX_MODELS` = model-list cache path |
| `WEBCHATMCP_CLAUDE_BRIDGE` | `0` disables the Claude bridge (see `plugins/claude`). `WEBCHATMCP_CLAUDE_UPSTREAM` = upstream for non-web models |
| `WEBCHATMCP_GROK_BRIDGE` | `0` disables the Grok bridge (see `plugins/grok`) |
| `WEBCHATMCP_HERMES_BRIDGE` | `0` disables the Hermes bridge (see `plugins/hermes`). `WEBCHATMCP_HERMES_MODELS` = model-list cache path |

### Notes
- Cloudflare may challenge fresh automated browsers. If the headless check cannot confirm login (including a challenge page), `webchat_login` switches to a visible window so you can pass it manually, then hides it again.
- `webchat_logout` clears the service's cookies from the profile. For Gemini that means `google.com`, which signs the built-in profile out of Google as a whole. It never touches other sites' cookies.
- The thinking-depth list of ChatGPT is read by stepping its slider with the arrow keys and restoring the original position; it briefly changes the setting.
- `thinking` is applied after `model` (the available depths can depend on the model). An unknown label returns `thinking_not_found`, and so does a service with no thinking setting (Grok folds it into its modes — pick it with `model`). For Gemini's on/off toggles (e.g. extended thinking) `thinking` only turns the toggle **on**; an already-on toggle is left alone.
- Codex plugin: when refreshing, ChatGPT, Claude and Gemini are switched model by model to read each model's own thinking depths (slow, but only on refresh). A model with two or more web depths (ChatGPT slider, Claude effort) shows them as its reasoning levels in Codex, with the web label as the value, and the choice is applied on the web before sending. Toggle-only (Gemini) and no-setting (Grok) models keep a single `medium` that is ignored. Other host plugins do not pass a thinking depth yet.
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
- `webchat_models` 即時列出帳號可用的模型**與思考深度**（ChatGPT 滑桿、Claude 努力程度、Gemini 延伸思考）；`webchat_ask` 可逐題指定模型（`model`），再指定思考深度（`thinking`），標籤取自 `webchat_models`。
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
| `webchat_ask` | `provider?`、`prompt`、`model?`、`thinking?`、`timeout_seconds?` | 回覆文字（以訪客送出或無法確認無痕時附註記） |
| `webchat_models` | `provider?` | JSON：`models` 與 `thinking` 清單（`label`、`current`） |
| `webchat_status` | `provider?` | 瀏覽器／登入／無痕狀態 JSON |
| `webchat_close` | — | 關閉內建瀏覽器（登入狀態保留） |
| `webchat_warmup` | `provider?` | 預先載入該服務的無痕聊天頁（給宿主整合用） |
| `webchat_release` | — | 沒有網頁模型在用時，關閉背景瀏覽器 |

每次回覆後，伺服器會在背景先載好下一個無痕聊天頁，下一題就不必再等頁面載入；無頭瀏覽器會一直待命，直到 `webchat_release` 或 `webchat_close`。`webchat_warmup` 可在第一題之前先載好某個服務的頁面。Oh My Pi 與 Pi 外掛會替你呼叫這兩個工具：切到 `webchat` 模型就先載入該服務的頁面，切換到其他模型（或結束）就釋放瀏覽器。可視的瀏覽器視窗（登入進行中、`WEBCHATMCP_HEADLESS=0`）不會被自動關閉或預先載入。

### 外掛（`plugins/`）
用一個 JSON 檔就能新增其他聊天服務：放進 `plugins/` 或使用者目錄 `~/.webchatmcp/plugins/`，啟動時載入，並加入所有工具的 `provider` 選項（檔名以 `_` 開頭的是範本，不會載入）。外掛只是網址與 DOM 選擇器的資料，不會執行任何程式碼。格式、欄位與寫法見 [`plugins/README.md`](plugins/README.md) 與範本 [`plugins/_template.json`](plugins/_template.json)；格式錯誤的外掛會被略過，原因寫在 stderr。請只放你信任的外掛。

**Oh My Pi 外掛**：`plugins/omp/` 內有 omp 的擴充，讓 omp 把 WebChatMCP 當成模型提供商 `webchat`。先 `/webchat-refresh` 才有模型，id 是 `webchat/<服務>/<模型標籤>`；`/webchat-login` 不帶參數會檢查 ChatGPT、Claude、Grok、Gemini。沒有模型標籤的服務名稱不會進清單。以腳本安裝與反安裝（不需要 root／系統管理員）：

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

每個外掛都附安裝與反安裝腳本。所有模型外掛（omp、pi、Codex、Claude、Grok、Hermes）都支援**本機工具往返**：宿主把你的問題與它的工具清單送來；網頁模型只會用嚴格的 JSON 信封「提出要求」（綁定每次請求的隨機 nonce，並比對宿主的工具名稱與必要參數，隨便寫出的文字永遠不會被執行）；外掛把它轉成宿主原生的工具呼叫；宿主依自己的權限與確認設定在本機執行，結果再送回網頁模型，直到它給出答案。每次網頁聊天都是全新的無痕聊天，所以每一輪都會重新帶入系統提示（截斷到 24k 字元）、對話、先前的工具要求與結果（每則結果截斷到 50k 字元）。你讓宿主讀取的檔案內容與指令輸出，會傳到所選服務的平台。沒有串流；安裝細節與限制見 [`plugins/omp/README.md`](plugins/omp/README.md)。

**Codex 外掛**：`plugins/codex/` 讓 Codex 的模型選單多出名稱結尾為 `(WEB)` 的網頁模型（如 `ChatGPT · GPT-5.5 (WEB)`；沒有模型標籤的服務名稱不會進清單）。選了它們就經由 WebChatMCP 走無痕聊天；官方模型的請求原樣轉送官方後端。腳本會先**關閉所有執行中的 Codex**，再改 `~/.codex/config.toml` 的 `openai_base_url`（關不掉就提示你手動關閉，且不動設定），反安裝時還原：

```bash
# Linux / macOS
plugins/codex/install.sh
plugins/codex/uninstall.sh          # 反安裝；--purge 另刪備份
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\codex\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\codex\uninstall.ps1      # -Purge 另刪備份
```

本機工具往返（由 Codex 執行工具）、沒有串流；WebChatMCP 伺服器沒開時官方模型也會連不上等注意事項見 [`plugins/codex/README.md`](plugins/codex/README.md)。

**Claude 外掛**：`plugins/claude/` 讓 Claude Code 的 `/model` 選單多出名稱結尾為 `(WEB)` 的網頁模型（如 `ChatGPT · GPT-5.5 (WEB)`；沒有模型標籤的服務名稱不會進清單）。選了它們就經由 WebChatMCP 走無痕聊天；官方模型的請求原樣轉送 `api.anthropic.com`。腳本會先**關閉所有執行中的 Claude**（CLI 與桌面 App），再改 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` 與 `modelPicker`（關不掉就提示你手動關閉，且不動設定），反安裝時還原：

```bash
# Linux / macOS
plugins/claude/install.sh
plugins/claude/uninstall.sh          # 反安裝；--purge 另刪備份
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\claude\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\claude\uninstall.ps1      # -Purge 另刪備份
```

本機工具往返（由 Claude Code 執行工具）、沒有串流；WebChatMCP 伺服器沒開時官方模型也會連不上等注意事項見 [`plugins/claude/README.md`](plugins/claude/README.md)。

**Grok 外掛**：`plugins/grok/` 以自訂模型的方式，讓 Grok Build（`grok` CLI）的模型選單多出名稱結尾為 `(WEB)` 的網頁模型（如 `ChatGPT · GPT-5.5 (WEB)`；沒有模型標籤的服務名稱不會進清單）。只有這些模型經由 WebChatMCP 走無痕聊天，官方模型完全不受影響。腳本會先**關閉所有執行中的 grok**（含常駐的 leader 行程），再在 `~/.grok/config.toml` 加一段標記區塊（關不掉就提示你手動關閉，且不動設定），反安裝時移除：

```bash
# Linux / macOS
plugins/grok/install.sh
plugins/grok/uninstall.sh          # 反安裝；--purge 另刪備份
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\grok\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\grok\uninstall.ps1      # -Purge 另刪備份
```

本機工具往返（由 Grok Build 執行工具）、沒有串流；細節見 [`plugins/grok/README.md`](plugins/grok/README.md)。

**Pi 外掛**：`plugins/pi/` 內有 [pi](https://pi.dev) 的擴充，讓 pi 把 WebChatMCP 當成模型提供商 `webchat`。先 `/webchat-refresh` 才有模型，id 是 `webchat/<服務>/<模型標籤>`；`/webchat-login` 不帶參數會檢查 ChatGPT、Claude、Grok、Gemini。沒有模型標籤的服務名稱不會進清單。以腳本安裝與反安裝（不需要 root／系統管理員；裝完請重啟 pi）：

```bash
# Linux / macOS
plugins/pi/install.sh
plugins/pi/uninstall.sh            # 反安裝；--purge 另刪模型快取
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\pi\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\pi\uninstall.ps1      # -Purge 另刪模型快取
```

本機工具往返（由 pi 執行工具）、沒有串流；細節見 [`plugins/pi/README.md`](plugins/pi/README.md)。

**Hermes 外掛**：`plugins/hermes/` 讓 Hermes Agent 把 WebChatMCP 當成模型提供商 `webchat`（模型 id 是 `<服務>/<模型標籤>`，先 refresh；`chatgpt` 這種沒有模型的名稱不會進清單）。沒有 `env_vars` 的 api_key 提供商不會被註冊；明確指定的提供商沒有金鑰時直接失敗，不會改走別家。`fallback_models` 留空，只是 `GET /models` 失敗時的選單後備，不是金鑰備援。安裝腳本因此寫入假的 `WEBCHAT_API_KEY`（橋接不驗證），而且**不改** `model.provider`：

```bash
# Linux / macOS
plugins/hermes/install.sh
plugins/hermes/uninstall.sh            # 反安裝；--purge 另刪模型快取
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\\hermes\\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\\hermes\\uninstall.ps1      # -Purge 另刪模型快取
```

本機工具往返（由 Hermes 執行工具）、沒有串流；細節見 [`plugins/hermes/README.md`](plugins/hermes/README.md)。

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
| `WEBCHATMCP_CODEX_BRIDGE` | 設 `0` 停用 Codex 橋接（見 `plugins/codex`）。`WEBCHATMCP_CODEX_UPSTREAM`＝非網頁模型的上游網址、`WEBCHATMCP_CODEX_MODELS`＝模型清單快取位置 |
| `WEBCHATMCP_CLAUDE_BRIDGE` | 設 `0` 停用 Claude 橋接（見 `plugins/claude`）。`WEBCHATMCP_CLAUDE_UPSTREAM`＝非網頁模型的上游網址 |
| `WEBCHATMCP_GROK_BRIDGE` | 設 `0` 停用 Grok 橋接（見 `plugins/grok`） |
| `WEBCHATMCP_HERMES_BRIDGE` | 設 `0` 停用 Hermes 橋接（見 `plugins/hermes`）。`WEBCHATMCP_HERMES_MODELS`＝模型清單快取路徑 |

### 注意事項
- Cloudflare 可能對全新自動化瀏覽器出驗證頁；無頭探測無法確認登入（含驗證頁）時，`webchat_login` 會切換為可視視窗讓你人工通過，完成後再收回無頭。
- `webchat_logout` 會清除該服務在 profile 中的 cookie。Gemini 對應 `google.com`，等於把內建瀏覽器整個登出 Google；不會動到其他網站的 cookie。
- ChatGPT 的思考深度清單是用方向鍵逐段走過滑桿讀取，再還原到原位置；過程中設定會短暫變動。
- `thinking` 在選完 `model` 之後才套用（可選的深度會隨模型而異）。標籤不在清單內會回 `thinking_not_found`；沒有思考設定的服務（Grok 把它併在模式裡，請用 `model` 選）也一樣。Gemini 的開關項（如延伸思考）指定 `thinking` 只會把開關**打開**，已經開著就不會動它。
- Codex 外掛：重新擷取時會對 ChatGPT、Claude、Gemini 逐一切換模型，讀出各模型自己的思考深度（較慢，但只在重新擷取時）。網頁上有兩段以上深度（ChatGPT 滑桿、Claude 努力程度）的模型，會把它們宣告成 Codex 的 reasoning 選項，值就是網頁標籤原樣，選了之後會在送出前先在網頁設好；只有開關型（Gemini）或沒有設定（Grok）的模型維持單一 `medium`，且會被忽略。其他宿主外掛目前還不會傳思考深度。
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
- `webchat_models` でアカウントで使えるモデルと**思考の深さ**（ChatGPT のスライダー、Claude の努力レベル、Gemini の拡張思考）を一覧化；`webchat_ask` でプロンプトごとにモデル（`model`）と、続けて思考の深さ（`thinking`）を指定可能（ラベルは `webchat_models` のもの）。
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
| `webchat_ask` | `provider?`、`prompt`、`model?`、`thinking?`、`timeout_seconds?` | 回答テキスト（ゲスト送信やシークレット未確認時は注記付き） |
| `webchat_models` | `provider?` | JSON：`models` と `thinking` の一覧（`label`、`current`） |
| `webchat_status` | `provider?` | ブラウザ／ログイン／シークレット状態 JSON |
| `webchat_close` | — | 内蔵ブラウザを終了（ログインは保持） |
| `webchat_warmup` | `provider?` | サービスのシークレットチャットページを先読み（ホスト連携用） |
| `webchat_release` | — | webchat モデルを使っていないときにバックグラウンドのブラウザを終了 |

回答のたびに、サーバーはバックグラウンドで次のシークレットチャットページを先に読み込み、次の質問ではページの読み込みを待たずに済みます。ヘッドレスブラウザは `webchat_release` または `webchat_close` まで待機します。`webchat_warmup` で最初の質問の前にサービスのページを先読みできます。Oh My Pi と Pi のプラグインがこの 2 つを自動で呼び出します：`webchat` モデルに切り替えるとそのサービスのページを先読みし、他のモデルへ切り替える（または終了する）とブラウザを解放します。表示中のブラウザウィンドウ（ログイン中、`WEBCHATMCP_HEADLESS=0`）は自動で閉じたり先読みしたりしません。

### プラグイン（`plugins/`）
JSON ファイル 1 つで他のチャットサービスを追加できます。`plugins/` またはユーザーディレクトリ `~/.webchatmcp/plugins/` に置くと、起動時に読み込まれ、すべてのツールの `provider` に加わります（ファイル名が `_` で始まるものはテンプレートで読み込まれません）。プラグインは URL と DOM セレクタだけのデータで、コードは実行されません。形式・フィールド・書き方は [`plugins/README.md`](plugins/README.md) と [`plugins/_template.json`](plugins/_template.json) を参照してください。不正なプラグインはスキップされ、理由が stderr に出ます。信頼できるプラグインだけを置いてください。

**Oh My Pi プラグイン**：`plugins/omp/` に omp の拡張があり、omp が WebChatMCP をモデルプロバイダー `webchat` として使えるようになります。先に `/webchat-refresh` が必要で、モデル id は `webchat/<サービス>/<ラベル>` です。`/webchat-login` を引数なしで実行すると ChatGPT、Claude、Grok、Gemini をすべて確認します。モデルのないサービス名は一覧に入りません。スクリプトでインストール／アンインストールします（root・管理者権限は不要）：

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

**Codex プラグイン**：`plugins/codex/` により、Codex のモデル一覧に名前が `(WEB)` で終わる Web モデル（`ChatGPT · GPT-5.5 (WEB)` など。モデルのないサービス名は入りません）が加わります。選ぶと WebChatMCP 経由でプライベートチャットに送られ、公式モデルのリクエストはそのまま公式バックエンドへ転送されます。スクリプトは**実行中の Codex をすべて終了**してから `~/.codex/config.toml` の `openai_base_url` を書き換え（終了できなければ手動での終了を促して設定は変更しません）、アンインストールで元に戻します：

```bash
# Linux / macOS
plugins/codex/install.sh
plugins/codex/uninstall.sh          # アンインストール；--purge でバックアップも削除
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\codex\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\codex\uninstall.ps1      # -Purge でバックアップも削除
```

ツール呼び出し・ストリーミングには対応しません。WebChatMCP サーバーが停止していると公式モデルにも接続できなくなる点などは [`plugins/codex/README.md`](plugins/codex/README.md) を参照してください。

**Claude プラグイン**：`plugins/claude/` により、Claude Code の `/model` に名前が `(WEB)` で終わる Web モデル（`ChatGPT · GPT-5.5 (WEB)` など。モデルのないサービス名は入りません）が加わります。選ぶと WebChatMCP 経由でプライベートチャットに送られ、公式モデルのリクエストはそのまま `api.anthropic.com` へ転送されます。スクリプトは**実行中の Claude（CLI とデスクトップアプリ）をすべて終了**してから `~/.claude/settings.json` の `env.ANTHROPIC_BASE_URL` と `modelPicker` を書き換え（終了できなければ手動での終了を促して設定は変更しません）、アンインストールで元に戻します：

```bash
# Linux / macOS
plugins/claude/install.sh
plugins/claude/uninstall.sh          # アンインストール；--purge でバックアップも削除
```

```powershell
# Windows （PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\claude\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\claude\uninstall.ps1      # -Purge でバックアップも削除
```

ツール呼び出し・ストリーミングには対応しません。WebChatMCP サーバーが停止していると公式モデルにも接続できなくなる点などは [`plugins/claude/README.md`](plugins/claude/README.md) を参照してください。

**Grok プラグイン**：`plugins/grok/` により、Grok Build（`grok` CLI）のモデル一覧にカスタムモデルとして名前が `(WEB)` で終わる Web モデル（`ChatGPT · GPT-5.5 (WEB)` など。モデルのないサービス名は入りません）が加わります。それらのモデルだけが WebChatMCP 経由でプライベートチャットに送られ、公式モデルには影響しません。スクリプトは**実行中の grok（常駐の leader を含む）をすべて終了**してから `~/.grok/config.toml` に目印付きのブロックを追加し（終了できなければ手動での終了を促して設定は変更しません）、アンインストールで削除します：

```bash
# Linux / macOS
plugins/grok/install.sh
plugins/grok/uninstall.sh          # アンインストール；--purge でバックアップも削除
```

```powershell
# Windows （PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\grok\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\grok\uninstall.ps1      # -Purge でバックアップも削除
```

ツール呼び出し・ストリーミングには対応しません。詳細は [`plugins/grok/README.md`](plugins/grok/README.md) を参照してください。

**Pi プラグイン**：`plugins/pi/` に [pi](https://pi.dev) の拡張があり、pi が WebChatMCP をモデルプロバイダー `webchat` として使えるようになります。先に `/webchat-refresh` が必要で、モデル id は `webchat/<サービス>/<ラベル>` です。`/webchat-login` を引数なしで実行すると ChatGPT、Claude、Grok、Gemini をすべて確認します。モデルのないサービス名は一覧に入りません。スクリプトでインストール／アンインストールします（root・管理者権限は不要、後で pi を再起動）：

```bash
# Linux / macOS
plugins/pi/install.sh
plugins/pi/uninstall.sh            # アンインストール；--purge でモデルキャッシュも削除
```

```powershell
# Windows （PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\pi\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\pi\uninstall.ps1      # -Purge でモデルキャッシュも削除
```

ツール呼び出し・ストリーミングには対応しません。詳細は [`plugins/pi/README.md`](plugins/pi/README.md) を参照してください。

**Hermes プラグイン**：`plugins/hermes/` は Hermes Agent にモデルプロバイダー `webchat` を登録します（モデル id は `<サービス>/<ラベル>`。refresh が必要で、`chatgpt` のようなモデルのない名前は一覧に入りません）。`env_vars` のない api_key プロバイダーは登録されず、明示したプロバイダーに鍵がないと即失敗します。`fallback_models` は空で、`GET /models` 失敗時の一覧用であり、認証のフォールバックではありません。インストールはダミーの `WEBCHAT_API_KEY` を書き（橋接は検証しない）、`model.provider` は変えません：

```bash
# Linux / macOS
plugins/hermes/install.sh
plugins/hermes/uninstall.sh            # アンインストール；--purge でモデルキャッシュも削除
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File plugins\\hermes\\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\\hermes\\uninstall.ps1
```

ツール呼び出し・ストリーミングには対応しません。詳細は [`plugins/hermes/README.md`](plugins/hermes/README.md) を参照してください。

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
| `WEBCHATMCP_CODEX_BRIDGE` | Codex 橋接の無効化（`0`）。`WEBCHATMCP_CODEX_UPSTREAM`＝公式以外のモデルの転送先、`WEBCHATMCP_CODEX_MODELS`＝モデル一覧キャッシュの場所 |
| `WEBCHATMCP_CLAUDE_BRIDGE` | Claude 橋接の無効化（`0`）。`WEBCHATMCP_CLAUDE_UPSTREAM`＝公式以外のモデルの転送先 |
| `WEBCHATMCP_GROK_BRIDGE` | Grok 橋接の無効化（`0`、`plugins/grok` 参照） |
| `WEBCHATMCP_HERMES_BRIDGE` | Hermes 橋接の無効化（`0`、`plugins/hermes` 参照）。`WEBCHATMCP_HERMES_MODELS`＝モデル一覧キャッシュ |

### 注意
- 新規の自動化ブラウザには Cloudflare の検証がかかることがあります。ヘッドレスでログインを確認できない場合（検証ページ含む）、`webchat_login` は表示ウィンドウに切り替えて手動通過を促し、完了後に再びヘッドレスへ戻します。
- `webchat_logout` はプロファイル内の当該サービスの Cookie を削除します。Gemini は `google.com` が対象で、内蔵プロファイルが Google 全体からログアウトされます。他サイトの Cookie には触れません。
- ChatGPT の思考の深さは、矢印キーでスライダーを一段ずつ動かして読み取り、元の位置に戻します。その間、設定が一時的に変わります。
- `thinking` は `model` の選択後に適用されます（選べる深さはモデルによって変わるため）。一覧にないラベル、または思考設定のないサービス（Grok はモードに含まれるので `model` で選択）では `thinking_not_found` を返します。Gemini のオン／オフ項目（拡張思考など）は `thinking` で**オン**にするだけで、すでにオンなら触りません。
- Codex プラグイン：refresh 時に ChatGPT・Claude・Gemini ではモデルを一つずつ切り替え、各モデル固有の思考の深さを読み取ります（遅いのは refresh のときだけ）。Web 側に二段階以上ある（ChatGPT のスライダー、Claude の努力レベル）モデルは Codex の reasoning 選択肢として宣言され、値は Web のラベルそのままで、送信前に Web 側で設定されます。トグルのみ（Gemini）や設定なし（Grok）のモデルは単一の `medium` のままで、無視されます。他のホストプラグインはまだ思考の深さを渡しません。
- HTTP エンドポイントには認証がありません。既定では `127.0.0.1` のみにバインドします。`0.0.0.0` で公開すると、同じネットワークの誰でもあなたのチャットセッションを操作できます。信頼できるネットワークでのみ使用してください。
- サーバー自体はパスワード・Cookie・トークンを読み書きしません。ログインは必ずご自身の手動操作によるものです。
- プロンプトと回答は選択したサービスを経由します（そのサービスのデータポリシーが適用されます）。
