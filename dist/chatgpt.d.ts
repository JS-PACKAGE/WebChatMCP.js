/**
 * WebChatMCP.js — ChatGPT 瀏覽器會話與臨時聊天自動化。
 *
 * 職責：
 * 1. 以 Playwright persistent context 啟動內建瀏覽器，登入狀態持久化於 profile 目錄；
 * 2. 判定登入狀態與臨時聊天模式（不猜測，找不到指標即回報 unknown）；
 * 3. 於全新臨時聊天輸入提示、送出、等待回覆穩定後擷取回覆文字。
 *
 * 安全紀律：本檔不讀、不寫、不記錄任何密碼或 cookie 內容；登入只透過使用者
 * 在可視瀏覽器中人工操作。
 */
export type TriState = boolean | "unknown";
export interface SessionStatus {
    browserRunning: boolean;
    loggedIn: TriState;
    temporaryChat: TriState;
    profileDir: string;
    currentUrl: string | null;
}
export interface AskResult {
    answer: string;
    temporaryChat: TriState;
    elapsedMs: number;
    completed: boolean;
}
export interface ModelEntry {
    label: string;
    current: boolean;
}
export declare class WebChatError extends Error {
    readonly code: "logged_out" | "browser_error" | "composer_not_found" | "send_failed" | "timeout" | "no_response" | "model_not_found";
    constructor(message: string, code: "logged_out" | "browser_error" | "composer_not_found" | "send_failed" | "timeout" | "no_response" | "model_not_found");
}
export declare class ChatGPTSession {
    private context;
    private page;
    get profileDir(): string;
    get browserRunning(): boolean;
    /** 啟動內建瀏覽器（持久化 profile）。已在執行時重複呼叫為 no-op。 */
    launch(options?: {
        headless?: boolean;
    }): Promise<void>;
    /** 導航至 ChatGPT 首頁（供登入使用）。 */
    openChatGPT(): Promise<void>;
    /** 驗證頁（Cloudflare 等）處理：先等自動放行，逾時給出明確指引。 */
    private ensureNotChallenged;
    /** 判定登入狀態：有輸入框＝已登入；有登入按鈕或 auth 路徑＝未登入；否則 unknown。 */
    isLoggedIn(): Promise<TriState>;
    /** 判定目前頁面是否為臨時（無痕）聊天模式。 */
    isTemporaryChat(): Promise<TriState>;
    /** 同步狀態（不探測頁面；登入／臨時聊天一律 unknown，探測版見 statusAsync）。 */
    status(): SessionStatus;
    /** 非同步取得狀態（含頁面探測）。 */
    statusAsync(): Promise<SessionStatus>;
    /**
     * 等待人工登入完成。逾時不視為錯誤：瀏覽器保持開啟，回傳目前狀態。
     */
    waitForLogin(timeoutMs: number): Promise<{
        loggedIn: TriState;
        elapsedMs: number;
    }>;
    /**
     * 在全新的臨時（無痕）聊天送出提示，等待回覆完成後回傳文字。
     * options.model 指定時，先在模型選單切換模型再送出。
     */
    ask(prompt: string, options?: {
        timeoutMs?: number;
        model?: string;
    }): Promise<AskResult>;
    /** 關閉瀏覽器並釋放資源。 */
    close(): Promise<void>;
    /** 開啟模型選單（找不到開關即回報 UI 變動徵兆）。 */
    private openModelMenu;
    /** 列出可用模型（依帳號等級即時擷取，不寫死）。 */
    listModels(): Promise<ModelEntry[]>;
    /** 切換模型；名單比對不中即回 model_not_found（先呼叫 webchat_models 查看可用清單）。 */
    selectModel(label: string): Promise<{
        selected: boolean;
        label: string;
    }>;
    private requirePage;
    private lastAssistantText;
}
