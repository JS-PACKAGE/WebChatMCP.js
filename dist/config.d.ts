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
    readonly version: "1.2.0";
    readonly website: "https://webchatmcp.js-package.xyz";
    readonly repository: "https://github.com/JS-PACKAGE/WebChatMCP.js";
    readonly license: "Apache-2.0";
};
/** 內建瀏覽器與持久化設定 */
export declare const BROWSER: {
    /** playwright 啟動通道：chromium（內建）｜chrome｜msedge */
    readonly channel: string;
    /** 預設無頭；僅 webchat_login 在未登入時暫時顯示瀏覽器供人工登入。WEBCHATMCP_HEADLESS=0 時一律可視 */
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
/** 內建的網頁聊天服務；外掛在啟動時另外註冊到 PROVIDERS（見 src/plugins.ts） */
export declare const PROVIDER_IDS: readonly ["chatgpt", "claude", "grok", "gemini"];
export type ProviderId = string;
export type MenuKind = "chatgpt" | "radio" | "gemini";
export declare const DEFAULT_PROVIDER: ProviderId;
/** 單一服務的網址與 DOM 契約（UI 變動時只改這裡） */
export interface ProviderConfig {
    label: string;
    /** 模型選單的結構：chatgpt＝兩層視圖＋滑桿；gemini＝gem-menu；radio＝一般 menuitemradio（可含子選單） */
    menu: MenuKind;
    /** 登入與探測登入狀態用的首頁（未登入時 Claude 會被導向登入頁） */
    baseUrl: string;
    /** 每次 webchat_ask 開啟的網址：能直接進無痕／臨時聊天的服務在此帶上對應參數 */
    askUrl: string;
    /** 進入無痕的方式：url＝askUrl 已是無痕；button＝載入後點擊 selectors.privateEnter */
    privateMode: "url" | "button";
    /** 未登入也能取得回覆（訪客模式，已實測）；Claude 必須登入，Grok 訪客送出後會被要求註冊 */
    guest: boolean;
    /** webchat_logout 清除 cookie 的網域（含子網域） */
    domains: readonly string[];
    /** 登入頁網址特徵（正規表達式字串）：停在此頁即未登入 */
    loginUrlPattern: string | null;
    selectors: {
        composer: string;
        sendButton: string;
        stopButton: string;
        /** 助理回覆節點（取最後一個；其中 .markdown/.prose 優先） */
        assistantMessage: string;
        /** 可見時代表未登入（訪客）的登入按鈕或連結 */
        loginButton: string;
        modelSwitcher: string;
        /** 載入後點擊以進入無痕（privateMode=button） */
        privateEnter: string | null;
        /** 無痕／臨時聊天啟用中的畫面元素 */
        privateActive: string | null;
        /** 彈出的升級／提示對話框的略過按鈕（逐一嘗試，找到就點） */
        dismiss: readonly string[];
        /** 需要使用者本人處理的對話框（例如年齡確認）；出現時回報錯誤而不代填 */
        blocking: string | null;
    };
    /** 無痕／臨時聊天模式的畫面指標字（任一出現即判定為無痕） */
    privateIndicators: readonly string[];
    /** 登入牆的畫面指標字（訪客頁面可能同時有輸入框） */
    loggedOutIndicators: readonly string[];
    /** 思考深度（Claude 的「努力程度」選單項）文字的正規表達式字串；無則 null */
    thinkingMenuItem: string | null;
    /** 「更多模型」子選單的選單項文字（正規表達式字串）；無則 null */
    moreModelsMenuItem: string | null;
}
export declare const PROVIDERS: Record<string, ProviderConfig>;
/** 目前已註冊的服務代號（內建＋已載入的外掛）。 */
export declare function providerIds(): string[];
/** 外掛：用 JSON 檔新增其他聊天服務（格式見 plugins/README.md） */
export declare const PLUGINS: {
    /** 倉庫內的 plugins/ 目錄（檔名以 _ 開頭的範本不會載入） */
    readonly bundledDir: string;
    /** 使用者外掛目錄；WEBCHATMCP_PLUGINS_DIR 可改（多個以系統的路徑分隔符號分開） */
    readonly userDirs: string;
    /** 外掛 id 的格式；內建服務 id 不可被覆蓋 */
    readonly idPattern: "^[a-z][a-z0-9-]{1,30}$";
    readonly env: {
        readonly dirs: "WEBCHATMCP_PLUGINS_DIR";
    };
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
    /** 無頭過不了驗證頁時，暫時改用可視瀏覽器等待放行的上限 */
    readonly challengeMs: 90000;
    /** 等待模型選單按鈕完成 hydration 的上限 */
    readonly modelSwitcherMs: 10000;
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
