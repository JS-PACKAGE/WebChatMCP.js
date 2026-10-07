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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext, type JSHandle, type Page } from "playwright";
import { BROWSER, PROVIDERS, providerIds, TIMEOUTS, type ProviderId } from "./config.js";
import { MenuError, readMenu, selectModelItem, selectThinkingItem, type MenuContents, type MenuEntry } from "./providers.js";

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

/**
 * 回覆取樣結果：len 是頁內的完整文字長度（驗證兩邊同步用）。
 * 未變更只回 null；純續寫只回 tail（新增的尾段），其餘改寫才回 text（整份），避免每次取樣重傳全文。
 */
interface TextSample {
  len: number;
  text?: string;
  tail?: string;
}

export class WebChatError extends Error {
  constructor(
    message: string,
    readonly code:
      | "logged_out"
      | "browser_error"
      | "composer_not_found"
      | "send_failed"
      | "timeout"
      | "no_response"
      | "model_not_found"
      | "thinking_not_found",
  ) {
    super(message);
    this.name = "WebChatError";
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(String(signal.reason ?? "aborted"), "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** 只競速唯讀等待；已開始的操作仍接住拒絕，避免取消後產生未處理例外。 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(abortError(signal));
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  });
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Cloudflare 等驗證頁特徵（title 偵測） */
const CHALLENGE_TITLE =
  /just a moment|attention required|checking your browser|verify you are human|請稍候|请稍候|お待ちください/i;

let cachedUserAgent: string | undefined;

/** 瀏覽器建置路徑（含版本目錄）：換瀏覽器版本時 UA 快取就失效。 */
function browserBuildKey(channel: string | undefined): string {
  let build = "";
  try {
    build = chromium.executablePath();
  } catch {
    // 瀏覽器尚未安裝：照常探測，啟動時會回報真正的錯誤
  }
  return `${channel ?? "chromium"}:${build}`;
}

/** UA 探測結果的快取檔（profile 是本程式自己的私人目錄；UA 不是憑證）。 */
const USER_AGENT_CACHE_FILE = join(expandHome(BROWSER.profileDir), ".webchatmcp-ua.json");

function readUserAgentCache(key: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(USER_AGENT_CACHE_FILE, "utf8"));
    return parsed?.key === key && typeof parsed.userAgent === "string" ? parsed.userAgent : null;
  } catch {
    return null;
  }
}

/** 快取只是省一次探測用的瀏覽器啟動；寫入失敗就下次再探測，不影響啟動。 */
function writeUserAgentCache(key: string, userAgent: string): void {
  try {
    mkdirSync(dirname(USER_AGENT_CACHE_FILE), { recursive: true });
    writeFileSync(USER_AGENT_CACHE_FILE, JSON.stringify({ key, userAgent }));
  } catch {
    // 無論如何都不擋住瀏覽器啟動
  }
}

/**
 * 取得本機瀏覽器的 UA 並去掉 "Headless"（版本與實際瀏覽器一致）。
 * 結果記在 profile 目錄：同一個瀏覽器版本不重複啟動探測用的瀏覽器（冷啟動少一次完整啟動）。
 */
async function normalUserAgent(channel: string | undefined): Promise<string> {
  if (cachedUserAgent) return cachedUserAgent;
  const key = browserBuildKey(channel);
  const cached = readUserAgentCache(key);
  if (cached !== null) {
    cachedUserAgent = cached;
    return cachedUserAgent;
  }
  const browser = await chromium.launch({ channel, headless: true });
  try {
    const probe = await browser.newPage();
    const ua = await probe.evaluate(() => navigator.userAgent);
    cachedUserAgent = ua.replace("HeadlessChrome", "Chrome");
  } finally {
    await browser.close();
  }
  writeUserAgentCache(key, cachedUserAgent);
  return cachedUserAgent;
}

function originOf(provider: ProviderId): string {
  return new URL(PROVIDERS[provider].baseUrl).origin;
}

function providerOfUrl(url: string): ProviderId | null {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  return providerIds().find((id) => originOf(id) === origin) ?? null;
}

function onLoginUrl(provider: ProviderId, url: string): boolean {
  const pattern = PROVIDERS[provider].loginUrlPattern;
  return pattern !== null && new RegExp(pattern).test(url);
}

/** 等待驗證頁自動放行；逾時回 false（呼叫端決定語意）。 */
async function waitOutChallenge(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const title = await abortable(page.title().catch(() => ""), signal);
    if (title && !CHALLENGE_TITLE.test(title)) return true;
    await abortable(delay(1_000, undefined, { signal }), signal);
  }
  const title = await abortable(page.title().catch(() => ""), signal);
  return !(title && CHALLENGE_TITLE.test(title));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 回覆後預先載好的無痕聊天頁；model／thinking 是預先設好的值（沒設就沒有） */
interface WarmPage {
  provider: ProviderId;
  page: Page;
  url: string;
  model?: string;
  thinking?: string;
}

