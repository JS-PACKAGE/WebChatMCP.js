# WebChatMCP.js DESIGN — 常數唯一來源

> 本檔由 `node tools/gen-design.mjs` 從 `src/config.ts` 自動產生，禁止手改。
> 常數衝突以本檔為準（來源即 `src/config.ts`）；流程與架構衝突以 `AGENTS.md` 為準。

## 1. 應用常數

| `name` | `webchatmcp.js` |
| `program` | `WebChatMCP.js` |
| `version` | `1.2.0` |
| `website` | [https://webchatmcp.js-package.xyz](https://webchatmcp.js-package.xyz) |
| `repository` | [https://github.com/JS-PACKAGE/WebChatMCP.js](https://github.com/JS-PACKAGE/WebChatMCP.js) |
| `license` | `Apache-2.0` |

## 2. 瀏覽器與持久化設定

| `BROWSER.channel` | `chromium`（`chromium` 內建｜`chrome`｜`msedge`） |
| `BROWSER.headlessDefault` | `true` |
| `BROWSER.profileDir` | `~/.webchatmcp/profile`（登入狀態持久化目錄） |
| `BROWSER.viewport` | `1280×800` |

### 2.1 環境變數

| `WEBCHATMCP_PROFILE_DIR` | 覆蓋 profile 目錄（預設 `~/.webchatmcp/profile`） |
| `WEBCHATMCP_CHANNEL` | 覆蓋瀏覽器通道（預設 `chromium`） |
| `WEBCHATMCP_HEADLESS` | 預設無頭（僅人工登入時才顯示瀏覽器）；設為 `0` 時一律可視 |
| `WEBCHATMCP_ANSWER_TIMEOUT_MS` | 覆蓋等待回覆上限（預設 `120000` ms） |

## 3. 服務介面契約（chatgpt｜claude｜grok｜gemini）

每個服務各一節；UI 變動時只改 `src/config.ts` 的 `PROVIDERS`。預設服務：`chatgpt`。

### 3.1 ChatGPT（`chatgpt`）

| `PROVIDERS.chatgpt.baseUrl` | `https://chatgpt.com` |
| `PROVIDERS.chatgpt.askUrl` | `https://chatgpt.com/?temporary-chat=true`（進入無痕方式：`url`） |
| `PROVIDERS.chatgpt.guest` | `true`（未登入也能送出提示） |
| `PROVIDERS.chatgpt.domains` | `chatgpt.com`、`openai.com`（webchat_logout 清除 cookie 的網域） |
| `PROVIDERS.chatgpt.loginUrlPattern` | `/auth/` |
| `PROVIDERS.chatgpt.thinkingMenuItem` | （無） |
| `PROVIDERS.chatgpt.moreModelsMenuItem` | （無） |
| `PROVIDERS.chatgpt.selectors.composer` | `#prompt-textarea, textarea#mobile-composer-prompt, div[contenteditable="true"][role="textbox"]` |
| `PROVIDERS.chatgpt.selectors.sendButton` | `button[data-testid="send-button"], form button[type="submit"]:not([disabled])` |
| `PROVIDERS.chatgpt.selectors.stopButton` | `button[data-testid="stop-button"], button[aria-label*="停止"], button[aria-label*="Stop" i]` |
| `PROVIDERS.chatgpt.selectors.assistantMessage` | `[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"], [data-assistant-markdown]` |
| `PROVIDERS.chatgpt.selectors.loginButton` | `button[data-testid="login-button"], a[href*="/auth/login"], button:text-is("登入"), button:text-is("Log in"), button:text-is("ログイン")` |
| `PROVIDERS.chatgpt.selectors.modelSwitcher` | `button[data-testid="model-switcher-dropdown-button"], button[aria-label*="模型"], button[aria-label*="model" i]` |
| `PROVIDERS.chatgpt.selectors.privateEnter` | （無） |
| `PROVIDERS.chatgpt.selectors.privateActive` | `button[aria-label*="關閉暫存對話"], button[aria-label*="关闭临时"], button[aria-label*="Turn off temporary" i], button[aria-label*="一時チャットをオフ"], button:text-is("Save chat"), button[aria-label="Save chat"]` |
| `PROVIDERS.chatgpt.selectors.dismiss` | （無） |
| `PROVIDERS.chatgpt.selectors.blocking` | （無） |
| `PROVIDERS.chatgpt.privateIndicators` | `Temporary chat`、`臨時聊天`、`临时聊天`、`一時的なチャット` |
| `PROVIDERS.chatgpt.loggedOutIndicators` | `Log in`、`Sign up`、`登入`、`注册`、`登録` |

### 3.2 Claude（`claude`）

| `PROVIDERS.claude.baseUrl` | `https://claude.ai/new` |
| `PROVIDERS.claude.askUrl` | `https://claude.ai/new?incognito=`（進入無痕方式：`url`） |
| `PROVIDERS.claude.guest` | `false`（未登入也能送出提示） |
| `PROVIDERS.claude.domains` | `claude.ai`、`claude.com`、`anthropic.com`（webchat_logout 清除 cookie 的網域） |
| `PROVIDERS.claude.loginUrlPattern` | `/login` |
| `PROVIDERS.claude.thinkingMenuItem` | `努力程度\|Effort` |
| `PROVIDERS.claude.moreModelsMenuItem` | `更多模型\|More models` |
| `PROVIDERS.claude.selectors.composer` | `[data-testid="chat-input"], div[contenteditable="true"][role="textbox"]` |
| `PROVIDERS.claude.selectors.sendButton` | `button[data-testid="chat-input-send"]` |
| `PROVIDERS.claude.selectors.stopButton` | `button[aria-label*="停止"], button[aria-label*="Stop" i]` |
| `PROVIDERS.claude.selectors.assistantMessage` | `.font-claude-response` |
| `PROVIDERS.claude.selectors.loginButton` | `[data-testid="login-with-google"], [data-testid="continue"]` |
| `PROVIDERS.claude.selectors.modelSwitcher` | `button[data-testid="model-selector-dropdown"]` |
| `PROVIDERS.claude.selectors.privateEnter` | （無） |
| `PROVIDERS.claude.selectors.privateActive` | `button[aria-label*="無痕"], button[aria-label*="ncognito" i]` |
| `PROVIDERS.claude.selectors.dismiss` | （無） |
| `PROVIDERS.claude.selectors.blocking` | （無） |
| `PROVIDERS.claude.privateIndicators` | （無） |
| `PROVIDERS.claude.loggedOutIndicators` | （無） |

### 3.3 Grok（`grok`）

| `PROVIDERS.grok.baseUrl` | `https://grok.com` |
| `PROVIDERS.grok.askUrl` | `https://grok.com/c#private`（進入無痕方式：`url`） |
| `PROVIDERS.grok.guest` | `false`（未登入也能送出提示） |
| `PROVIDERS.grok.domains` | `grok.com`、`x.ai`（webchat_logout 清除 cookie 的網域） |
| `PROVIDERS.grok.loginUrlPattern` | `/sign-in` |
| `PROVIDERS.grok.thinkingMenuItem` | （無） |
| `PROVIDERS.grok.moreModelsMenuItem` | （無） |
| `PROVIDERS.grok.selectors.composer` | `div[contenteditable="true"][role="textbox"]` |
| `PROVIDERS.grok.selectors.sendButton` | `button[data-testid="chat-submit"]` |
| `PROVIDERS.grok.selectors.stopButton` | `button[aria-label*="停止"], button[aria-label*="Stop" i]` |
| `PROVIDERS.grok.selectors.assistantMessage` | `[id^="response-"].items-start` |
| `PROVIDERS.grok.selectors.loginButton` | `a[href*="/sign-in"]` |
| `PROVIDERS.grok.selectors.modelSwitcher` | `button[aria-label*="模型"], button[aria-label*="model" i]` |
| `PROVIDERS.grok.selectors.privateEnter` | （無） |
| `PROVIDERS.grok.selectors.privateActive` | （無） |
| `PROVIDERS.grok.selectors.dismiss` | （無） |
| `PROVIDERS.grok.selectors.blocking` | `div[role="dialog"]:has-text("年齡"), div[role="dialog"]:has-text("your age" i), div[role="dialog"]:has-text("birth year" i)` |
| `PROVIDERS.grok.privateIndicators` | `私密模式`、`Private mode`、`Private chat`、`此聊天將不會顯示在您的歷史記錄中` |
| `PROVIDERS.grok.loggedOutIndicators` | （無） |

### 3.4 Gemini（`gemini`）

| `PROVIDERS.gemini.baseUrl` | `https://gemini.google.com/app` |
| `PROVIDERS.gemini.askUrl` | `https://gemini.google.com/app`（進入無痕方式：`button`） |
| `PROVIDERS.gemini.guest` | `true`（未登入也能送出提示） |
| `PROVIDERS.gemini.domains` | `google.com`（webchat_logout 清除 cookie 的網域） |
| `PROVIDERS.gemini.loginUrlPattern` | `accounts\.google\.com` |
| `PROVIDERS.gemini.thinkingMenuItem` | （無） |
| `PROVIDERS.gemini.moreModelsMenuItem` | （無） |
| `PROVIDERS.gemini.selectors.composer` | `rich-textarea div[role="textbox"], div[role="textbox"]` |
| `PROVIDERS.gemini.selectors.sendButton` | `button[aria-label*="傳送"], button[aria-label*="Send message" i]` |
| `PROVIDERS.gemini.selectors.stopButton` | `button[aria-label*="停止"], button[aria-label*="Stop" i]` |
| `PROVIDERS.gemini.selectors.assistantMessage` | `model-response message-content` |
| `PROVIDERS.gemini.selectors.loginButton` | `button:text-is("登入"), a:text-is("登入"), button:text-is("Sign in"), a:text-is("Sign in"), a[href*="accounts.google.com/ServiceLogin"]` |
| `PROVIDERS.gemini.selectors.modelSwitcher` | `button[data-test-id="bard-mode-menu-button"]` |
| `PROVIDERS.gemini.selectors.privateEnter` | `button[aria-label*="臨時對話"], button[aria-label*="Temporary chat" i], button[aria-label*="临时对话"]` |
| `PROVIDERS.gemini.selectors.privateActive` | `.temporary-chat-card` |
| `PROVIDERS.gemini.selectors.dismiss` | `button:has-text("暫時不要")`、`button:has-text("我知道了")`、`button:has-text("Not now")`、`button:has-text("Got it")` |
| `PROVIDERS.gemini.selectors.blocking` | （無） |
| `PROVIDERS.gemini.privateIndicators` | （無） |
| `PROVIDERS.gemini.loggedOutIndicators` | （無） |

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
| `TIMEOUTS.challengeMs` | `90000` |
| `TIMEOUTS.modelSwitcherMs` | `10000` |
| `TIMEOUTS.loginWaitMs` | `180000` |
| `TIMEOUTS.answerMs` | `120000` |
| `TIMEOUTS.stableChecks` | 回覆文字連續 `3` 次取樣不變且無停止按鈕即判定完成 |
| `TIMEOUTS.stableIntervalMs` | `1500` |
| `TIMEOUTS.loginPollMs` | `2000` |
