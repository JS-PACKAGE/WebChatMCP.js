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
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { BROWSER, CHATGPT, TIMEOUTS } from "./config.js";
export class WebChatError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "WebChatError";
    }
}
function expandHome(p) {
    return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}
/** Cloudflare 等驗證頁特徵（title 偵測） */
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|verify you are human|請稍候|请稍候|お待ちください/i;
let cachedUserAgent;
/** 取得本機瀏覽器的 UA 並去掉 "Headless"（版本與實際瀏覽器一致）。 */
async function normalUserAgent(channel) {
    if (cachedUserAgent)
        return cachedUserAgent;
    const browser = await chromium.launch({ channel, headless: true });
    try {
        const probe = await browser.newPage();
        const ua = await probe.evaluate(() => navigator.userAgent);
        cachedUserAgent = ua.replace("HeadlessChrome", "Chrome");
    }
    finally {
        await browser.close();
    }
    return cachedUserAgent;
}
const CHATGPT_ORIGIN = new URL(CHATGPT.baseUrl).origin;
const COMPOSER_SELECTOR = `${CHATGPT.selectors.composer}:visible, ${CHATGPT.selectors.composerAlt}:visible`;
const READY_SELECTOR = `${COMPOSER_SELECTOR}, ${CHATGPT.selectors.loginButton}:visible`;
/** 等待驗證頁自動放行；逾時回 false（呼叫端決定語意）。 */
async function waitOutChallenge(page, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const title = await page.title().catch(() => "");
        if (title && !CHALLENGE_TITLE.test(title))
            return true;
        await page.waitForTimeout(1_000).catch(() => { });
    }
    const title = await page.title().catch(() => "");
    return !(title && CHALLENGE_TITLE.test(title));
}
export class ChatGPTSession {
    context = null;
    page = null;
    headless = BROWSER.headlessDefault;
    get profileDir() {
        return expandHome(BROWSER.profileDir);
    }
    get browserRunning() {
        return this.context !== null;
    }
    /** 啟動內建瀏覽器（持久化 profile）。已在執行時重複呼叫為 no-op。 */
    async launch(options = {}) {
        if (this.context)
            return;
        const headless = options.headless ?? BROWSER.headlessDefault;
        const channel = BROWSER.channel === "chromium" ? undefined : BROWSER.channel;
        this.context = await chromium.launchPersistentContext(this.profileDir, {
            channel,
            headless,
            // 無頭 UA 帶有 "HeadlessChrome"，會被 Cloudflare 擋在驗證頁；改用一般 Chrome UA。
            // 可視與無頭共用同一個 UA：cf_clearance 與 UA 綁定，兩種模式才能共用通關結果。
            userAgent: await normalUserAgent(channel),
            viewport: BROWSER.viewport,
            args: ["--disable-blink-features=AutomationControlled"],
        });
        this.headless = headless;
        const pages = this.context.pages();
        this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
        this.context.on("close", () => {
            this.context = null;
            this.page = null;
        });
    }
    /** 導航至 ChatGPT 首頁（供登入使用）。 */
    async openChatGPT() {
        const page = this.requirePage();
        await page.goto(CHATGPT.baseUrl, {
            waitUntil: "domcontentloaded",
            timeout: TIMEOUTS.navigationMs,
        });
        await page.waitForTimeout(1500);
        await this.ensureNotChallenged(page);
    }
    /** 驗證頁（Cloudflare 等）處理：先等自動放行，逾時給出明確指引。 */
    async ensureNotChallenged(page) {
        if (await waitOutChallenge(page))
            return;
        throw new WebChatError("頁面停留在驗證（Cloudflare challenge）畫面。請呼叫 webchat_login 以可視瀏覽器完成驗證與登入，" +
            `或設定 ${BROWSER.env.headless}=0 以可視模式啟動。`, "browser_error");
    }
    /** 判定登入狀態：先排除登入畫面，再以可見輸入框確認；否則 unknown。 */
    async isLoggedIn() {
        const page = this.currentPage();
        if (!page)
            return "unknown";
        try {
            if (new URL(page.url()).origin !== CHATGPT_ORIGIN)
                return "unknown";
            if (/\/auth\//.test(page.url()))
                return false;
            if (await page.locator(`${CHATGPT.selectors.loginButton}:visible`).first().isVisible()) {
                return false;
            }
            if (await page.locator(COMPOSER_SELECTOR).first().isVisible())
                return true;
            const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
            for (const marker of CHATGPT.loggedOutIndicators) {
                if (bodyText.includes(marker))
                    return false;
            }
            return "unknown";
        }
        catch {
            return "unknown";
        }
    }
    /** 判定目前頁面是否為臨時（無痕）聊天模式。 */
    async isTemporaryChat() {
        const page = this.currentPage();
        if (!page || new URL(page.url()).origin !== CHATGPT_ORIGIN)
            return "unknown";
        try {
            if (await page.locator(CHATGPT.selectors.temporaryChatActive).first().isVisible())
                return true;
            const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
            for (const marker of CHATGPT.temporaryChatIndicators) {
                if (bodyText.includes(marker))
                    return true;
            }
            return "unknown";
        }
        catch {
            return "unknown";
        }
    }
    /** 同步狀態（不探測頁面；登入／臨時聊天一律 unknown，探測版見 statusAsync）。 */
    status() {
        const page = this.currentPage();
        return {
            browserRunning: this.browserRunning,
            loggedIn: "unknown",
            temporaryChat: "unknown",
            profileDir: this.profileDir,
            currentUrl: page?.url() ?? null,
        };
    }
    /** 非同步取得狀態（含頁面探測）。 */
    async statusAsync() {
        return {
            browserRunning: this.browserRunning,
            loggedIn: this.browserRunning ? await this.isLoggedIn() : "unknown",
            temporaryChat: this.browserRunning ? await this.isTemporaryChat() : "unknown",
            profileDir: this.profileDir,
            currentUrl: this.currentPage()?.url() ?? null,
        };
    }
    /**
     * 等待人工登入完成。逾時不視為錯誤：瀏覽器保持開啟，回傳目前狀態。
     */
    async waitForLogin(timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const state = await this.isLoggedIn();
            if (state === true)
                return { loggedIn: true, elapsedMs: Date.now() - start };
            await delay(Math.min(TIMEOUTS.loginPollMs, Math.max(0, timeoutMs - (Date.now() - start))));
        }
        return { loggedIn: await this.isLoggedIn(), elapsedMs: Date.now() - start };
    }
    /** 在目前瀏覽器開啟 ChatGPT 首頁並探測登入狀態；驗證頁或載入失敗一律視為 unknown。 */
    async probeLogin() {
        try {
            await this.openChatGPT();
            await this.waitForChatGPTReady(this.requirePage());
            return await this.isLoggedIn();
        }
        catch (err) {
            if (err instanceof WebChatError)
                return "unknown";
            throw err;
        }
    }
    /** 已確認登入後，預設為無頭時把可視瀏覽器收回無頭（登入狀態在 profile，不需再看到 UI）。 */
    async hideBrowser() {
        if (this.headless || !BROWSER.headlessDefault)
            return;
        await this.close();
        await this.launch();
        await this.probeLogin();
    }
    /**
     * 登入流程：先以（預設無頭的）瀏覽器查詢是否已登入，已登入就直接回傳；
     * 未登入或無法判定（例如停在 Cloudflare 驗證頁）才切換為可視瀏覽器等待人工登入。
     * 人工登入成功後若預設為無頭，會把瀏覽器切回無頭，不留視窗。
     */
    async login(timeoutMs) {
        const start = Date.now();
        await this.launch();
        if ((await this.probeLogin()) === true) {
            await this.hideBrowser();
            return { loggedIn: true, elapsedMs: Date.now() - start, alreadyLoggedIn: true };
        }
        if (this.headless) {
            await this.close();
            await this.launch({ headless: false });
            await this.openChatGPT();
        }
        const waited = await this.waitForLogin(Math.max(0, timeoutMs - (Date.now() - start)));
        if (waited.loggedIn === true)
            await this.hideBrowser();
        return { loggedIn: waited.loggedIn, elapsedMs: Date.now() - start, alreadyLoggedIn: false };
    }
    /**
     * 在全新的臨時（無痕）聊天送出提示，等待回覆完成後回傳文字。
     * options.model 指定時，先在模型選單切換模型再送出。
     */
    async ask(prompt, options = {}) {
        const timeoutMs = options.timeoutMs ?? TIMEOUTS.answerMs;
        const page = this.requirePage();
        const start = Date.now();
        // 每次呼叫都開啟全新的臨時聊天（不留歷史、不延續上一題）
        await page.goto(CHATGPT.temporaryChatUrl, {
            waitUntil: "domcontentloaded",
            timeout: TIMEOUTS.navigationMs,
        });
        await this.ensureNotChallenged(page);
        await this.waitForChatGPTReady(page, Math.min(TIMEOUTS.navigationMs, Math.max(1, start + timeoutMs - Date.now())));
        const loggedIn = await this.isLoggedIn();
        if (loggedIn !== true) {
            throw new WebChatError("ChatGPT 尚未登入：請先呼叫 webchat_login 並在瀏覽器中完成登入。", "logged_out");
        }
        const temporaryChat = await this.isTemporaryChat();
        // 指定模型時先切換（每題都是新對話，逐題確保模型正確）
        if (options.model) {
            await this.selectModel(options.model);
        }
        // 輸入提示（composer 為 contenteditable 或 textarea 皆適用）
        const composer = await page.$(COMPOSER_SELECTOR);
        if (!composer) {
            throw new WebChatError("找不到 ChatGPT 輸入框（#prompt-textarea）。", "composer_not_found");
        }
        await composer.click();
        await page.keyboard.insertText(prompt);
        await page.waitForTimeout(300);
        // 必須在送出前記錄基準，否則快速回覆會被當成既有訊息而漏掉。
        const before = await page.$$(CHATGPT.selectors.assistantMessage);
        // 送出：優先點擊送出按鈕，退回 Enter 鍵
        const sendButton = (await page.$(CHATGPT.selectors.sendButton)) ?? (await page.$(CHATGPT.selectors.sendButtonAlt));
        if (sendButton) {
            await sendButton.click();
        }
        else {
            await page.keyboard.press("Enter");
        }
        // 等待新的助理回覆出現
        const deadline = start + timeoutMs;
        let seenResponse = false;
        while (Date.now() < deadline) {
            const now = await page.$$(CHATGPT.selectors.assistantMessage);
            if (now.length > before.length) {
                seenResponse = true;
                break;
            }
            await page.waitForTimeout(500);
        }
        if (!seenResponse) {
            throw new WebChatError(`送出後 ${Math.round(timeoutMs / 1000)} 秒內未見 ChatGPT 回覆（可能觸發驗證或速率限制）。`, "no_response");
        }
        // 等待回覆穩定：連續 stableChecks 次取樣文字不變，且無停止生成按鈕
        let lastText = "";
        let stable = 0;
        let completed = false;
        while (Date.now() < deadline) {
            const text = await this.lastAssistantText();
            const stopButton = await page.$(CHATGPT.selectors.stopButton);
            if (text && text === lastText && !stopButton) {
                stable += 1;
                if (stable >= TIMEOUTS.stableChecks) {
                    completed = true;
                    break;
                }
            }
            else {
                stable = 0;
            }
            lastText = text;
            await page.waitForTimeout(TIMEOUTS.stableIntervalMs);
        }
        const answer = await this.lastAssistantText();
        if (!answer) {
            throw new WebChatError("回覆內容為空，無法擷取。", "no_response");
        }
        return { answer, temporaryChat, elapsedMs: Date.now() - start, completed };
    }
    /** 關閉瀏覽器並釋放資源。 */
    async close() {
        const context = this.context;
        this.context = null;
        this.page = null;
        if (context) {
            await context.close().catch(() => { });
        }
    }
    /** 開啟模型選單（找不到開關即回報 UI 變動徵兆）。 */
    async openModelMenu(page) {
        const primary = page.locator(CHATGPT.selectors.modelSwitcher).first();
        const switcher = (await primary.elementHandle({ timeout: TIMEOUTS.modelSwitcherMs }).catch(() => null)) ??
            (await page.$(CHATGPT.selectors.modelSwitcherAlt));
        if (!switcher) {
            throw new WebChatError("找不到模型選單按鈕（model switcher；ChatGPT UI 變動徵兆）。", "browser_error");
        }
        await switcher.click();
        await page.waitForTimeout(500);
        // 新版選單預設顯示「思考強度」視圖，模型清單（DOM 中雖存在且 visible）被它遮住，
        // 需點擊標題列（第一個 menuitem）切換；以 elementFromPoint 判斷是否真的可點。
        const clickable = () => page
            .locator(CHATGPT.selectors.modelMenuItem)
            .first()
            .evaluate((el) => {
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return !!top && el.contains(top);
        })
            .catch(() => false);
        if (!(await clickable())) {
            const header = page.locator(CHATGPT.selectors.modelMenuItemAlt).first();
            if (await header.isVisible().catch(() => false)) {
                await header.click();
                await page.waitForTimeout(500);
            }
        }
    }
    /**
     * 模型項目是 role=menuitemradio；一般 menuitem 是思考強度滑桿、存取選項等非模型項目，
     * 只有在畫面完全沒有 radio 項目時才退回 menuitem。
     */
    async modelMenuItems(page) {
        const radios = await page.$$(CHATGPT.selectors.modelMenuItem);
        if (radios.length > 0)
            return radios;
        return page.$$(CHATGPT.selectors.modelMenuItemAlt);
    }
    /** 列出可用模型（依帳號等級即時擷取，不寫死）。 */
    async listModels() {
        const page = this.requirePage();
        if (new URL(page.url()).origin !== CHATGPT_ORIGIN) {
            await this.openChatGPT();
        }
        await this.ensureNotChallenged(page);
        await this.waitForChatGPTReady(page);
        const loggedIn = await this.isLoggedIn();
        if (loggedIn !== true) {
            throw new WebChatError("ChatGPT 尚未登入：請先呼叫 webchat_login 並在瀏覽器中完成登入。", "logged_out");
        }
        await this.openModelMenu(page);
        const items = await this.modelMenuItems(page);
        const models = [];
        for (const item of items) {
            const raw = ((await item.innerText().catch(() => "")) ?? "").trim();
            if (!raw)
                continue;
            const label = raw.split("\n")[0].trim();
            if (!label)
                continue;
            const checked = (await item.getAttribute("aria-checked")) === "true" ||
                (await item.getAttribute("data-state")) === "checked";
            models.push({ label, current: checked });
        }
        await page.keyboard.press("Escape").catch(() => { });
        return models;
    }
    /** 切換模型；名單比對不中即回 model_not_found（先呼叫 webchat_models 查看可用清單）。 */
    async selectModel(label) {
        const page = this.requirePage();
        await this.openModelMenu(page);
        const items = await this.modelMenuItems(page);
        const wanted = label.trim().toLowerCase();
        for (const item of items) {
            const raw = ((await item.innerText().catch(() => "")) ?? "").trim();
            const itemLabel = raw.split("\n")[0].trim();
            if (!itemLabel)
                continue;
            const key = itemLabel.toLowerCase();
            if (key === wanted || key.includes(wanted)) {
                await item.click();
                await page.waitForTimeout(800);
                return { selected: true, label: itemLabel };
            }
        }
        await page.keyboard.press("Escape").catch(() => { });
        throw new WebChatError(`找不到模型「${label}」。請先呼叫 webchat_models 查看可用清單。`, "model_not_found");
    }
    /** 登入可能開啟新分頁；只接手同一 context 裡的 ChatGPT 頁面。 */
    currentPage() {
        const pages = this.context?.pages() ?? [];
        for (let i = pages.length - 1; i >= 0; i -= 1) {
            const page = pages[i];
            if (!page.isClosed() && new URL(page.url()).origin === CHATGPT_ORIGIN) {
                this.page = page;
                return page;
            }
        }
        if (this.page?.isClosed())
            this.page = null;
        return this.page;
    }
    /** DOMContentLoaded 不代表輸入框已完成 hydration；等待可操作的畫面指標。 */
    async waitForChatGPTReady(page, timeoutMs = TIMEOUTS.navigationMs) {
        try {
            await page.locator(READY_SELECTOR).first().waitFor({ state: "visible", timeout: timeoutMs });
        }
        catch {
            throw new WebChatError("ChatGPT 頁面尚未載入可用的輸入框或登入按鈕。請確認瀏覽器畫面與網路連線。", "browser_error");
        }
    }
    requirePage() {
        const page = this.currentPage();
        if (!page) {
            throw new WebChatError("瀏覽器尚未啟動或 ChatGPT 分頁已關閉。", "browser_error");
        }
        return page;
    }
    async lastAssistantText() {
        const page = this.requirePage();
        const messages = await page.$$(CHATGPT.selectors.assistantMessage);
        if (messages.length === 0)
            return "";
        const last = messages[messages.length - 1];
        const markdown = await last.$(".markdown, .prose");
        const target = markdown ?? last;
        return ((await target.innerText().catch(() => "")) ?? "").trim();
    }
}
