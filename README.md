# WebChatMCP.js

**Website:** https://webchatmcp.js-package.xyz · **Source:** https://github.com/JS-PACKAGE/WebChatMCP.js · **License:** Apache-2.0

[English](#english) · [繁體中文](#繁體中文) · [日本語](#日本語)

An MCP server with a built-in browser. Log into ChatGPT once in the visible browser; afterwards every call sends your prompt through a ChatGPT **temporary (incognito) chat** and returns the answer — nothing is written to the account's chat history.

---

## English

### What is it?
WebChatMCP.js is a local MCP (Model Context Protocol) server. It embeds a persistent Chromium browser (Playwright) so an MCP client can drive ChatGPT's web interface: one manual login, then prompts flow through temporary chats and answers come back as tool results.

### Features
- Built-in browser with persistent profile — the ChatGPT login survives restarts.
- Every `webchat_ask` opens a brand-new temporary (incognito) chat: no history, not used for training.
- The answer text is captured from ChatGPT's own response bubble and returned to the MCP client.
- `webchat_models` lists the models your account can use (live from the model switcher); `webchat_ask` can switch per prompt.
- Honest state probing: login and temporary-chat detection return `true / false / unknown`, never guesses.
- Clear error codes (`logged_out`, `composer_not_found`, `no_response`, …) instead of silent failures.

### Requirements
- Node.js ≥ 22
- A ChatGPT account (free or paid)
- First-run login needs a visible display (no headless login)

### Install
```bash
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git
cd WebChatMCP.js
npm install
npx playwright install chromium   # one-time: the built-in browser
npm run build
```

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
1. Call `webchat_login` — a browser window opens at ChatGPT. Log in manually.
2. Wait for the tool to report `loggedIn: true` (or call `webchat_status` later).
3. Call `webchat_ask` with your prompt; the answer text comes back as the tool result.

If login opens a new ChatGPT tab, the server follows that tab. It checks visible login/composer indicators; fast replies are captured even when they appear immediately on send. After updating or rebuilding, restart the MCP server to load the new code (the saved profile is retained).

### Tools
| Tool | Input | Output |
|---|---|---|
| `webchat_login` | `timeout_seconds?` | login status JSON |
| `webchat_ask` | `prompt`, `model?`, `timeout_seconds?` | ChatGPT's answer text |
| `webchat_models` | — | available model list JSON (`label`, `current`) |
| `webchat_status` | — | browser / login / temporary-chat state JSON |
| `webchat_close` | — | close the built-in browser (login stays saved) |

### Environment variables
| Variable | Meaning |
|---|---|
| `WEBCHATMCP_PROFILE_DIR` | Browser profile directory (default `~/.webchatmcp/profile`) |
| `WEBCHATMCP_CHANNEL` | `chromium` (default) / `chrome` / `msedge` |
| `WEBCHATMCP_HEADLESS` | `1` runs headless (first login still needs a visible browser) |
| `WEBCHATMCP_ANSWER_TIMEOUT_MS` | Answer wait limit (default `120000`) |
| `WEBCHATMCP_PORT` | HTTP port (default `8321`; `0` disables HTTP) |
| `WEBCHATMCP_HOST` | HTTP bind address (default `127.0.0.1`; `0.0.0.0` exposes to LAN — no auth, use with care) |

### Notes
- Cloudflare may challenge fresh automated browsers. The default visible mode lets you (or the challenge) pass manually; headless mode is not recommended for first login.
- The HTTP endpoint has **no authentication**. It binds to `127.0.0.1` by default; exposing it (`0.0.0.0`) lets anyone on your network drive your ChatGPT session — only do this on trusted networks.
- The server never reads or stores passwords, cookies or tokens itself — login happens only through your own manual typing in the browser.
- Prompts and answers pass through ChatGPT's service: OpenAI's data usage policies apply.

---

## 繁體中文

### 這是什麼？
WebChatMCP.js 是本機 MCP（Model Context Protocol）伺服器。它內建持久化的 Chromium 瀏覽器（Playwright），讓 MCP 用戶端可以操作 ChatGPT 網頁介面：人工登入一次，之後每次呼叫把提示送進**臨時（無痕）聊天**，回覆以工具結果回傳。

### 功能
- 內建瀏覽器＋持久化 profile——ChatGPT 登入狀態重啟不失效。
- 每次 `webchat_ask` 都開啟全新的臨時聊天：不寫入帳號聊天紀錄、不用於模型訓練。
- 回覆文字直接擷取自 ChatGPT 的回應氣泡，回傳給 MCP 用戶端。
- `webchat_models` 即時列出帳號可用模型（擷取自模型選單）；`webchat_ask` 可逐題指定模型。
- 誠實探測：登入與臨時聊天判定回 `true / false / unknown`，絕不猜測。
- 明確錯誤碼（`logged_out`、`composer_not_found`、`no_response` 等），不靜默失敗。

### 需求
- Node.js ≥ 22
- ChatGPT 帳號（免費或付費）
- 首次登入需要可視畫面（不支援無頭登入）

### 安裝
```bash
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git
cd WebChatMCP.js
npm install
npx playwright install chromium   # 首次：安裝內建瀏覽器
npm run build
```

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
1. 呼叫 `webchat_login`——瀏覽器視窗開啟 ChatGPT，人工完成登入。
2. 工具回報 `loggedIn: true` 即完成（之後可隨時用 `webchat_status` 確認）。
3. 呼叫 `webchat_ask` 送出提示，回覆文字即為工具結果。

登入若開啟新的 ChatGPT 分頁，伺服器會切換至該分頁；登入判定使用可見的登入按鈕／輸入框，立即出現的快速回覆也能擷取。更新或重新 build 後，請重啟 MCP 伺服器以載入新程式碼（原有 profile 保留）。

### 工具
| 工具 | 輸入 | 輸出 |
|---|---|---|
| `webchat_login` | `timeout_seconds?` | 登入狀態 JSON |
| `webchat_ask` | `prompt`、`model?`、`timeout_seconds?` | ChatGPT 回覆文字 |
| `webchat_models` | — | 可用模型清單 JSON（`label`、`current`） |
| `webchat_status` | — | 瀏覽器／登入／臨時聊天狀態 JSON |
| `webchat_close` | — | 關閉內建瀏覽器（登入狀態保留） |

### 環境變數
| 變數 | 意義 |
|---|---|
| `WEBCHATMCP_PROFILE_DIR` | 瀏覽器 profile 目錄（預設 `~/.webchatmcp/profile`） |
| `WEBCHATMCP_CHANNEL` | `chromium`（預設）／`chrome`／`msedge` |
| `WEBCHATMCP_HEADLESS` | 設 `1` 無頭啟動（首次登入仍需可視瀏覽器） |
| `WEBCHATMCP_ANSWER_TIMEOUT_MS` | 等待回覆上限（預設 `120000`） |
| `WEBCHATMCP_PORT` | HTTP port（預設 `8321`；`0` 停用 HTTP） |
| `WEBCHATMCP_HOST` | HTTP 監聽位址（預設 `127.0.0.1`；`0.0.0.0` 開放區網——無認證，慎用） |

### 注意事項
- Cloudflare 可能對全新自動化瀏覽器出驗證頁；預設可視模式可人工通過，首次登入不建議無頭。
- HTTP endpoint **無任何認證**，預設只綁 `127.0.0.1`；開放（`0.0.0.0`）等同讓同網路任何人操作你的 ChatGPT 會話，只建議在可信網路上使用。
- 伺服器本身不讀、不存任何密碼、cookie 或 token——登入只透過你自己在瀏覽器中操作。
- 提示與回覆會經過 ChatGPT 服務，適用 OpenAI 的資料使用政策。

---

## 日本語

### これは何？
WebChatMCP.js はローカルの MCP（Model Context Protocol）サーバーです。永続化された Chromium ブラウザ（Playwright）を内蔵し、MCP クライアントから ChatGPT の Web 画面を操作します。手動ログインは一度だけ、以降の呼び出しはすべて**一時チャット（シークレット）**にプロンプトを送り、回答をツール結果として返します。

### 機能
- 内蔵ブラウザ＋永続プロファイル——ChatGPT のログインは再起動後も保持。
- `webchat_ask` のたびに新しい一時チャットを開く：履歴に残らず、学習にも使われません。
- 回答テキストは ChatGPT の応答バブルから直接取得して返却。
- `webchat_models` でアカウントで使えるモデルを一覧化（モデルスイッチャーから取得）；`webchat_ask` でプロンプトごとにモデル指定が可能。
- 正直な状態判定：ログイン／一時チャットの検出は `true / false / unknown`、推測しません。
- 明確なエラーコード（`logged_out`、`composer_not_found`、`no_response` など）。

### 要件
- Node.js ≥ 22
- ChatGPT アカウント（無料／有料）
- 初回ログインには表示可能な画面が必要（ヘッドレス非対応）

### インストール
```bash
git clone https://github.com/JS-PACKAGE/WebChatMCP.js.git
cd WebChatMCP.js
npm install
npx playwright install chromium   # 初回のみ
npm run build
```

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
1. `webchat_login` を呼ぶ——ブラウザが ChatGPT を開くので手動でログイン。
2. ツールが `loggedIn: true` を返したら完了（`webchat_status` でいつでも確認可能）。
3. `webchat_ask` でプロンプトを送り、回答テキストを受け取る。

ログインで新しい ChatGPT タブが開いた場合、サーバーはそのタブを使用します。表示中のログインボタン／入力欄で状態を判定し、即座に表示される回答も取得できます。更新・ビルド後は MCP サーバーを再起動してください（保存済みプロファイルは保持されます）。

### ツール
| ツール | 入力 | 出力 |
|---|---|---|
| `webchat_login` | `timeout_seconds?` | ログイン状態 JSON |
| `webchat_ask` | `prompt`、`model?`、`timeout_seconds?` | ChatGPT の回答テキスト |
| `webchat_models` | — | 利用可能モデル一覧 JSON（`label`、`current`） |
| `webchat_status` | — | ブラウザ／ログイン／一時チャット状態 JSON |
| `webchat_close` | — | 内蔵ブラウザを終了（ログインは保持） |

### 環境変数
| 変数 | 意味 |
|---|---|
| `WEBCHATMCP_PROFILE_DIR` | ブラウザプロファイルの場所（既定 `~/.webchatmcp/profile`） |
| `WEBCHATMCP_CHANNEL` | `chromium`（既定）／`chrome`／`msedge` |
| `WEBCHATMCP_HEADLESS` | `1` でヘッドレス起動（初回ログインは画面が必要） |
| `WEBCHATMCP_ANSWER_TIMEOUT_MS` | 回答待ち上限（既定 `120000`） |
| `WEBCHATMCP_PORT` | HTTP ポート（既定 `8321`；`0` で HTTP 無効） |
| `WEBCHATMCP_HOST` | HTTP バインド先（既定 `127.0.0.1`；`0.0.0.0` で LAN 開放——認証なし、注意） |

### 注意
- 新規の自動化ブラウザには Cloudflare の検証がかかることがあります。既定の表示モードなら手動で通過でき、初回ログインにヘッドレスは非推奨です。
- サーバー自体はパスワード・Cookie・トークンを読み書きしません。ログインは必ずご自身の手動操作によるものです。
- プロンプトと回答は ChatGPT のサービスを経由します（OpenAI のデータポリシーが適用されます）。
