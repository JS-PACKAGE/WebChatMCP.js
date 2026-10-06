# WebChatMCP.js DESIGN — 常數唯一來源

> 本檔由 `node tools/gen-design.mjs` 從 `src/config.ts` 自動產生，禁止手改。
> 常數衝突以本檔為準（來源即 `src/config.ts`）；流程與架構衝突以 `AGENTS.md` 為準。

## 1. 應用常數

| `name` | `webchatmcp.js` |
| `program` | `WebChatMCP.js` |
| `version` | `1.0.0` |
| `website` | [https://webchatmcp.js-package.xyz](https://webchatmcp.js-package.xyz) |
| `repository` | [https://github.com/JS-PACKAGE/WebChatMCP.js](https://github.com/JS-PACKAGE/WebChatMCP.js) |
| `license` | `Apache-2.0` |

## 2. 瀏覽器與持久化設定

| `BROWSER.channel` | `chromium`（`chromium` 內建｜`chrome`｜`msedge`） |
| `BROWSER.headlessDefault` | `false` |
| `BROWSER.profileDir` | `~/.webchatmcp/profile`（登入狀態持久化目錄） |
| `BROWSER.viewport` | `1280×800` |

### 2.1 環境變數

| `WEBCHATMCP_PROFILE_DIR` | 覆蓋 profile 目錄（預設 `~/.webchatmcp/profile`） |
| `WEBCHATMCP_CHANNEL` | 覆蓋瀏覽器通道（預設 `chromium`） |
| `WEBCHATMCP_HEADLESS` | 設為 `1` 時無頭啟動（登入仍需可視，建議不設） |
| `WEBCHATMCP_ANSWER_TIMEOUT_MS` | 覆蓋等待回覆上限（預設 `120000` ms） |

## 3. ChatGPT 介面契約

| `CHATGPT.baseUrl` | `https://chatgpt.com` |
| `CHATGPT.temporaryChatUrl` | `https://chatgpt.com/?temporary-chat=true` |

### 3.1 DOM 選擇器（UI 變動時只改 src/config.ts）

| `selectors.composer` | `#prompt-textarea` |
| `selectors.composerAlt` | `div[contenteditable="true"][data-id]` |
| `selectors.sendButton` | `button[data-testid="send-button"]` |
| `selectors.sendButtonAlt` | `button[aria-label*="Send"]` |
| `selectors.stopButton` | `button[data-testid="stop-button"]` |
| `selectors.assistantMessage` | `[data-message-author-role="assistant"]` |
| `selectors.userMessage` | `[data-message-author-role="user"]` |
| `selectors.loginButton` | `button[data-testid="login-button"]` |

### 3.2 畫面指標字

| `temporaryChatIndicators` | `Temporary chat`、`臨時聊天`、`临时聊天`、`一時的なチャット` |
| `loggedOutIndicators` | `Log in`、`Sign up`、`登入`、`注册`、`登録` |

## 4. 連線設定（stdio ＋ Streamable HTTP 同時啟用）

| `SERVER.httpPort` | `8321`（設 `0` 停用 HTTP） |
| `SERVER.httpHost` | `127.0.0.1`（`127.0.0.1` 僅本機；`0.0.0.0` 開放區網，無認證慎用） |
| `SERVER.httpPath` | `/mcp` |
| `endpoint` | [http://127.0.0.1:8321/mcp](http://127.0.0.1:8321/mcp) |

### 4.1 環境變數（連線）

| `WEBCHATMCP_PORT` | 覆蓋 HTTP port（預設 `8321`） |
| `WEBCHATMCP_HOST` | 覆蓋監聽位址（預設 `127.0.0.1`） |

## 5. 時間參數

| `TIMEOUTS.navigationMs` | `45000` |
| `TIMEOUTS.loginWaitMs` | `180000` |
| `TIMEOUTS.answerMs` | `120000` |
| `TIMEOUTS.stableChecks` | 回覆文字連續 `3` 次取樣不變且無停止按鈕即判定完成 |
| `TIMEOUTS.stableIntervalMs` | `1500` |
| `TIMEOUTS.loginPollMs` | `2000` |
