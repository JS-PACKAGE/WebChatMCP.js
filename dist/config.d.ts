/**
 * WebChatMCP.js — 單一事實來源（single source of truth）。
 *
 * 本檔集中所有可調常數：應用名稱、瀏覽器設定、ChatGPT 介面選擇器與時間參數。
 * `tools/gen-design.mjs` 由本檔自動產生 `DESIGN.md`，禁止手改 DESIGN.md。
 * 其他程式碼不得寫死本檔已定義的常數（選擇器與時間參數一律引用此處）。
 */
/** 應用基本識別 */
export declare const APP: {
    readonly name: "webchatmcp.js";
    readonly program: "WebChatMCP.js";
    readonly version: "1.0.1";
    readonly website: "https://webchatmcp.js-package.xyz";
    readonly repository: "https://github.com/JS-PACKAGE/WebChatMCP.js";
    readonly license: "Apache-2.0";
};
/** 內建瀏覽器與持久化設定 */
export declare const BROWSER: {
    /** playwright 啟動通道：chromium（內建）｜chrome｜msedge */
    readonly channel: string;
    /** 預設可視（登入需人工操作）；WEBCHATMCP_HEADLESS=1 時無頭 */
    readonly headlessDefault: boolean;
    /** 登入 profile 持久化目錄（cookies／localStorage 保留於此） */
    readonly profileDir: string;
    readonly viewport: {
        readonly width: 1280;
        readonly height: 800;
    };
    /** 環境變數名稱（文件與錯誤訊息引用） */
    readonly env: {
        readonly profileDir: "WEBCHATMCP_PROFILE_DIR";
        readonly channel: "WEBCHATMCP_CHANNEL";
        readonly headless: "WEBCHATMCP_HEADLESS";
        readonly answerTimeout: "WEBCHATMCP_ANSWER_TIMEOUT_MS";
    };
};
/** ChatGPT 網址與 DOM 契約（UI 變動時只改這裡） */
export declare const CHATGPT: {
    readonly baseUrl: "https://chatgpt.com";
    /** 每次呼叫都以此網址開啟全新的臨時（無痕）聊天 */
    readonly temporaryChatUrl: "https://chatgpt.com/?temporary-chat=true";
    readonly selectors: {
        readonly composer: "#prompt-textarea";
        /** 現行 UI：無 id／data-testid 的 ProseMirror 文字框（role=textbox） */
        readonly composerAlt: "div[contenteditable=\"true\"][role=\"textbox\"]";
        readonly sendButton: "button[data-testid=\"send-button\"]";
        /** 現行 UI：輸入框所在表單的 submit 按鈕（無文字時為 disabled） */
        readonly sendButtonAlt: "form button[type=\"submit\"]:not([disabled])";
        readonly stopButton: "button[data-testid=\"stop-button\"], button[aria-label*=\"停止\"], button[aria-label*=\"Stop\" i]";
        /** 舊版 data-message-author-role；現行 UI 以 Markdown 根節點的 data-markdown-text-style 標示助理回覆 */
        readonly assistantMessage: "[data-message-author-role=\"assistant\"], [data-markdown-text-style=\"assistant-message\"]";
        readonly userMessage: "[data-message-author-role=\"user\"]";
        readonly loginButton: "button[data-testid=\"login-button\"], a[href*=\"/auth/login\"]";
        readonly modelSwitcher: "button[data-testid=\"model-switcher-dropdown-button\"]";
        readonly modelSwitcherAlt: "button[aria-label*=\"模型\"], button[aria-label*=\"model\" i]";
        readonly modelMenuItem: "[role=\"menuitemradio\"]";
        readonly modelMenuItemAlt: "[role=\"menuitem\"]";
        /**
         * 臨時聊天啟用中的頁首按鈕：新對話頁為「關閉暫存對話」（未啟用時為「開啟…」，故只比對「關閉」語意），
         * 對話進行中改為「Save chat」按鈕（僅臨時聊天才有）。
         */
        readonly temporaryChatActive: "button[aria-label*=\"關閉暫存對話\"], button[aria-label*=\"关闭临时\"], button[aria-label*=\"Turn off temporary\" i], button[aria-label*=\"一時チャットをオフ\"], button:text-is(\"Save chat\"), button[aria-label=\"Save chat\"]";
    };
    /** 臨時聊天模式的畫面指標字（任一出現即判定為臨時聊天） */
    readonly temporaryChatIndicators: readonly ["Temporary chat", "臨時聊天", "临时聊天", "一時的なチャット"];
    /** 登入牆的畫面指標字 */
    readonly loggedOutIndicators: readonly ["Log in", "Sign up", "登入", "注册", "登録"];
};
/** 連線設定：stdio（MCP 用戶端直啟）＋ HTTP（開 port 讓客戶端直接連線，兩者同時啟用） */
export declare const SERVER: {
    /** HTTP 監聽 port（預設 8321；改此值或設 WEBCHATMCP_PORT 覆蓋；設 0 停用 HTTP） */
    readonly httpPort: number;
    /** 監聽位址：預設 127.0.0.1（僅本機）；要讓區網連線設 WEBCHATMCP_HOST=0.0.0.0（無認證，慎用） */
    readonly httpHost: string;
    /** MCP endpoint 路徑（Streamable HTTP） */
    readonly httpPath: "/mcp";
    readonly env: {
        readonly port: "WEBCHATMCP_PORT";
        readonly host: "WEBCHATMCP_HOST";
    };
};
/** 時間參數（毫秒） */
export declare const TIMEOUTS: {
    /** 導航至 chatgpt.com 的上限 */
    readonly navigationMs: 45000;
    /** webchat_login 等待人工登入的預設上限 */
    readonly loginWaitMs: 180000;
    /** webchat_ask 等待回覆完成的預設上限（可用環境變數覆蓋） */
    readonly answerMs: number;
    /** 回覆文字穩定判定：連續 N 次間隔取樣不變且無停止按鈕 */
    readonly stableChecks: 3;
    readonly stableIntervalMs: 1500;
    /** 登入狀態輪詢間隔 */
    readonly loginPollMs: 2000;
};
