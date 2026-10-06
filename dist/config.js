/**
 * WebChatMCP.js — 單一事實來源（single source of truth）。
 *
 * 本檔集中所有可調常數：應用名稱、瀏覽器設定、ChatGPT 介面選擇器與時間參數。
 * `tools/gen-design.mjs` 由本檔自動產生 `DESIGN.md`，禁止手改 DESIGN.md。
 * 其他程式碼不得寫死本檔已定義的常數（選擇器與時間參數一律引用此處）。
 */
import { fileURLToPath } from "node:url";
/** 應用基本識別 */
export const APP = {
    name: "webchatmcp.js",
    program: "WebChatMCP.js",
    version: "1.6.1",
    website: "https://webchatmcp.js-package.xyz",
    repository: "https://github.com/JS-PACKAGE/WebChatMCP.js",
    license: "Apache-2.0",
};
/** 內建瀏覽器與持久化設定 */
export const BROWSER = {
    /** playwright 啟動通道：chromium（內建）｜chrome｜msedge */
    channel: process.env.WEBCHATMCP_CHANNEL ?? "chromium",
    /** 預設無頭；僅 webchat_login 在未登入時暫時顯示瀏覽器供人工登入。WEBCHATMCP_HEADLESS=0 時一律可視 */
    headlessDefault: process.env.WEBCHATMCP_HEADLESS !== "0",
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
};
/** 內建的網頁聊天服務；外掛在啟動時另外註冊到 PROVIDERS（見 src/plugins.ts） */
export const PROVIDER_IDS = ["chatgpt", "claude", "grok", "gemini"];
export const DEFAULT_PROVIDER = "chatgpt";
const CHAT_STOP = 'button[aria-label*="停止"], button[aria-label*="Stop" i]';
const MODEL_BUTTON_BY_LABEL = 'button[aria-label*="模型"], button[aria-label*="model" i]';
export const PROVIDERS = {
    chatgpt: {
        label: "ChatGPT",
        menu: "chatgpt",
        baseUrl: "https://chatgpt.com",
        askUrl: "https://chatgpt.com/?temporary-chat=true",
        privateMode: "url",
        guest: true,
        domains: ["chatgpt.com", "openai.com"],
        loginUrlPattern: "/auth/",
        selectors: {
            /** #prompt-textarea（舊版）或現行 UI 無 id 的 ProseMirror 文字框（role=textbox） */
            composer: '#prompt-textarea, textarea#mobile-composer-prompt, div[contenteditable="true"][role="textbox"]',
            sendButton: 'button[data-testid="send-button"], form button[type="submit"]:not([disabled])',
            stopButton: `button[data-testid="stop-button"], ${CHAT_STOP}`,
            /** 舊版 data-message-author-role；現行 UI 以 Markdown 根節點的 data-markdown-text-style 標示助理回覆 */
            assistantMessage: '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"], [data-assistant-markdown]',
            loginButton: 'button[data-testid="login-button"], a[href*="/auth/login"], button:text-is("登入"), button:text-is("Log in"), button:text-is("ログイン")',
            modelSwitcher: `button[data-testid="model-switcher-dropdown-button"], ${MODEL_BUTTON_BY_LABEL}`,
            privateEnter: null,
            /**
             * 臨時聊天啟用中的頁首按鈕：新對話頁為「關閉暫存對話」（未啟用時為「開啟…」，故只比對「關閉」語意），
             * 對話進行中改為「Save chat」按鈕（僅臨時聊天才有）。
             */
            privateActive: 'button[aria-label*="關閉暫存對話"], button[aria-label*="关闭临时"], button[aria-label*="Turn off temporary" i], button[aria-label*="一時チャットをオフ"], button:text-is("Save chat"), button[aria-label="Save chat"]',
            dismiss: [],
            blocking: null,
        },
        privateIndicators: ["Temporary chat", "臨時聊天", "临时聊天", "一時的なチャット"],
        loggedOutIndicators: ["Log in", "Sign up", "登入", "注册", "登録"],
        thinkingMenuItem: null,
        moreModelsMenuItem: null,
    },
    claude: {
        label: "Claude",
        menu: "radio",
        baseUrl: "https://claude.ai/new",
        askUrl: "https://claude.ai/new?incognito=",
        privateMode: "url",
        guest: false,
        domains: ["claude.ai", "claude.com", "anthropic.com"],
        loginUrlPattern: "/login",
        selectors: {
            composer: '[data-testid="chat-input"], div[contenteditable="true"][role="textbox"]',
            sendButton: 'button[data-testid="chat-input-send"]',
            stopButton: CHAT_STOP,
            assistantMessage: ".font-claude-response",
            loginButton: '[data-testid="login-with-google"], [data-testid="continue"]',
            modelSwitcher: 'button[data-testid="model-selector-dropdown"]',
            privateEnter: null,
            /** 無痕對話頁首的「結束無痕模式」按鈕 */
            privateActive: 'button[aria-label*="無痕"], button[aria-label*="ncognito" i]',
            dismiss: [],
            blocking: null,
        },
        privateIndicators: [],
        loggedOutIndicators: [],
        thinkingMenuItem: "努力程度|Effort",
        /** 主選單只列出部分模型，其餘收在這個子選單（目前選的模型會被移進主選單） */
        moreModelsMenuItem: "更多模型|More models",
    },
    grok: {
        label: "Grok",
        menu: "radio",
        baseUrl: "https://grok.com",
        askUrl: "https://grok.com/c#private",
        privateMode: "url",
        guest: false,
        domains: ["grok.com", "x.ai"],
        loginUrlPattern: "/sign-in",
        selectors: {
            composer: 'div[contenteditable="true"][role="textbox"]',
            sendButton: 'button[data-testid="chat-submit"]',
            stopButton: CHAT_STOP,
            /** 使用者與助理的訊息容器都有 id=response-*；助理那側為 items-start（使用者為 items-end） */
            assistantMessage: '[id^="response-"].items-start',
            loginButton: 'a[href*="/sign-in"]',
            modelSwitcher: MODEL_BUTTON_BY_LABEL,
            privateEnter: null,
            privateActive: null,
            dismiss: [],
            /** 首次送出會跳出「請確認您的年齡」，須由使用者本人填寫 */
            blocking: 'div[role="dialog"]:has-text("年齡"), div[role="dialog"]:has-text("your age" i), div[role="dialog"]:has-text("birth year" i)',
        },
        privateIndicators: ["私密模式", "Private mode", "Private chat", "此聊天將不會顯示在您的歷史記錄中"],
        loggedOutIndicators: [],
        thinkingMenuItem: null,
        moreModelsMenuItem: null,
    },
    gemini: {
        label: "Gemini",
        menu: "gemini",
        baseUrl: "https://gemini.google.com/app",
        askUrl: "https://gemini.google.com/app",
        privateMode: "button",
        guest: true,
        domains: ["google.com"],
        loginUrlPattern: "accounts\\.google\\.com",
        selectors: {
            composer: 'rich-textarea div[role="textbox"], div[role="textbox"]',
            sendButton: 'button[aria-label*="傳送"], button[aria-label*="Send message" i]',
            stopButton: CHAT_STOP,
            assistantMessage: "model-response message-content",
            loginButton: 'button:text-is("登入"), a:text-is("登入"), button:text-is("Sign in"), a:text-is("Sign in"), a[href*="accounts.google.com/ServiceLogin"]',
            modelSwitcher: 'button[data-test-id="bard-mode-menu-button"]',
            /** 網址無法直接進入臨時對話，須載入後點頁首的「臨時對話」按鈕（訪客沒有此按鈕） */
            privateEnter: 'button[aria-label*="臨時對話"], button[aria-label*="Temporary chat" i], button[aria-label*="临时对话"]',
            /** 臨時對話啟用時，空白畫面會出現「臨時對話」說明卡片 */
            privateActive: ".temporary-chat-card",
            dismiss: [
                'button:has-text("暫時不要")',
                'button:has-text("我知道了")',
                'button:has-text("Not now")',
                'button:has-text("Got it")',
            ],
            blocking: null,
        },
        privateIndicators: [],
        loggedOutIndicators: [],
        thinkingMenuItem: null,
        moreModelsMenuItem: null,
    },
};
/** 目前已註冊的服務代號（內建＋已載入的外掛）。 */
export function providerIds() {
    return Object.keys(PROVIDERS);
}
/** 外掛：用 JSON 檔新增其他聊天服務（格式見 plugins/README.md） */
export const PLUGINS = {
    /** 倉庫內的 plugins/ 目錄（檔名以 _ 開頭的範本不會載入） */
    bundledDir: fileURLToPath(new URL("../plugins", import.meta.url)),
    /** 使用者外掛目錄；WEBCHATMCP_PLUGINS_DIR 可改（多個以系統的路徑分隔符號分開） */
    userDirs: process.env.WEBCHATMCP_PLUGINS_DIR ?? "~/.webchatmcp/plugins",
    /** 外掛 id 的格式；內建服務 id 不可被覆蓋 */
    idPattern: "^[a-z][a-z0-9-]{1,30}$",
    env: { dirs: "WEBCHATMCP_PLUGINS_DIR" },
};
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
};
/**
 * Codex 橋接：讓 Codex（OpenAI Responses 協定）把 `webchat/...` 模型送進網頁聊天，其他模型原樣轉送官方後端。
 * Codex 端只需把 `openai_base_url` 指向 `http://127.0.0.1:<port>/v1`（由 plugins/codex 的安裝腳本寫入）。
 */
