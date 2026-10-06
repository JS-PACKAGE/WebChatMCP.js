/**
 * WebChatMCP.js — 網頁聊天（ChatGPT／Claude／Grok／Gemini）瀏覽器會話與無痕聊天自動化。
 *
 * 職責：
 * 1. 以 Playwright persistent context 啟動內建瀏覽器，登入狀態持久化於 profile 目錄；
 * 2. 判定登入狀態與無痕（臨時）聊天模式（不猜測，找不到指標即回報 unknown）；
 * 3. 於全新無痕聊天輸入提示、送出、等待回覆穩定後擷取回覆文字；
 * 4. 登出：清除該服務網域的 cookie（不讀取 cookie 內容）。
 *
 * 訪客：ChatGPT、Gemini 未登入也能送出提示（Claude、Grok 必須登入）；登入只影響帳號層級功能（模型、無痕等）。
 *
 * 安全紀律：本檔不讀、不寫、不記錄任何密碼或 cookie 內容；登入只透過使用者
 * 在可視瀏覽器中人工操作。
 */
import { type ProviderId } from "./config.js";
import { type MenuContents, type MenuEntry } from "./providers.js";
export type { MenuContents, MenuEntry };
export type TriState = boolean | "unknown";
export interface SessionStatus {
    browserRunning: boolean;
    /** 目前頁面所屬的服務；瀏覽器未啟動或停在其他網站時為 null */
    provider: ProviderId | null;
    loggedIn: TriState;
    temporaryChat: TriState;
    profileDir: string;
    currentUrl: string | null;
}
export interface AskResult {
    answer: string;
    /** 是否在無痕／臨時聊天中 */
    temporaryChat: TriState;
    /** false＝訪客（未登入）送出 */
    loggedIn: TriState;
    elapsedMs: number;
    completed: boolean;
}
export declare class WebChatError extends Error {
    readonly code: "logged_out" | "browser_error" | "composer_not_found" | "send_failed" | "timeout" | "no_response" | "model_not_found" | "thinking_not_found";
    constructor(message: string, code: "logged_out" | "browser_error" | "composer_not_found" | "send_failed" | "timeout" | "no_response" | "model_not_found" | "thinking_not_found");
}
export declare class WebChatSession {
    private context;
    private page;
    private headless;
    get profileDir(): string;
    get browserRunning(): boolean;
    /** 啟動內建瀏覽器（持久化 profile）。已在執行時重複呼叫為 no-op。 */
    launch(options?: {
        headless?: boolean;
    }): Promise<void>;
    private goto;
    /**
     * 導航至指定服務的網址，處理驗證頁並略過升級／提示對話框。
     * 無頭模式過不了驗證頁（Cloudflare）時，暫時改用可視瀏覽器等它放行，通關結果存在 profile，之後即可回到無頭。
     */
    private open;
    private passChallenge;
    /** 略過會擋住畫面的升級／提示對話框（不代使用者做任何同意或填寫）。 */
    private dismissOverlays;
    /** 出現需要使用者本人處理的對話框（例如年齡確認）時回報錯誤。 */
    private ensureNotBlocked;
    private composer;
    /** 判定登入狀態：登入按鈕可見＝未登入（訪客）；否則以可見輸入框確認；找不到指標回 unknown。 */
    isLoggedIn(provider: ProviderId): Promise<TriState>;
    /** 判定目前頁面是否為無痕（臨時）聊天模式。 */
    isTemporaryChat(provider: ProviderId): Promise<TriState>;
    /**
     * 同步狀態（不探測頁面；登入／臨時聊天一律 unknown，探測版見 statusAsync）。
     */
    status(): SessionStatus;
    /**
     * 非同步取得狀態（含頁面探測）。指定 provider 時以該服務的分頁為準；
     * 省略時用目前停留的服務。
     */
    statusAsync(provider?: ProviderId): Promise<SessionStatus>;
    /** 最近開啟的分頁所屬的服務（不限定特定 provider）。 */
    private latestProvider;
    /**
     * 等待人工登入完成。逾時不視為錯誤：瀏覽器保持開啟，回傳目前狀態。
     */
    waitForLogin(provider: ProviderId, timeoutMs: number): Promise<{
        loggedIn: TriState;
        elapsedMs: number;
    }>;
    /** 在目前瀏覽器開啟服務首頁並探測登入狀態；驗證頁或載入失敗一律視為 unknown。 */
    private probeLogin;
    /** 已確認登入後，預設為無頭時把可視瀏覽器收回無頭（登入狀態在 profile，不需再看到 UI）。 */
    private hideBrowser;
    /**
     * 登入流程：先以（預設無頭的）瀏覽器查詢是否已登入，已登入就直接回傳；
     * 未登入或無法判定（例如停在 Cloudflare 驗證頁）才切換為可視瀏覽器等待人工登入。
     * 人工登入成功後若預設為無頭，會把瀏覽器切回無頭，不留視窗。
     */
    login(provider: ProviderId, timeoutMs: number): Promise<{
        loggedIn: TriState;
        elapsedMs: number;
        alreadyLoggedIn: boolean;
    }>;
    /**
     * 登出：清除該服務網域的 cookie（不讀取 cookie 內容），再重新探測登入狀態。
     * 不需要畫面；瀏覽器未啟動時以預設（無頭）模式啟動。
     */
    logout(provider: ProviderId): Promise<{
        domains: readonly string[];
        loggedIn: TriState;
    }>;
    /** 等待輸入框、登入按鈕或登入頁其一出現（頁面已可操作）。 */
    private waitForReady;
    /** 載入服務頁並確認輸入框可用；沒有輸入框時，依登入狀態回報 logged_out 或 composer_not_found。 */
    private openForUse;
    /** 需要按鈕才能進入無痕的服務（Gemini）：載入後點擊；訪客沒有此按鈕時略過。 */
    private enterPrivate;
    /**
     * 在全新的無痕（臨時）聊天送出提示，等待回覆完成後回傳文字。
     * options.model 指定時，先在模型選單切換模型再送出；options.thinking 指定時，接著設定思考深度。
     */
    ask(provider: ProviderId, prompt: string, options?: {
        timeoutMs?: number;
        model?: string;
        thinking?: string;
    }): Promise<AskResult>;
    /** 關閉瀏覽器並釋放資源。 */
    close(): Promise<void>;
    /** 列出模型與思考深度（依帳號等級即時擷取，不寫死）。 */
    listModels(provider: ProviderId): Promise<MenuContents>;
    /** 切換模型；名單比對不中即回 model_not_found（先呼叫 webchat_models 查看可用清單）。 */
    selectModel(provider: ProviderId, label: string): Promise<{
        selected: boolean;
        label: string;
    }>;
    /** 設定思考深度；名單比對不中（或此服務沒有思考設定）即回 thinking_not_found（先呼叫 webchat_models 查看 thinking 清單）。 */
    selectThinking(provider: ProviderId, label: string): Promise<{
        selected: boolean;
        label: string;
    }>;
    /** 登入可能開啟新分頁；只接手同一 context 裡屬於該服務的頁面。 */
    private currentPage;
    private requirePage;
    private lastAssistantText;
}
