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
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { BROWSER, PROVIDERS, providerIds, TIMEOUTS } from "./config.js";
import { MenuError, readMenu, selectModelItem, selectThinkingItem } from "./providers.js";
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
function originOf(provider) {
    return new URL(PROVIDERS[provider].baseUrl).origin;
}
function providerOfUrl(url) {
    let origin;
    try {
        origin = new URL(url).origin;
    }
    catch {
        return null;
    }
    return providerIds().find((id) => originOf(id) === origin) ?? null;
}
function onLoginUrl(provider, url) {
    const pattern = PROVIDERS[provider].loginUrlPattern;
    return pattern !== null && new RegExp(pattern).test(url);
}
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
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export class WebChatSession {
    context = null;
    page = null;
    headless = BROWSER.headlessDefault;
    /** 回覆後預先載好的下一個無痕聊天頁（見 prewarm）；任何其他導航或關閉瀏覽器都會使它失效 */
    warm = null;
    get profileDir() {
        return expandHome(BROWSER.profileDir);
    }
    get browserRunning() {
        return this.context !== null;
    }
    /** 目前是否為無頭瀏覽器（可視瀏覽器可能正被使用者操作，不自動關閉也不預先載入） */
    get isHeadless() {
        return this.headless;
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
            this.warm = null;
        });
    }
    async goto(page, url, timeoutMs = TIMEOUTS.navigationMs) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForTimeout(TIMEOUTS.postNavigationMs);
    }
    /**
     * 導航至指定服務的網址，處理驗證頁並略過升級／提示對話框。
     * 無頭模式過不了驗證頁（Cloudflare）時，暫時改用可視瀏覽器等它放行，通關結果存在 profile，之後即可回到無頭。
     */
    async open(provider, url) {
        this.warm = null;
        let page = this.requirePage(provider);
        await this.goto(page, url);
        if (!(await waitOutChallenge(page))) {
            page = await this.passChallenge(provider, url);
        }
        await this.dismissOverlays(page, provider);
        return page;
    }
    async passChallenge(provider, url) {
        const failure = new WebChatError(`${PROVIDERS[provider].label} 停留在驗證（Cloudflare challenge）畫面。請在已開啟的瀏覽器視窗中完成驗證後重試，` +
            `或設定 ${BROWSER.env.headless}=0 以可視模式啟動。`, "browser_error");
        const hideAfter = this.headless && BROWSER.headlessDefault;
        if (hideAfter) {
            await this.close();
            await this.launch({ headless: false });
            await this.goto(this.requirePage(), url);
        }
        const visiblePage = this.requirePage(provider);
        if (!(await waitOutChallenge(visiblePage, TIMEOUTS.challengeMs)))
            throw failure;
        if (!hideAfter)
            return visiblePage;
        await this.close();
        await this.launch();
        const page = this.requirePage();
        await this.goto(page, url);
        if (!(await waitOutChallenge(page)))
            throw failure;
        return page;
    }
    /** 略過會擋住畫面的升級／提示對話框（不代使用者做任何同意或填寫）。 */
    async dismissOverlays(page, provider) {
        for (const selector of PROVIDERS[provider].selectors.dismiss) {
            const button = page.locator(selector).filter({ visible: true }).first();
            if (await button.isVisible().catch(() => false)) {
                await button.click({ timeout: 3_000 }).catch(() => { });
                await page.waitForTimeout(500);
            }
        }
    }
    /** 出現需要使用者本人處理的對話框（例如年齡確認）時回報錯誤。 */
    async ensureNotBlocked(page, provider) {
        const selector = PROVIDERS[provider].selectors.blocking;
        if (selector && (await page.locator(selector).first().isVisible().catch(() => false))) {
            throw new WebChatError(`${PROVIDERS[provider].label} 跳出需要本人處理的對話框（例如年齡確認）。請呼叫 webchat_login（provider=${provider}）在可視瀏覽器中完成，之後即可使用。`, "browser_error");
        }
    }
    composer(page, provider) {
        return page.locator(PROVIDERS[provider].selectors.composer).filter({ visible: true }).first();
    }
    /** 判定登入狀態：登入按鈕可見＝未登入（訪客）；否則以可見輸入框確認；找不到指標回 unknown。 */
    async isLoggedIn(provider) {
        const page = this.currentPage(provider);
        if (!page)
            return "unknown";
        const config = PROVIDERS[provider];
        try {
            if (onLoginUrl(provider, page.url()))
                return false;
            if (providerOfUrl(page.url()) !== provider)
                return "unknown";
            if (await page.locator(config.selectors.loginButton).filter({ visible: true }).first().isVisible()) {
                return false;
            }
            if (await this.composer(page, provider).isVisible())
                return true;
            if (config.loggedOutIndicators.length > 0) {
                const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
                for (const marker of config.loggedOutIndicators) {
                    if (bodyText.includes(marker))
                        return false;
                }
            }
            return "unknown";
        }
        catch {
            return "unknown";
        }
    }
    /** 判定目前頁面是否為無痕（臨時）聊天模式。 */
    async isTemporaryChat(provider) {
        const page = this.currentPage(provider);
        if (!page || providerOfUrl(page.url()) !== provider)
            return "unknown";
        const config = PROVIDERS[provider];
        try {
            if (config.selectors.privateActive &&
                (await page.locator(config.selectors.privateActive).first().isVisible())) {
                return true;
            }
            const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
            for (const marker of config.privateIndicators) {
                if (bodyText.includes(marker))
                    return true;
            }
            return "unknown";
        }
        catch {
            return "unknown";
        }
    }
    /**
     * 同步狀態（不探測頁面；登入／臨時聊天一律 unknown，探測版見 statusAsync）。
     */
    status() {
        const page = this.page && !this.page.isClosed() ? this.page : null;
        return {
            browserRunning: this.browserRunning,
            provider: page ? providerOfUrl(page.url()) : null,
            loggedIn: "unknown",
            temporaryChat: "unknown",
            profileDir: this.profileDir,
            currentUrl: page?.url() ?? null,
        };
    }
    /**
     * 非同步取得狀態（含頁面探測）。指定 provider 時以該服務的分頁為準；
     * 省略時用目前停留的服務。
     */
    async statusAsync(provider) {
        const target = provider ?? this.latestProvider();
        const page = target ? this.currentPage(target) : null;
        return {
            browserRunning: this.browserRunning,
            provider: target,
            loggedIn: this.browserRunning && target ? await this.isLoggedIn(target) : "unknown",
            temporaryChat: this.browserRunning && target ? await this.isTemporaryChat(target) : "unknown",
            profileDir: this.profileDir,
            currentUrl: (page ?? this.currentPage())?.url() ?? null,
        };
    }
    /** 最近開啟的分頁所屬的服務（不限定特定 provider）。 */
    latestProvider() {
        const pages = this.context?.pages() ?? [];
        for (let i = pages.length - 1; i >= 0; i -= 1) {
            if (pages[i].isClosed())
                continue;
            const found = providerOfUrl(pages[i].url());
            if (found)
                return found;
        }
        return null;
    }
    /**
     * 等待人工登入完成。逾時不視為錯誤：瀏覽器保持開啟，回傳目前狀態。
     */
    async waitForLogin(provider, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const state = await this.isLoggedIn(provider);
            if (state === true)
                return { loggedIn: true, elapsedMs: Date.now() - start };
            await delay(Math.min(TIMEOUTS.loginPollMs, Math.max(0, timeoutMs - (Date.now() - start))));
        }
        return { loggedIn: await this.isLoggedIn(provider), elapsedMs: Date.now() - start };
    }
    /** 在目前瀏覽器開啟服務首頁並探測登入狀態；驗證頁或載入失敗一律視為 unknown。 */
    async probeLogin(provider) {
        try {
            const page = await this.open(provider, PROVIDERS[provider].baseUrl);
            await this.waitForReady(page, provider);
            return await this.isLoggedIn(provider);
        }
        catch (err) {
            if (err instanceof WebChatError)
                return "unknown";
            throw err;
        }
    }
    /** 已確認登入後，預設為無頭時把可視瀏覽器收回無頭（登入狀態在 profile，不需再看到 UI）。 */
    async hideBrowser(provider) {
        if (this.headless || !BROWSER.headlessDefault)
            return;
        await this.close();
        await this.launch();
        await this.probeLogin(provider);
    }
    /**
     * 登入流程：先以（預設無頭的）瀏覽器查詢是否已登入，已登入就直接回傳；
     * 未登入或無法判定（例如停在 Cloudflare 驗證頁）才切換為可視瀏覽器等待人工登入。
     * 人工登入成功後若預設為無頭，會把瀏覽器切回無頭，不留視窗。
     */
    async login(provider, timeoutMs) {
        const start = Date.now();
        await this.launch();
        if ((await this.probeLogin(provider)) === true) {
            await this.hideBrowser(provider);
            return { loggedIn: true, elapsedMs: Date.now() - start, alreadyLoggedIn: true };
        }
        if (this.headless) {
            await this.close();
            await this.launch({ headless: false });
            await this.open(provider, PROVIDERS[provider].baseUrl);
        }
        const waited = await this.waitForLogin(provider, Math.max(0, timeoutMs - (Date.now() - start)));
        if (waited.loggedIn === true)
            await this.hideBrowser(provider);
        return { loggedIn: waited.loggedIn, elapsedMs: Date.now() - start, alreadyLoggedIn: false };
    }
    /**
     * 登出：清除該服務網域的 cookie（不讀取 cookie 內容），再重新探測登入狀態。
     * 不需要畫面；瀏覽器未啟動時以預設（無頭）模式啟動。
     */
    async logout(provider) {
        await this.launch();
        const context = this.context;
        if (!context)
            throw new WebChatError("瀏覽器尚未啟動。", "browser_error");
        const domains = PROVIDERS[provider].domains;
        for (const domain of domains) {
            await context.clearCookies({ domain: new RegExp(`(^|\\.)${escapeRegExp(domain)}$`) });
        }
        return { domains, loggedIn: await this.probeLogin(provider) };
    }
    /** 等待輸入框、登入按鈕或登入頁其一出現（頁面已可操作）。 */
    async waitForReady(page, provider, timeoutMs = TIMEOUTS.navigationMs) {
        const config = PROVIDERS[provider];
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (onLoginUrl(provider, page.url()))
                return;
            if (await this.composer(page, provider).isVisible().catch(() => false))
                return;
            if (await page.locator(config.selectors.loginButton).filter({ visible: true }).first().isVisible().catch(() => false)) {
                return;
            }
            await page.waitForTimeout(TIMEOUTS.responsePollMs).catch(() => { });
        }
        throw new WebChatError(`${config.label} 頁面尚未載入可用的輸入框或登入按鈕。請確認瀏覽器畫面與網路連線。`, "browser_error");
    }
    /** 載入服務頁並確認輸入框可用；沒有輸入框時，依登入狀態回報 logged_out 或 composer_not_found。 */
    async openForUse(provider, timeoutMs) {
        const config = PROVIDERS[provider];
        const page = await this.open(provider, config.askUrl);
        await this.waitForReady(page, provider, timeoutMs);
        if (!(await this.composer(page, provider).isVisible().catch(() => false))) {
            const loggedIn = await this.isLoggedIn(provider);
            if (loggedIn === false) {
                throw new WebChatError(`${config.label} 尚未登入${config.guest ? "且訪客模式不可用" : "（此服務必須登入才能使用）"}：請先呼叫 webchat_login（provider=${provider}）並在瀏覽器中完成登入。`, "logged_out");
            }
            throw new WebChatError(`找不到 ${config.label} 輸入框（UI 變動徵兆）。`, "composer_not_found");
        }
        await this.ensureNotBlocked(page, provider);
        return page;
    }
    /** 需要按鈕才能進入無痕的服務（Gemini）：載入後點擊；訪客沒有此按鈕時略過。 */
    async enterPrivate(page, provider) {
        const config = PROVIDERS[provider];
        if (config.privateMode !== "button" || !config.selectors.privateEnter)
            return;
        if ((await this.isTemporaryChat(provider)) === true)
            return;
        const button = page.locator(config.selectors.privateEnter).filter({ visible: true }).first();
        if (await button.isVisible().catch(() => false)) {
            await button.click({ timeout: 5_000 }).catch(() => { });
            await page.waitForTimeout(1_000);
        }
    }
    /**
     * 在全新的無痕（臨時）聊天送出提示，等待回覆完成後回傳文字。
     * options.model 指定時，先在模型選單切換模型再送出；options.thinking 指定時，接著設定思考深度。
     */
    async ask(provider, prompt, options = {}) {
        const config = PROVIDERS[provider];
        const timeoutMs = options.timeoutMs ?? TIMEOUTS.answerMs;
        const start = Date.now();
        // 每次呼叫都開啟全新的無痕聊天（不留歷史、不延續上一題）
        // 回覆後已預先載好同服務的無痕聊天頁就直接用；否則現載。
        const warm = await this.takeWarm(provider, options);
        let page = warm?.page;
        if (!page) {
            page = await this.openForUse(provider, Math.min(TIMEOUTS.navigationMs, Math.max(1, start + timeoutMs - Date.now())));
            await this.enterPrivate(page, provider);
        }
        const temporaryChat = await this.isTemporaryChat(provider);
        const loggedIn = await this.isLoggedIn(provider);
        // 指定模型時先切換（每題都是新對話，逐題確保模型正確）；預先載入時已經設好同樣的就略過
        if (options.model && warm?.model !== options.model) {
            await this.selectModel(provider, options.model);
        }
        // 思考深度可選的段落會隨模型而異，所以一定在選完模型之後才設定
        if (options.thinking && warm?.thinking !== options.thinking) {
            await this.selectThinking(provider, options.thinking);
        }
        // 輸入提示（composer 為 contenteditable 或 textarea 皆適用）
        const composer = this.composer(page, provider);
        if (!(await composer.isVisible().catch(() => false))) {
            throw new WebChatError(`找不到 ${config.label} 輸入框。`, "composer_not_found");
        }
        await composer.click();
        await page.keyboard.insertText(prompt);
        // 送出鈕在輸入事件後才會出現；等它出現即可送出，不固定睡一段時間（沒出現就退回 Enter）。
        await page
            .locator(config.selectors.sendButton)
            .filter({ visible: true })
            .first()
            .waitFor({ state: "visible", timeout: TIMEOUTS.sendButtonMs })
            .catch(() => { });
        // 必須在送出前記錄基準，否則快速回覆會被當成既有訊息而漏掉。
        const beforeCount = await page.locator(config.selectors.assistantMessage).count();
        // 送出：優先點擊送出按鈕，退回 Enter 鍵
        const sendButton = page.locator(config.selectors.sendButton).filter({ visible: true }).first();
        const clicked = (await sendButton.isVisible().catch(() => false))
            ? await sendButton.click({ timeout: 5_000 }).then(() => true, () => false)
            : false;
        if (!clicked) {
            await page.keyboard.press("Enter");
        }
        // 等待新的助理回覆出現
        const deadline = start + timeoutMs;
        let seenResponse = false;
        while (Date.now() < deadline) {
            if ((await page.locator(config.selectors.assistantMessage).count()) > beforeCount) {
                seenResponse = true;
                break;
            }
            await this.ensureNotBlocked(page, provider);
            await page.waitForTimeout(TIMEOUTS.responsePollMs);
        }
        if (!seenResponse) {
            // 訪客送出後被登入牆擋住（例如 Grok 要求註冊才繼續）：沒有回覆但仍是未登入狀態。
            if (loggedIn === false && (await this.isLoggedIn(provider)) === false) {
                throw new WebChatError(`${config.label} 以訪客身分送出後沒有回覆（疑似被登入牆擋住）。請先呼叫 webchat_login（provider=${provider}）登入。`, "logged_out");
            }
            throw new WebChatError(`送出後 ${Math.round(timeoutMs / 1000)} 秒內未見 ${config.label} 回覆（可能觸發驗證或速率限制）。`, "no_response");
        }
        // 等待回覆穩定：文字連續不變且無停止生成按鈕。看過停止鈕再消失＝明確的完成訊號，只需較少次取樣；
        // 從沒取樣到停止鈕（回覆極短、選擇器改版）時退回較保守的次數。
        let lastText = "";
        let stable = 0;
        let sawGenerating = false;
        let completed = false;
        while (Date.now() < deadline) {
            const text = await this.lastAssistantText(provider);
            const generating = await page
                .locator(config.selectors.stopButton)
                .filter({ visible: true })
                .first()
                .isVisible()
                .catch(() => false);
            if (generating)
                sawGenerating = true;
            if (text && text === lastText && !generating) {
                stable += 1;
                if (stable >= (sawGenerating ? TIMEOUTS.stableChecksAfterStop : TIMEOUTS.stableChecks)) {
                    completed = true;
                    break;
                }
            }
            else {
                stable = 0;
            }
            lastText = text;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            await page.waitForTimeout(Math.min(TIMEOUTS.stableIntervalMs, remaining));
        }
        const answer = await this.lastAssistantText(provider);
        if (!answer) {
            throw new WebChatError("回覆內容為空，無法擷取。", "no_response");
        }
        return { answer, temporaryChat, loggedIn, elapsedMs: Date.now() - start, completed };
    }
    /**
     * 在背景先載入下一個無痕聊天頁，下一題不必再等載入。只對無頭瀏覽器做，且不處理驗證頁
     * （過不了就放棄，不會為了預先載入而跳出視窗）；任何失敗都只是不預先載入，下一題照常載入。
     * 給了 model／thinking 就一併先設好（設定失敗只是不記錄，下一題會自己設並回報正確的錯誤）。
     */
    async prewarm(provider, options = {}) {
        this.warm = null;
        if (!this.context || !this.headless)
            return false;
        try {
            const page = this.requirePage(provider);
            await this.goto(page, PROVIDERS[provider].askUrl, TIMEOUTS.prewarmMs);
            if (!(await waitOutChallenge(page)))
                return false;
            await this.dismissOverlays(page, provider);
            await this.waitForReady(page, provider, TIMEOUTS.prewarmMs);
            if (!(await this.composer(page, provider).isVisible().catch(() => false)))
                return false;
            await this.ensureNotBlocked(page, provider);
            await this.enterPrivate(page, provider);
            const warm = { provider, page, url: page.url() };
            try {
                if (options.model) {
                    await this.selectModel(provider, options.model);
                    warm.model = options.model;
                    if (options.thinking) {
                        await this.selectThinking(provider, options.thinking);
                        warm.thinking = options.thinking;
                    }
                }
            }
            catch {
                // 留下已成功的部分；其餘交給下一題處理
            }
            warm.url = page.url();
            this.warm = warm;
            return true;
        }
        catch {
            this.warm = null;
            return false;
        }
    }
    /**
     * 取走預先載好的頁面；頁面被動過（網址變了、輸入框不見、換了服務），或預先設好的模型／思考深度是這題沒指定的
     * （沒指定＝維持服務目前的設定，不能沿用別題的選擇），就丟棄，回 null 讓呼叫端現載。
     */
    async takeWarm(provider, wanted) {
        const warm = this.warm;
        this.warm = null;
        if (!warm || warm.provider !== provider || warm.page.isClosed() || warm.page.url() !== warm.url)
            return null;
        if ((warm.model && !wanted.model) || (warm.thinking && !wanted.thinking))
            return null;
        if (!(await this.composer(warm.page, provider).isVisible().catch(() => false)))
            return null;
        await this.ensureNotBlocked(warm.page, provider);
        this.page = warm.page;
        return warm;
    }
    /** 關閉瀏覽器並釋放資源。 */
    async close() {
        const context = this.context;
        this.context = null;
        this.page = null;
        this.warm = null;
        if (context) {
            await context.close().catch(() => { });
        }
    }
    /** 列出模型與思考深度（依帳號等級即時擷取，不寫死）。 */
    async listModels(provider) {
        const page = await this.openForUse(provider, TIMEOUTS.navigationMs);
        try {
            return await readMenu(page, provider);
        }
        catch (err) {
            if (err instanceof MenuError)
                throw new WebChatError(err.message, "browser_error");
            throw err;
        }
    }
    /**
     * 列出每個模型各自的思考深度：可選的深度隨模型而異，所以逐一切到該模型再讀選單，最後切回原本的模型。
     * 單一模型讀取失敗只讓它的 thinking 為空，不中斷其餘；服務層級的錯誤（未登入、找不到選單）照常丟出。
     */
    async listModelsDetailed(provider) {
        const { models, thinking } = await this.listModels(provider);
        // 沒有思考設定的 radio 選單服務（如 Grok）逐一切換模型也讀不到東西，直接略過。
        const config = PROVIDERS[provider];
        if (config.menu === "radio" && !config.thinkingMenuItem)
            return models.map((model) => ({ ...model, thinking: [] }));
        const page = this.requirePage(provider);
        const original = models.find((model) => model.current)?.label;
        const detailed = [];
        let switched = false;
        try {
            for (const model of models) {
                if (model.current) {
                    detailed.push({ ...model, thinking });
                    continue;
                }
                let own = [];
                try {
                    if ((await selectModelItem(page, provider, model.label)) !== null) {
                        switched = true;
                        own = (await readMenu(page, provider)).thinking;
                    }
                }
                catch {
                    own = [];
                }
                detailed.push({ ...model, thinking: own });
            }
        }
        finally {
            if (switched && original)
                await selectModelItem(page, provider, original).catch(() => null);
        }
        return detailed;
    }
    /** 切換模型；名單比對不中即回 model_not_found（先呼叫 webchat_models 查看可用清單）。 */
    async selectModel(provider, label) {
        const page = this.requirePage(provider);
        let selected;
        try {
            selected = await selectModelItem(page, provider, label);
        }
        catch (err) {
            if (err instanceof MenuError)
                throw new WebChatError(err.message, "browser_error");
            throw err;
        }
        if (selected === null) {
            throw new WebChatError(`找不到模型「${label}」。請先呼叫 webchat_models 查看可用清單。`, "model_not_found");
        }
        return { selected: true, label: selected };
    }
    /** 設定思考深度；名單比對不中（或此服務沒有思考設定）即回 thinking_not_found（先呼叫 webchat_models 查看 thinking 清單）。 */
    async selectThinking(provider, label) {
        const page = this.requirePage(provider);
        let selected;
        try {
            selected = await selectThinkingItem(page, provider, label);
        }
        catch (err) {
            if (err instanceof MenuError)
                throw new WebChatError(err.message, "browser_error");
            throw err;
        }
        if (selected === null) {
            throw new WebChatError(`找不到思考深度「${label}」（${PROVIDERS[provider].label} 的 thinking 清單沒有它，或此服務沒有思考設定）。請先呼叫 webchat_models 查看 thinking 清單。`, "thinking_not_found");
        }
        return { selected: true, label: selected };
    }
    /** 登入可能開啟新分頁；只接手同一 context 裡屬於該服務的頁面。 */
    currentPage(provider) {
        const pages = this.context?.pages() ?? [];
        if (provider) {
            for (let i = pages.length - 1; i >= 0; i -= 1) {
                const page = pages[i];
                if (!page.isClosed() && providerOfUrl(page.url()) === provider) {
                    this.page = page;
                    return page;
                }
            }
        }
        if (this.page?.isClosed())
            this.page = null;
        return this.page;
    }
    requirePage(provider) {
        const page = this.currentPage(provider);
        if (!page) {
            throw new WebChatError("瀏覽器尚未啟動或分頁已關閉。", "browser_error");
        }
        return page;
    }
    async lastAssistantText(provider) {
        const page = this.requirePage(provider);
        return page.locator(PROVIDERS[provider].selectors.assistantMessage).evaluateAll((messages) => {
            let last = messages[messages.length - 1];
            if (!last)
                return "";
            // 選擇器可能同時命中訊息容器與內部 Markdown；仍須保留整則訊息。
            for (let parent = last.parentElement; parent; parent = parent.parentElement) {
                if (messages.includes(parent))
                    last = parent;
            }
            const markdown = last.matches(".markdown, .prose")
                ? [last]
                : Array.from(last.querySelectorAll(".markdown, .prose"));
            const roots = markdown.filter((node) => !markdown.some((other) => other !== node && other.contains(node)));
            const read = (node) => {
                if (node.nodeType === Node.TEXT_NODE)
                    return node.textContent ?? "";
                if (!(node instanceof HTMLElement))
                    return "";
                const style = getComputedStyle(node);
                if (style.display === "none" || style.visibility === "hidden")
                    return "";
                if (node.tagName === "BR")
                    return "\n";
                if (node.tagName === "PRE") {
                    const code = node.querySelector("code");
                    if (code)
                        return code.innerText;
                }
                if (!node.querySelector("pre code"))
                    return node.innerText;
                let text = "";
                for (const child of node.childNodes) {
                    const block = child instanceof HTMLElement && !getComputedStyle(child).display.startsWith("inline");
                    const value = read(child);
                    text += block ? `\n${value}\n` : value;
                }
                return text;
            };
            return (roots.length ? roots : [last]).map(read).join("\n\n").trim();
        }).catch(() => "");
    }
}