export const CODEX = {
    /** 橋接路徑前綴（相當於 Codex 的 openai_base_url 路徑部分） */
    path: "/v1",
    /** 網頁模型的 slug 前綴：`webchat/<服務>` 或 `webchat/<服務>/<模型標籤>` */
    slugPrefix: "webchat",
    /** 顯示名稱的尾綴 */
    nameSuffix: "(WEB)",
    /** 非網頁模型的上游：有 chatgpt-account-id 標頭（ChatGPT 登入）走 chatgpt；否則走 api（API key） */
    upstream: {
        chatgpt: "https://chatgpt.com/backend-api/codex",
        api: "https://api.openai.com/v1",
    },
    /** 模型清單快取（webchat_models 與 POST /v1/webchat/refresh 會更新） */
    modelsFile: process.env.WEBCHATMCP_CODEX_MODELS ?? "~/.webchatmcp/codex-models.json",
    /** 網頁模型在 Codex 選單中的排序（大於官方模型，排在後面） */
    priority: 1000,
    /** 回報給 Codex 的上下文長度（保守值；實際上限取決於各網站） */
    contextWindow: 128_000,
    /** 等待網頁回覆時的 SSE 保活註解間隔 */
    keepAliveMs: 15_000,
    env: {
        bridge: "WEBCHATMCP_CODEX_BRIDGE",
        upstream: "WEBCHATMCP_CODEX_UPSTREAM",
        modelsFile: "WEBCHATMCP_CODEX_MODELS",
    },
    /** 設為 `0` 停用橋接（HTTP 仍提供 MCP） */
    enabled: process.env.WEBCHATMCP_CODEX_BRIDGE !== "0",
    /** 覆蓋上游網址（測試或自架代理用） */
    upstreamOverride: process.env.WEBCHATMCP_CODEX_UPSTREAM,
};
/**
 * Claude 橋接：讓 Claude Code（Anthropic Messages 協定）把 `webchat/...` 模型送進網頁聊天，其他模型原樣轉送官方後端。
 * Claude Code 端把 `ANTHROPIC_BASE_URL` 指向 `http://127.0.0.1:<port>/claude`、並用 `modelPicker` 列出模型（由 plugins/claude 的安裝腳本寫入）。
 */
