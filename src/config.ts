/**
 * WebChatMCP.js — 單一事實來源（single source of truth）。
 *
 * 本檔集中所有可調常數：應用名稱、瀏覽器設定、ChatGPT 介面選擇器與時間參數。
 * `tools/gen-design.mjs` 由本檔自動產生 `DESIGN.md`，禁止手改 DESIGN.md。
 * 其他程式碼不得寫死本檔已定義的常數（選擇器與時間參數一律引用此處）。
 */

/** 應用基本識別 */
export const APP = {
  name: "webchatmcp.js",
  program: "WebChatMCP.js",
  version: "1.0.0",
  website: "https://webchatmcp.js-package.xyz",
  repository: "https://github.com/JS-PACKAGE/WebChatMCP.js",
  license: "Apache-2.0",
} as const;

/** 內建瀏覽器與持久化設定 */
export const BROWSER = {
  /** playwright 啟動通道：chromium（內建）｜chrome｜msedge */
  channel: process.env.WEBCHATMCP_CHANNEL ?? "chromium",
  /** 預設可視（登入需人工操作）；WEBCHATMCP_HEADLESS=1 時無頭 */
  headlessDefault: process.env.WEBCHATMCP_HEADLESS === "1",
  /** 登入 profile 持久化目錄（cookies／localStorage 保留於此） */
  profileDir: process.env.WEBCHATMCP_PROFILE_DIR ?? "~/.webchatmcp/profile",
  viewport: { width: 1280, height: 800 },
  /** 環境變數名稱（文件與錯誤訊息引用） */
  env: {
    profileDir: "WEBCHATMCP_PROFILE_DIR",
    channel: "WEBCHATMCP_CHANNEL",
    headless: "WEBCHATMCP_HEADLESS",
    answerTimeout: "WEBCHATMCP_ANSWER_TIMEOUT_MS",
  },
} as const;

/** ChatGPT 網址與 DOM 契約（UI 變動時只改這裡） */
export const CHATGPT = {
  baseUrl: "https://chatgpt.com",
  /** 每次呼叫都以此網址開啟全新的臨時（無痕）聊天 */
  temporaryChatUrl: "https://chatgpt.com/?temporary-chat=true",
  selectors: {
    composer: "#prompt-textarea",
    composerAlt: 'div[contenteditable="true"][data-id]',
    sendButton: 'button[data-testid="send-button"]',
    sendButtonAlt: 'button[aria-label*="Send"]',
    stopButton: 'button[data-testid="stop-button"]',
    assistantMessage: '[data-message-author-role="assistant"]',
    userMessage: '[data-message-author-role="user"]',
    loginButton: 'button[data-testid="login-button"]',
    modelSwitcher: 'button[data-testid="model-switcher-dropdown-button"]',
    modelSwitcherAlt: 'button[data-testid="model-switcher"]',
    modelMenuItem: '[role="menuitemradio"]',
    modelMenuItemAlt: '[role="menuitem"]',
  },
  /** 臨時聊天模式的畫面指標字（任一出現即判定為臨時聊天） */
  temporaryChatIndicators: ["Temporary chat", "臨時聊天", "临时聊天", "一時的なチャット"],
  /** 登入牆的畫面指標字 */
  loggedOutIndicators: ["Log in", "Sign up", "登入", "注册", "登録"],
} as const;

/** 連線設定：stdio（MCP 用戶端直啟）＋ HTTP（開 port 讓客戶端直接連線，兩者同時啟用） */
export const SERVER = {
  /** HTTP 監聽 port（預設 8321；改此值或設 WEBCHATMCP_PORT 覆蓋；設 0 停用 HTTP） */
  httpPort: Number(process.env.WEBCHATMCP_PORT ?? 8321),
  /** 監聽位址：預設 127.0.0.1（僅本機）；要讓區網連線設 WEBCHATMCP_HOST=0.0.0.0（無認證，慎用） */
  httpHost: process.env.WEBCHATMCP_HOST ?? "127.0.0.1",
  /** MCP endpoint 路徑（Streamable HTTP） */
  httpPath: "/mcp",
  env: {
    port: "WEBCHATMCP_PORT",
    host: "WEBCHATMCP_HOST",
  },
} as const;

/** 時間參數（毫秒） */
export const TIMEOUTS = {
  /** 導航至 chatgpt.com 的上限 */
  navigationMs: 45_000,
  /** webchat_login 等待人工登入的預設上限 */
  loginWaitMs: 180_000,
  /** webchat_ask 等待回覆完成的預設上限（可用環境變數覆蓋） */
  answerMs: Number(process.env.WEBCHATMCP_ANSWER_TIMEOUT_MS ?? 120_000),
  /** 回覆文字穩定判定：連續 N 次間隔取樣不變且無停止按鈕 */
  stableChecks: 3,
  stableIntervalMs: 1_500,
  /** 登入狀態輪詢間隔 */
  loginPollMs: 2_000,
} as const;