export class WebChatSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private headless = BROWSER.headlessDefault;
  /** 回覆後預先載好的下一個無痕聊天頁（見 prewarm）；任何其他導航或關閉瀏覽器都會使它失效 */
  private warm: WarmPage | null = null;
  /** 正在作答的分頁：並行的預載不可關閉或改用它 */
  private asking: Page | null = null;
  /** 預載完成時仍在作答的舊分頁，等那一題結束再關閉 */
  private retiring: Page | null = null;
  /** 預載中、尚未就緒的分頁，不可當成目前頁面 */
  private preparing: Page | null = null;

  get profileDir(): string {
    return expandHome(BROWSER.profileDir);
  }

  get browserRunning(): boolean {
    return this.context !== null;
  }

  /** 目前是否為無頭瀏覽器（可視瀏覽器可能正被使用者操作，不自動關閉也不預先載入） */
  get isHeadless(): boolean {
    return this.headless;
  }

  /** 啟動內建瀏覽器（持久化 profile）。已在執行時重複呼叫為 no-op。 */
  async launch(options: { headless?: boolean } = {}): Promise<void> {
    if (this.context) return;
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
      this.asking = null;
      this.retiring = null;
      this.preparing = null;
    });
  }

  private async goto(page: Page, url: string, timeoutMs: number = TIMEOUTS.navigationMs, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    throwIfAborted(signal);
    await this.waitForPageSignal(page, timeoutMs, signal);
  }

  /** 導航後只等到頁面出現可互動訊號；沒有訊號也不猜，交給後續流程判定。 */
  private async waitForPageSignal(page: Page, timeoutMs: number = TIMEOUTS.postNavigationMs, signal?: AbortSignal): Promise<void> {
    const provider = providerOfUrl(page.url());
    if (!provider) return;
    const { composer, loginButton } = PROVIDERS[provider].selectors;
    const ready = page.locator(composer).or(page.locator(loginButton)).filter({ visible: true }).first();
    const deadline = Date.now() + Math.min(TIMEOUTS.postNavigationMs, timeoutMs);
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (page.isClosed() || onLoginUrl(provider, page.url())) return;
      if (await abortable(ready.waitFor({
        state: "visible", timeout: Math.min(TIMEOUTS.waitSliceMs, Math.max(1, deadline - Date.now())),
      }).then(() => true, () => false), signal)) return;
    }
  }

  /**
   * 導航至指定服務的網址，處理驗證頁並略過升級／提示對話框。
   * 無頭模式過不了驗證頁（Cloudflare）時，暫時改用可視瀏覽器等它放行，通關結果存在 profile，之後即可回到無頭。
   */
  private async open(provider: ProviderId, url: string, signal?: AbortSignal): Promise<Page> {
    throwIfAborted(signal);
    this.warm = null;
    let page = this.requirePage(provider);
    await this.goto(page, url, TIMEOUTS.navigationMs, signal);
    if (!(await waitOutChallenge(page, undefined, signal))) {
      page = await this.passChallenge(provider, url, signal);
    }
    await this.dismissOverlays(page, provider, signal);
    return page;
  }

  private async passChallenge(provider: ProviderId, url: string, signal?: AbortSignal): Promise<Page> {
    const failure = new WebChatError(
      `${PROVIDERS[provider].label} 停留在驗證（Cloudflare challenge）畫面。請在已開啟的瀏覽器視窗中完成驗證後重試，` +
        `或設定 ${BROWSER.env.headless}=0 以可視模式啟動。`,
      "browser_error",
    );
    const hideAfter = this.headless && BROWSER.headlessDefault;
    throwIfAborted(signal);
    if (hideAfter) {
      await this.close();
      throwIfAborted(signal);
      await this.launch({ headless: false });
      await this.goto(this.requirePage(), url, TIMEOUTS.navigationMs, signal);
    }
    const visiblePage = this.requirePage(provider);
    if (!(await waitOutChallenge(visiblePage, TIMEOUTS.challengeMs, signal))) throw failure;
    if (!hideAfter) return visiblePage;
    throwIfAborted(signal);
    await this.close();
    throwIfAborted(signal);
    await this.launch();
    const page = this.requirePage();
    await this.goto(page, url, TIMEOUTS.navigationMs, signal);
    if (!(await waitOutChallenge(page, undefined, signal))) throw failure;
    return page;
  }

  /** 略過會擋住畫面的升級／提示對話框（不代使用者做任何同意或填寫）。 */
  private async dismissOverlays(page: Page, provider: ProviderId, signal?: AbortSignal): Promise<void> {
    const dismiss = PROVIDERS[provider].selectors.dismiss;
    if (!dismiss.length) return;
    const button = page.locator(dismiss.join(", ")).filter({ visible: true }).first();
    for (let i = 0; i < dismiss.length; i += 1) {
      throwIfAborted(signal);
      if (!(await abortable(button.isVisible().catch(() => false), signal))) break;
      throwIfAborted(signal);
      await button.click({ timeout: 3_000 }).catch(() => {});
      await abortable(button.waitFor({ state: "hidden", timeout: TIMEOUTS.waitSliceMs }).catch(() => {}), signal);
    }
  }

  /** 出現需要使用者本人處理的對話框（例如年齡確認）時回報錯誤。 */
  private async ensureNotBlocked(page: Page, provider: ProviderId): Promise<void> {
    const selector = PROVIDERS[provider].selectors.blocking;
    if (selector && (await page.locator(selector).first().isVisible().catch(() => false))) {
      throw new WebChatError(
        `${PROVIDERS[provider].label} 跳出需要本人處理的對話框（例如年齡確認）。請呼叫 webchat_login（provider=${provider}）在可視瀏覽器中完成，之後即可使用。`,
        "browser_error",
      );
    }
  }

  private composer(page: Page, provider: ProviderId) {
    return page.locator(PROVIDERS[provider].selectors.composer).filter({ visible: true }).first();
  }

  /** 判定登入狀態：登入按鈕可見＝未登入（訪客）；否則以可見輸入框確認；找不到指標回 unknown。 */
  async isLoggedIn(provider: ProviderId): Promise<TriState> {
    const page = this.currentPage(provider);
    return page ? this.loginState(page, provider) : "unknown";
  }

  /** 同 isLoggedIn，但檢查指定分頁（作答中的頁面與並行預載的頁面可能同時存在）。 */
  private async loginState(page: Page, provider: ProviderId): Promise<TriState> {
    const config = PROVIDERS[provider];
    try {
      if (onLoginUrl(provider, page.url())) return false;
      if (providerOfUrl(page.url()) !== provider) return "unknown";
      const [loginVisible, composerVisible] = await Promise.all([
        page.locator(config.selectors.loginButton).filter({ visible: true }).first().isVisible(),
        this.composer(page, provider).isVisible(),
      ]);
      if (loginVisible) return false;
      if (composerVisible) return true;
      if (config.loggedOutIndicators.length > 0 && await page.evaluate((markers) => {
        const text = document.body?.innerText ?? "";
        return markers.some((marker) => text.includes(marker));
      }, config.loggedOutIndicators)) return false;
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** 判定目前頁面是否為無痕（臨時）聊天模式。 */
  async isTemporaryChat(provider: ProviderId): Promise<TriState> {
    const page = this.currentPage(provider);
    return page ? this.temporaryState(page, provider) : "unknown";
  }

  /** 同 isTemporaryChat，但檢查指定分頁。 */
  private async temporaryState(page: Page, provider: ProviderId): Promise<TriState> {
    if (providerOfUrl(page.url()) !== provider) return "unknown";
    const config = PROVIDERS[provider];
    try {
      if (
        config.selectors.privateActive &&
        (await page.locator(config.selectors.privateActive).first().isVisible())
      ) {
        return true;
      }
      // 沒有指標字的服務不必取整頁文字（Gemini 進入臨時對話時每 50ms 檢查一次）。
      if (config.privateIndicators.length > 0 && await page.evaluate((markers) => {
        const text = document.body?.innerText ?? "";
        return markers.some((marker) => text.includes(marker));
      }, config.privateIndicators)) return true;
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * 同步狀態（不探測頁面；登入／臨時聊天一律 unknown，探測版見 statusAsync）。
   */
  status(): SessionStatus {
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
  async statusAsync(provider?: ProviderId): Promise<SessionStatus> {
    const target = provider ?? this.latestProvider();
    const page = target ? this.currentPage(target) : null;
    const [loggedIn, temporaryChat] = this.browserRunning && target
      ? await Promise.all([this.isLoggedIn(target), this.isTemporaryChat(target)])
      : ["unknown", "unknown"] as const;
    return {
      browserRunning: this.browserRunning,
      provider: target,
      loggedIn,
      temporaryChat,
      profileDir: this.profileDir,
      currentUrl: (page ?? this.currentPage())?.url() ?? null,
    };
  }

  /** 最近開啟的分頁所屬的服務（不限定特定 provider）。 */
  private latestProvider(): ProviderId | null {
    const pages = this.context?.pages() ?? [];
    for (let i = pages.length - 1; i >= 0; i -= 1) {
      if (pages[i] === this.preparing || pages[i].isClosed()) continue;
      const found = providerOfUrl(pages[i].url());
      if (found) return found;
    }
    return null;
  }

  /**
   * 等待人工登入完成。逾時不視為錯誤：瀏覽器保持開啟，回傳目前狀態。
   */
  async waitForLogin(
    provider: ProviderId,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ loggedIn: TriState; elapsedMs: number }> {
    throwIfAborted(signal);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = await abortable(this.isLoggedIn(provider), signal);
      if (state === true) return { loggedIn: true, elapsedMs: Date.now() - start };
      await abortable(delay(Math.min(TIMEOUTS.loginPollMs, Math.max(0, timeoutMs - (Date.now() - start))), undefined, { signal }), signal);
    }
    return { loggedIn: await abortable(this.isLoggedIn(provider), signal), elapsedMs: Date.now() - start };
  }

  /** 在目前瀏覽器開啟服務首頁並探測登入狀態；驗證頁或載入失敗一律視為 unknown。 */
  private async probeLogin(provider: ProviderId, signal?: AbortSignal): Promise<TriState> {
    try {
      const page = await this.open(provider, PROVIDERS[provider].baseUrl, signal);
      await this.waitForReady(page, provider, TIMEOUTS.navigationMs, signal);
      return await abortable(this.isLoggedIn(provider), signal);
    } catch (err) {
      if (err instanceof WebChatError) return "unknown";
      throw err;
    }
  }

  /** 已確認登入後，預設為無頭時把可視瀏覽器收回無頭（登入狀態在 profile，不需再看到 UI）。 */
  private async hideBrowser(provider: ProviderId, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.headless || !BROWSER.headlessDefault) return;
    await this.close();
    throwIfAborted(signal);
    await this.launch();
    await this.probeLogin(provider, signal);
  }

  /**
   * 登入流程：先以（預設無頭的）瀏覽器查詢是否已登入，已登入就直接回傳；
   * 未登入或無法判定（例如停在 Cloudflare 驗證頁）才切換為可視瀏覽器等待人工登入。
   * 人工登入成功後若預設為無頭，會把瀏覽器切回無頭，不留視窗。
   */
  async login(
    provider: ProviderId,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ loggedIn: TriState; elapsedMs: number; alreadyLoggedIn: boolean }> {
    throwIfAborted(signal);
    const start = Date.now();
    await this.launch();
    throwIfAborted(signal);
    if ((await this.probeLogin(provider, signal)) === true) {
      throwIfAborted(signal);
      await this.hideBrowser(provider, signal);
      throwIfAborted(signal);
      return { loggedIn: true, elapsedMs: Date.now() - start, alreadyLoggedIn: true };
    }

    throwIfAborted(signal);
    if (this.headless) {
      await this.close();
      throwIfAborted(signal);
      await this.launch({ headless: false });
      await this.open(provider, PROVIDERS[provider].baseUrl, signal);
    }
    const waited = await this.waitForLogin(provider, Math.max(0, timeoutMs - (Date.now() - start)), signal);
    throwIfAborted(signal);
    if (waited.loggedIn === true) await this.hideBrowser(provider, signal);
    throwIfAborted(signal);
    return { loggedIn: waited.loggedIn, elapsedMs: Date.now() - start, alreadyLoggedIn: false };
  }

  /**
   * 登出：清除該服務網域的 cookie（不讀取 cookie 內容），再重新探測登入狀態。
   * 不需要畫面；瀏覽器未啟動時以預設（無頭）模式啟動。
   */
  async logout(provider: ProviderId): Promise<{ domains: readonly string[]; loggedIn: TriState }> {
    await this.launch();
    const context = this.context;
    if (!context) throw new WebChatError("瀏覽器尚未啟動。", "browser_error");
    const domains = PROVIDERS[provider].domains;
    for (const domain of domains) {
      await context.clearCookies({ domain: new RegExp(`(^|\\.)${escapeRegExp(domain)}$`) });
    }
    return { domains, loggedIn: await this.probeLogin(provider) };
  }

  /** 等待輸入框、登入按鈕或登入頁其一出現（頁面已可操作）。 */
  private async waitForReady(
    page: Page,
    provider: ProviderId,
    timeoutMs: number = TIMEOUTS.navigationMs,
    signal?: AbortSignal,
  ): Promise<void> {
    const config = PROVIDERS[provider];
    const ready = page.locator(config.selectors.composer).or(page.locator(config.selectors.loginButton))
      .filter({ visible: true }).first();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (page.isClosed()) throw new WebChatError("頁面已關閉。", "browser_error");
      if (onLoginUrl(provider, page.url())) return;
      if (await abortable(ready.waitFor({
        state: "visible", timeout: Math.min(TIMEOUTS.waitSliceMs, Math.max(1, deadline - Date.now())),
      }).then(() => true, () => false), signal)) return;
    }
    throw new WebChatError(
      `${config.label} 頁面尚未載入可用的輸入框或登入按鈕。請確認瀏覽器畫面與網路連線。`,
      "browser_error",
    );
  }

  /** 載入服務頁並確認輸入框可用；沒有輸入框時，依登入狀態回報 logged_out 或 composer_not_found。 */
  private async openForUse(provider: ProviderId, timeoutMs: number, signal?: AbortSignal): Promise<Page> {
    const config = PROVIDERS[provider];
    const page = await this.open(provider, config.askUrl, signal);
    await this.waitForReady(page, provider, timeoutMs, signal);
    if (!(await abortable(this.composer(page, provider).isVisible().catch(() => false), signal))) {
      const loggedIn = await abortable(this.loginState(page, provider), signal);
      if (loggedIn === false) {
        throw new WebChatError(
          `${config.label} 尚未登入${config.guest ? "且訪客模式不可用" : "（此服務必須登入才能使用）"}：請先呼叫 webchat_login（provider=${provider}）並在瀏覽器中完成登入。`,
          "logged_out",
        );
      }
      throw new WebChatError(`找不到 ${config.label} 輸入框（UI 變動徵兆）。`, "composer_not_found");
    }
    await abortable(this.ensureNotBlocked(page, provider), signal);
    return page;
  }

  /** 需要按鈕才能進入無痕的服務（Gemini）：載入後點擊；訪客沒有此按鈕時略過。 */
  private async enterPrivate(page: Page, provider: ProviderId, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const config = PROVIDERS[provider];
    if (config.privateMode !== "button" || !config.selectors.privateEnter) return;
    if ((await abortable(this.temporaryState(page, provider), signal)) === true) return;
    const button = page.locator(config.selectors.privateEnter).filter({ visible: true }).first();
    if (await abortable(button.isVisible().catch(() => false), signal)) {
      throwIfAborted(signal);
      await button.click({ timeout: 5_000 }).catch(() => {});
      const deadline = Date.now() + TIMEOUTS.privateEnterMs;
      while (Date.now() < deadline) {
        if ((await abortable(this.temporaryState(page, provider), signal)) === true) return;
        await abortable(delay(Math.min(TIMEOUTS.privatePollMs, Math.max(0, deadline - Date.now())), undefined, { signal }), signal);
      }
    }
  }

  /**
   * 在全新的無痕（臨時）聊天送出提示，等待回覆完成後回傳文字。
   * options.model 指定時，先在模型選單切換模型再送出；options.thinking 指定時，接著設定思考深度。
   * options.onSent 在提示確定送出後同步呼叫一次（排程器藉此在等待回覆時並行預載下一頁）。
   */
  async ask(
    provider: ProviderId,
    prompt: string,
    options: { timeoutMs?: number; model?: string; thinking?: string; signal?: AbortSignal; onSent?: () => void } = {},
  ): Promise<AskResult> {
    const signal = options.signal;
    throwIfAborted(signal);
    const config = PROVIDERS[provider];
    const timeoutMs = options.timeoutMs ?? TIMEOUTS.answerMs;
    const start = Date.now();
    let page: Page | undefined;
    let sent = false;
    let textReader: JSHandle<(messages: Element[], full?: boolean) => TextSample | null> | undefined;
    try {
      // 每次呼叫都開啟全新的無痕聊天；預載頁也只取用一次。
      const warm = await this.takeWarm(provider, options);
      throwIfAborted(signal);
      page = warm?.page;
      if (!page) {
        page = await this.openForUse(
          provider,
          Math.min(TIMEOUTS.navigationMs, Math.max(1, start + timeoutMs - Date.now())),
          signal,
        );
        throwIfAborted(signal);
        await this.enterPrivate(page, provider, signal);
      }
      this.asking = page;
      throwIfAborted(signal);
      const [temporaryChat, loggedIn] = await abortable(Promise.all([
        this.temporaryState(page, provider), this.loginState(page, provider),
      ]), signal);
      throwIfAborted(signal);

      // 預載時設好同樣的模型／思考深度就略過；思考深度必須在模型之後設定。
      if (options.model && warm?.model !== options.model) {
        await this.selectModel(provider, options.model, page);
        throwIfAborted(signal);
      }
      if (options.thinking && (warm?.thinking !== options.thinking || (options.model && warm?.model !== options.model))) {
        await this.selectThinking(provider, options.thinking, page);
        throwIfAborted(signal);
      }

      const composer = this.composer(page, provider);
      if (!(await abortable(composer.isVisible().catch(() => false), signal))) {
        throw new WebChatError(`找不到 ${config.label} 輸入框。`, "composer_not_found");
      }
      throwIfAborted(signal);
      await composer.click();
      throwIfAborted(signal);
      await page.keyboard.insertText(prompt);
      const sendButton = page.locator(config.selectors.sendButton).filter({ visible: true }).first();
      await abortable(sendButton.waitFor({ state: "visible", timeout: TIMEOUTS.sendButtonMs }).catch(() => {}), signal);

      // 送出前記錄基準，避免同步完成的快速回覆被當成舊訊息。
      const messages = page.locator(config.selectors.assistantMessage);
      const beforeCount = await abortable(messages.count(), signal);
      const sendVisible = await abortable(sendButton.isVisible().catch(() => false), signal);
      throwIfAborted(signal);
      // Playwright 若在派送點擊後才失敗，取消時也要盡力停止可能已送出的生成。
      sent = sendVisible;
      const clicked = sendVisible
        ? await sendButton.click({ timeout: 5_000 }).then(() => true, () => false)
        : false;
      if (!clicked) {
        throwIfAborted(signal);
        sent = true;
        await page.keyboard.press("Enter");
      }
      throwIfAborted(signal);
      const sentAt = Date.now();
      try {
        options.onSent?.();
      } catch {
        // 預載排程失敗不影響這一題
      }

      const deadline = start + timeoutMs;
      const response = messages.nth(beforeCount);
      let seenResponse = false;
      while (Date.now() < deadline) {
        throwIfAborted(signal);
        if (await abortable(response.waitFor({
          state: "attached", timeout: Math.min(TIMEOUTS.waitSliceMs, Math.max(1, deadline - Date.now())),
        }).then(() => true, () => false), signal)) {
          seenResponse = true;
          break;
        }
        await abortable(this.ensureNotBlocked(page, provider), signal);
        if (loggedIn === false && !config.guest && Date.now() - sentAt >= TIMEOUTS.guestWallMs &&
          (await abortable(this.loginState(page, provider), signal)) === false) {
          throw new WebChatError(
            `${config.label} 以訪客身分送出後沒有回覆（疑似被登入牆擋住）。請先呼叫 webchat_login（provider=${provider}）登入。`,
            "logged_out",
          );
        }
      }
      if (!seenResponse) {
        // 訪客送出後被登入牆擋住：保留原有逾時判定。
        if (loggedIn === false && (await abortable(this.loginState(page, provider), signal)) === false) {
          throw new WebChatError(
            `${config.label} 以訪客身分送出後沒有回覆（疑似被登入牆擋住）。請先呼叫 webchat_login（provider=${provider}）登入。`,
            "logged_out",
          );
        }
        throw new WebChatError(
          `送出後 ${Math.round(timeoutMs / 1000)} 秒內未見 ${config.label} 回覆（可能觸發驗證或速率限制）。`,
          "no_response",
        );
      }

      // 生成中不反覆擷取全文，只等停止鈕消失：優先在頁面內每個畫格檢查（整段等待只有一次協定呼叫，消失後立刻繼續）；
      // 選擇器不是純 CSS、或頁面內判定與 Playwright 的可見判定不一致時，改回每 stableIntervalMs 輪詢一次。
      // 停止鈕消失後仍保留原本的連續穩定取樣安全邊界。
      const stop = page.locator(config.selectors.stopButton).filter({ visible: true }).first();
      // 擷取函式與上一份文字留在頁面內；取樣未變更只回 null、續寫只回尾段，不重傳全文或函式。
      textReader = await this.assistantTextReader(page);
      // 尾段與頁內長度對不上（觀測失敗過、兩邊不同步）才整份取回，避免把文字接錯底。
      const applySample = async (base: string, sample: TextSample): Promise<string> => {
        if (sample.tail === undefined) return sample.text ?? "";
        if (base.length + sample.tail.length === sample.len) return base + sample.tail;
        const fresh = await abortable(
          messages.evaluateAll((elements, read) => read(elements, true), textReader).catch(() => undefined),
          signal,
        );
        return fresh ? (fresh.text ?? "") : base;
      };
      let lastText = "";
      let stable = 0;
      let sawGenerating = false;
      let completed = false;
      let inPageWait = true;
      let waitedInPage = false;
      while (Date.now() < deadline) {
        const [sample, generating] = await abortable(Promise.all([
          messages.evaluateAll((elements, read) => read(elements), textReader).catch(() => undefined),
          stop.isVisible().catch(() => false),
        ]), signal);
        if (sample === undefined) {
          // 失敗的觀測不算穩定，也不能清掉仍與頁內快取相符的上一份文字。
          stable = 0;
          await abortable(delay(Math.min(TIMEOUTS.stableIntervalMs, Math.max(0, deadline - Date.now())), undefined, { signal }), signal);
          continue;
        }
        const changed = sample !== null;
        if (changed) lastText = await applySample(lastText, sample);
        if (generating) {
          sawGenerating = true;
          stable = 0;
          // 頁面內判定已消失、Playwright 卻仍看得到：改回輪詢，避免空轉。
          if (waitedInPage) inPageWait = false;
          waitedInPage = false;
          if (inPageWait) {
            waitedInPage = await abortable(page.waitForFunction((selector) => {
              for (const element of document.querySelectorAll(selector)) {
                const box = element.getBoundingClientRect();
                if (box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden") return false;
              }
              return true;
            }, config.selectors.stopButton, { polling: "raf", timeout: Math.max(1, deadline - Date.now()) }).then(() => true, () => false), signal);
            if (!waitedInPage) inPageWait = false;
            continue;
          }
          do {
            await abortable(delay(Math.min(TIMEOUTS.stableIntervalMs, Math.max(0, deadline - Date.now())), undefined, { signal }), signal);
          } while (Date.now() < deadline && await abortable(stop.isVisible().catch(() => false), signal));
          continue;
        }
        waitedInPage = false;
        // 未變更且頁內已有文字才算穩定；空白只是還沒開始輸出，不能當成完成。
        if (!changed && lastText !== "") {
          stable += 1;
          if (stable >= (sawGenerating ? TIMEOUTS.stableChecksAfterStop : TIMEOUTS.stableChecks)) {
            completed = true;
            break;
          }
        } else {
          stable = 0;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await abortable(delay(Math.min(TIMEOUTS.stableIntervalMs, remaining), undefined, { signal }), signal);
      }

      if (!completed) {
        // 逾時也再取樣一次：補上最後一刻的變更，回傳的才是目前最新的內容。
        const final = await abortable(
          messages.evaluateAll((elements, read) => read(elements), textReader).catch(() => undefined),
          signal,
        );
        if (final) lastText = await applySample(lastText, final);
      }
      const answer = lastText;
      throwIfAborted(signal);
      if (!answer) throw new WebChatError("回覆內容為空，無法擷取。", "no_response");
      return { answer, temporaryChat, loggedIn, elapsedMs: Date.now() - start, completed };
    } catch (err) {
      if (signal?.aborted) {
        if (sent && page) {
          const stop = page.locator(config.selectors.stopButton).filter({ visible: true }).first();
          if (await stop.isVisible().catch(() => false)) {
            await stop.click({ timeout: TIMEOUTS.cancelStopMs }).catch(() => {});
          }
        }
        throw abortError(signal);
      }
      throw err;
    } finally {
      await textReader?.dispose().catch(() => {});
      if (this.asking === page) this.asking = null;
      // 並行預載已接手成為目前頁面：這一題用完的分頁直接關閉，不等關閉完成才回覆。
      if (page && this.retiring === page) {
        this.retiring = null;
        void page.close().catch(() => {});
      }
    }
  }

  /**
   * 在背景先載入下一個無痕聊天頁，下一題不必再等載入。只對無頭瀏覽器做，且不處理驗證頁
   * （過不了就放棄，不會為了預先載入而跳出視窗）；任何失敗都只是不預先載入，下一題照常載入。
   * 給了 model／thinking 就一併先設好（設定失敗只是不記錄，下一題會自己設並回報正確的錯誤）。
   * 可與作答中的 ask 並行：只操作自己的新分頁，完成前不會成為目前頁面，作答中的舊分頁等那一題結束才關閉。
   */
  async prewarm(
    provider: ProviderId,
    options: { model?: string; thinking?: string; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const context = this.context;
    const signal = options.signal;
    if (!context || !this.headless || signal?.aborted) return false;
    if (this.warm?.model === options.model && this.warm?.thinking === options.thinking) {
      try {
        const warm = await this.takeWarm(provider, options);
        if (warm) {
          this.warm = warm;
          return true;
        }
      } catch {
        return false;
      }
    }
    this.warm = null;
    const previous = this.currentPage(provider);
    let page: Page | null = null;
    let ready: WarmPage | null = null;
    // 用獨立分頁預載，取消時關掉它以中斷導航／選單等待，不破壞原頁面。
    const cancel = () => { void page?.close().catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      page = await context.newPage();
      this.preparing = page;
      if (signal?.aborted) return false;
      await this.goto(page, PROVIDERS[provider].askUrl, TIMEOUTS.prewarmMs);
      if (signal?.aborted || CHALLENGE_TITLE.test(await page.title())) return false;
      await this.dismissOverlays(page, provider);
      if (signal?.aborted) return false;
      await this.waitForReady(page, provider, TIMEOUTS.prewarmMs);
      if (signal?.aborted || !(await this.composer(page, provider).isVisible().catch(() => false))) return false;
      await this.ensureNotBlocked(page, provider);
      if (signal?.aborted) return false;
      await this.enterPrivate(page, provider);
      if (signal?.aborted) return false;
      const warm: WarmPage = { provider, page, url: page.url() };
      try {
        if (options.model) {
          await this.selectModel(provider, options.model, page);
          if (signal?.aborted) return false;
          warm.model = options.model;
        }
        if (options.thinking) {
          await this.selectThinking(provider, options.thinking, page);
          if (signal?.aborted) return false;
          warm.thinking = options.thinking;
        }
      } catch {
        // 留下已成功的部分；其餘交給下一題處理
      }
      if (signal?.aborted) return false;
      warm.url = page.url();
      ready = warm;
    } catch {
      ready = null;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (this.preparing === page) this.preparing = null;
      if (!ready || signal?.aborted) {
        await page?.close().catch(() => {});
      } else {
        this.page = page;
        this.warm = ready;
        if (previous && previous !== page) {
          if (previous === this.asking) this.retiring = previous;
          else await previous.close().catch(() => {});
        }
      }
    }
    return this.warm !== null;
  }

  /**
   * 取走預先載好的頁面；頁面被動過（網址變了、輸入框不見、換了服務），或預先設好的模型／思考深度是這題沒指定的
   * （沒指定＝維持服務目前的設定，不能沿用別題的選擇），就丟棄，回 null 讓呼叫端現載。
   */
  private async takeWarm(
    provider: ProviderId,
    wanted: { model?: string; thinking?: string; signal?: AbortSignal },
  ): Promise<WarmPage | null> {
    const warm = this.warm;
    this.warm = null;
    if (!warm || warm.provider !== provider || warm.page.isClosed() || warm.page.url() !== warm.url) return null;
    if ((warm.model && !wanted.model) || (warm.thinking && !wanted.thinking)) return null;
    if (!(await abortable(this.composer(warm.page, provider).isVisible().catch(() => false), wanted.signal))) return null;
    await abortable(this.ensureNotBlocked(warm.page, provider), wanted.signal);
    throwIfAborted(wanted.signal);
    this.page = warm.page;
    return warm;
  }

  /** 關閉瀏覽器並釋放資源。 */
  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.warm = null;
    this.asking = null;
    this.retiring = null;
    this.preparing = null;
    if (context) {
      await context.close().catch(() => {});
    }
  }

  /** 列出模型與思考深度（依帳號等級即時擷取，不寫死）。 */
  async listModels(provider: ProviderId): Promise<MenuContents> {
    const page = await this.openForUse(provider, TIMEOUTS.navigationMs);
    try {
      return await readMenu(page, provider);
    } catch (err) {
      if (err instanceof MenuError) throw new WebChatError(err.message, "browser_error");
      throw err;
    }
  }

  /**
   * 列出每個模型各自的思考深度：可選的深度隨模型而異，所以逐一切到該模型再讀選單，最後切回原本的模型。
   * 單一模型讀取失敗只讓它的 thinking 為空，不中斷其餘；服務層級的錯誤（未登入、找不到選單）照常丟出。
   */
  async listModelsDetailed(provider: ProviderId): Promise<Array<MenuEntry & { thinking: MenuEntry[] }>> {
    const { models, thinking } = await this.listModels(provider);
    // 沒有思考設定的 radio 選單服務（如 Grok）逐一切換模型也讀不到東西，直接略過。
    const config = PROVIDERS[provider];
    if (config.menu === "radio" && !config.thinkingMenuItem) return models.map((model) => ({ ...model, thinking: [] }));
    const page = this.requirePage(provider);
    const original = models.find((model) => model.current)?.label;
    const detailed: Array<MenuEntry & { thinking: MenuEntry[] }> = [];
    let switched = false;
    try {
      for (const model of models) {
        if (model.current) {
          detailed.push({ ...model, thinking });
          continue;
        }
        let own: MenuEntry[] = [];
        try {
          if ((await selectModelItem(page, provider, model.label)) !== null) {
            switched = true;
            own = (await readMenu(page, provider)).thinking;
          }
        } catch {
          own = [];
        }
        detailed.push({ ...model, thinking: own });
      }
    } finally {
      if (switched && original) await selectModelItem(page, provider, original).catch(() => null);
    }
    return detailed;
  }

  /** 切換模型；名單比對不中即回 model_not_found（先呼叫 webchat_models 查看可用清單）。 */
  async selectModel(
    provider: ProviderId,
    label: string,
    page: Page = this.requirePage(provider),
  ): Promise<{ selected: boolean; label: string }> {
    let selected: string | null;
    try {
      selected = await selectModelItem(page, provider, label);
    } catch (err) {
      if (err instanceof MenuError) throw new WebChatError(err.message, "browser_error");
      throw err;
    }
    if (selected === null) {
      throw new WebChatError(
        `找不到模型「${label}」。請先呼叫 webchat_models 查看可用清單。`,
        "model_not_found",
      );
    }
    return { selected: true, label: selected };
  }

  /** 設定思考深度；名單比對不中（或此服務沒有思考設定）即回 thinking_not_found（先呼叫 webchat_models 查看 thinking 清單）。 */
  async selectThinking(
    provider: ProviderId,
    label: string,
    page: Page = this.requirePage(provider),
  ): Promise<{ selected: boolean; label: string }> {
    let selected: string | null;
    try {
      selected = await selectThinkingItem(page, provider, label);
    } catch (err) {
      if (err instanceof MenuError) throw new WebChatError(err.message, "browser_error");
      throw err;
    }
    if (selected === null) {
      throw new WebChatError(
        `找不到思考深度「${label}」（${PROVIDERS[provider].label} 的 thinking 清單沒有它，或此服務沒有思考設定）。請先呼叫 webchat_models 查看 thinking 清單。`,
        "thinking_not_found",
      );
    }
    return { selected: true, label: selected };
  }

  /** 登入可能開啟新分頁；只接手同一 context 裡屬於該服務的頁面（預載中尚未就緒的分頁除外）。 */
  private currentPage(provider?: ProviderId): Page | null {
    const pages = this.context?.pages() ?? [];
    if (provider) {
      for (let i = pages.length - 1; i >= 0; i -= 1) {
        const page = pages[i];
        if (page !== this.preparing && !page.isClosed() && providerOfUrl(page.url()) === provider) {
          this.page = page;
          return page;
        }
      }
    }
    if (this.page?.isClosed()) this.page = null;
    return this.page;
  }

  private requirePage(provider?: ProviderId): Page {
    const page = this.currentPage(provider);
    if (!page) {
      throw new WebChatError("瀏覽器尚未啟動或分頁已關閉。", "browser_error");
    }
    return page;
  }

  private assistantTextReader(page: Page): Promise<JSHandle<(messages: Element[], full?: boolean) => TextSample | null>> {
    return page.evaluateHandle(() => {
      let previous = "";
      return (messages: Element[], full?: boolean): TextSample | null => {
        let last = messages[messages.length - 1];
        if (!last) {
          previous = "";
          return { len: 0, text: "" };
        }
        const messageSet = new Set(messages);
        // 選擇器可能同時命中訊息容器與內部 Markdown；仍須保留整則訊息。
        for (let parent = last.parentElement; parent; parent = parent.parentElement) {
          if (messageSet.has(parent)) last = parent;
        }
        const markdown = last.matches(".markdown, .prose")
          ? [last]
          : Array.from(last.querySelectorAll(".markdown, .prose"));
        // querySelectorAll 是文件順序；後續巢狀 Markdown 只可能屬於最近的根。
        const roots: Element[] = [];
        for (const node of markdown) {
          if (!roots.length || !roots[roots.length - 1].contains(node)) roots.push(node);
        }
        // 每輪只搜尋一次程式碼，避免遞迴每一層都重新掃描整個子樹。
        const hasCode = new Set<Element>();
        for (const code of last.querySelectorAll("pre code")) {
          for (let parent = code.parentElement; parent; parent = parent.parentElement) {
            if (hasCode.has(parent)) break;
            hasCode.add(parent);
            if (parent === last) break;
          }
        }
        const styles = new Map<HTMLElement, CSSStyleDeclaration>();
        const styleOf = (node: HTMLElement): CSSStyleDeclaration => {
          let style = styles.get(node);
          if (!style) {
            style = getComputedStyle(node);
            styles.set(node, style);
          }
          return style;
        };
        const read = (node: Node): string => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
          if (!(node instanceof HTMLElement)) return "";
          const style = styleOf(node);
          if (style.display === "none" || style.visibility === "hidden") return "";
          if (node.tagName === "BR") return "\n";
          if (node.tagName === "PRE") {
            const code = node.querySelector("code");
            if (code) return code.innerText;
          }
          if (!hasCode.has(node)) return node.innerText;
          let text = "";
          for (const child of node.childNodes) {
            const block = child instanceof HTMLElement && !styleOf(child).display.startsWith("inline");
            const value = read(child);
            text += block ? `\n${value}\n` : value;
          }
          return text;
        };
        const text = (roots.length ? roots : [last]).map(read).join("\n\n").trim();
        if (full) {
          previous = text;
          return { len: text.length, text };
        }
        if (text === previous) {
          // 空白不算穩定（可能只是還沒開始輸出），要繼續觀察；其餘未變更只回短標記。
          return text === "" ? { len: 0, text: "" } : null;
        }
        // 純續寫只回新增的尾段，其餘改寫才回全文；len 是完整文字長度，供呼叫端驗證兩邊同步。
        const sample =
          previous !== "" && text.startsWith(previous)
            ? { len: text.length, tail: text.slice(previous.length) }
            : { len: text.length, text };
        previous = text;
        return sample;
      };
    });
  }
}