export const CLAUDE = {
    /** 橋接路徑前綴（與 Codex 的 /v1 分開，兩個橋接可同時存在） */
    path: "/claude",
    /** 網頁模型的 id 前綴：`webchat/<服務>` 或 `webchat/<服務>/<模型標籤>` */
    slugPrefix: "webchat",
    /** 顯示名稱的尾綴 */
    nameSuffix: "(WEB)",
    /** 非網頁模型的上游（官方 Anthropic API；Claude 登入與 API key 都走這裡） */
    upstream: "https://api.anthropic.com",
    /** 等待網頁回覆時的 SSE 保活間隔 */
    keepAliveMs: 15_000,
    env: {
        bridge: "WEBCHATMCP_CLAUDE_BRIDGE",
        upstream: "WEBCHATMCP_CLAUDE_UPSTREAM",
    },
    /** 設為 `0` 停用橋接（HTTP 仍提供 MCP） */
    enabled: process.env.WEBCHATMCP_CLAUDE_BRIDGE !== "0",
    /** 覆蓋上游網址（測試或自架代理用） */
    upstreamOverride: process.env.WEBCHATMCP_CLAUDE_UPSTREAM,
};
/**
 * Grok 橋接：Grok Build（xAI 的 grok CLI）的自訂模型 `[model.<id>]` 以 `base_url` 指向這裡，
 * 用 chat_completions 協定把 `webchat/...` 模型送進網頁聊天。只有網頁模型走橋接，官方模型完全不經過本機。
 * 設定由 plugins/grok 的安裝腳本寫入 ~/.grok/config.toml。
 */
export const GROK = {
    /** 橋接路徑前綴（Grok 會在其後加 /chat/completions） */
    path: "/grok",
    /** 網頁模型的 id 前綴：`webchat/<服務>` 或 `webchat/<服務>/<模型標籤>` */
    slugPrefix: "webchat",
    /** 顯示名稱的尾綴 */
    nameSuffix: "(WEB)",
    /** 回報給 Grok 的上下文長度（保守值；實際上限取決於各網站） */
    contextWindow: 128_000,
    /** 等待網頁回覆時的 SSE 保活間隔 */
    keepAliveMs: 15_000,
    env: { bridge: "WEBCHATMCP_GROK_BRIDGE" },
    /** 設為 `0` 停用橋接（HTTP 仍提供 MCP） */
    enabled: process.env.WEBCHATMCP_GROK_BRIDGE !== "0",
};
/**
 * Hermes 橋接：Hermes Agent 的模型提供商外掛（plugins/hermes）以 OpenAI chat_completions 協定連到這裡，
 * 提供商名稱是 `webchat`；模型 id 是 `<服務>` 或 `<服務>/<模型標籤>`。
 */
export const HERMES = {
    /** 橋接路徑前綴（Hermes 會在其後加 /chat/completions、/models） */
    path: "/hermes",
    /** 模型清單快取（POST /hermes/webchat/refresh 會更新） */
    modelsFile: process.env.WEBCHATMCP_HERMES_MODELS ?? "~/.webchatmcp/hermes-models.json",
    /** 回報給 Hermes 的上下文長度（保守值；實際上限取決於各網站） */
    contextWindow: 128_000,
    /** 等待網頁回覆時的 SSE 保活間隔 */
    keepAliveMs: 15_000,
    env: { bridge: "WEBCHATMCP_HERMES_BRIDGE", modelsFile: "WEBCHATMCP_HERMES_MODELS" },
    /** 設為 `0` 停用橋接（HTTP 仍提供 MCP） */
    enabled: process.env.WEBCHATMCP_HERMES_BRIDGE !== "0",
};
/** 時間參數（毫秒） */
export const TIMEOUTS = {
    /** 導航至 chatgpt.com 的上限 */
    navigationMs: 45_000,
    /** 無頭過不了驗證頁時，暫時改用可視瀏覽器等待放行的上限 */
    challengeMs: 90_000,
    /** 等待模型選單按鈕完成 hydration 的上限 */
    modelSwitcherMs: 10_000,
    /** webchat_login 等待人工登入的預設上限 */
    loginWaitMs: 180_000,
    /** webchat_ask 等待回覆完成的預設上限（可用環境變數覆蓋） */
    answerMs: Number(process.env.WEBCHATMCP_ANSWER_TIMEOUT_MS ?? 120_000),
    /** 回覆文字穩定判定：連續 N 次間隔取樣不變且無停止按鈕（從沒見過停止按鈕時用此次數） */
    stableChecks: 8,
    /** 見過停止按鈕後它消失，再連續 N 次取樣不變即視為完成 */
    stableChecksAfterStop: 3,
    stableIntervalMs: 150,
    /** 導航完成後等待頁面開始渲染的時間 */
    postNavigationMs: 300,
    /** 輸入提示後等送出按鈕出現的上限 */
    sendButtonMs: 1_500,
    /** 等待第一則助理回覆出現的輪詢間隔 */
    responsePollMs: 150,
    /** 登入狀態輪詢間隔 */
    loginPollMs: 2_000,
};
