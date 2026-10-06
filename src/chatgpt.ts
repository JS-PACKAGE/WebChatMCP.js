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
import { chromium, type BrowserContext, type Page } from "playwright";
import { BROWSER, CHATGPT, TIMEOUTS } from "./config.js";

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
      | "model_not_found",
  ) {
    super(message);
    this.name = "WebChatError";
  }
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Cloudflare 等驗證頁特徵（title 偵測） */
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|verify you are human/i;

const CHATGPT_ORIGIN = new URL(CHATGPT.baseUrl).origin;
const COMPOSER_SELECTOR = `${CHATGPT.selectors.composer}:visible, ${CHATGPT.selectors.composerAlt}:visible`;
const READY_SELECTOR = `${COMPOSER_SELECTOR}, ${CHATGPT.selectors.loginButton}:visible`;

/** 等待驗證頁自動放行；逾時回 false（呼叫端決定語意）。 */
async function waitOutChallenge(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => "");
    if (title && !CHALLENGE_TITLE.test(title)) return true;
    await page.waitForTimeout(1_000).catch(() => {});
  }
  const title = await page.title().catch(() => "");
  return !(title && CHALLENGE_TITLE.test(title));
}

export class ChatGPTSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  get profileDir(): string {
    return expandHome(BROWSER.profileDir);
  }

  get browserRunning(): boolean {
    return this.context !== null;
  }

  /** 啟動內建瀏覽器（持久化 profile）。已在執行時重複呼叫為 no-op。 */
  async launch(options: { headless?: boolean } = {}): Promise<void> {
    if (this.context) return;
    const headless = options.headless ?? BROWSER.headlessDefault;
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      channel: BROWSER.channel === "chromium" ? undefined : BROWSER.channel,
      headless,
      viewport: BROWSER.viewport,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.context.on("close", () => {
      this.context = null;
      this.page = null;
    });
  }

  /** 導航至 ChatGPT 首頁（供登入使用）。 */
  async openChatGPT(): Promise<void> {
    const page = this.requirePage();
    await page.goto(CHATGPT.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUTS.navigationMs,
    });
    await page.waitForTimeout(1500);
    await this.ensureNotChallenged(page);
  }

  /** 驗證頁（Cloudflare 等）處理：先等自動放行，逾時給出明確指引。 */
  private async ensureNotChallenged(page: Page): Promise<void> {
    if (await waitOutChallenge(page)) return;
    throw new WebChatError(
      "頁面停留在驗證（Cloudflare challenge）畫面。請以可視瀏覽器（預設啟動方式）完成驗證與登入；" +
        "無頭模式（WEBCHATMCP_HEADLESS=1）不適用於首次登入。",
      "browser_error",
    );
  }

  /** 判定登入狀態：先排除登入畫面，再以可見輸入框確認；否則 unknown。 */
  async isLoggedIn(): Promise<TriState> {
    const page = this.currentPage();
    if (!page) return "unknown";
    try {
      if (new URL(page.url()).origin !== CHATGPT_ORIGIN) return "unknown";
      if (/\/auth\//.test(page.url())) return false;
      if (await page.locator(`${CHATGPT.selectors.loginButton}:visible`).first().isVisible()) {
        return false;
      }
      if (await page.locator(COMPOSER_SELECTOR).first().isVisible()) return true;
      const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
      for (const marker of CHATGPT.loggedOutIndicators) {
        if (bodyText.includes(marker)) return false;
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** 判定目前頁面是否為臨時（無痕）聊天模式。 */
  async isTemporaryChat(): Promise<TriState> {
    const page = this.currentPage();
    if (!page || new URL(page.url()).origin !== CHATGPT_ORIGIN) return "unknown";
    try {
      if (await page.locator(CHATGPT.selectors.temporaryChatActive).first().isVisible()) return true;
      const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
      for (const marker of CHATGPT.temporaryChatIndicators) {
        if (bodyText.includes(marker)) return true;
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** 同步狀態（不探測頁面；登入／臨時聊天一律 unknown，探測版見 statusAsync）。 */
  status(): SessionStatus {
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
  async statusAsync(): Promise<SessionStatus> {
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
  async waitForLogin(timeoutMs: number): Promise<{ loggedIn: TriState; elapsedMs: number }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = await this.isLoggedIn();
      if (state === true) return { loggedIn: true, elapsedMs: Date.now() - start };
      await delay(Math.min(TIMEOUTS.loginPollMs, Math.max(0, timeoutMs - (Date.now() - start))));
    }
    return { loggedIn: await this.isLoggedIn(), elapsedMs: Date.now() - start };
  }

  /**
   * 在全新的臨時（無痕）聊天送出提示，等待回覆完成後回傳文字。
   * options.model 指定時，先在模型選單切換模型再送出。
   */
  async ask(
    prompt: string,
    options: { timeoutMs?: number; model?: string } = {},
  ): Promise<AskResult> {
    const timeoutMs = options.timeoutMs ?? TIMEOUTS.answerMs;
    const page = this.requirePage();
    const start = Date.now();

    // 每次呼叫都開啟全新的臨時聊天（不留歷史、不延續上一題）
    await page.goto(CHATGPT.temporaryChatUrl, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUTS.navigationMs,
    });
    await this.ensureNotChallenged(page);
    await this.waitForChatGPTReady(
      page,
      Math.min(TIMEOUTS.navigationMs, Math.max(1, start + timeoutMs - Date.now())),
    );

    const loggedIn = await this.isLoggedIn();
    if (loggedIn !== true) {
      throw new WebChatError(
        "ChatGPT 尚未登入：請先呼叫 webchat_login 並在瀏覽器中完成登入。",
        "logged_out",
      );
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
    const sendButton =
      (await page.$(CHATGPT.selectors.sendButton)) ?? (await page.$(CHATGPT.selectors.sendButtonAlt));
    if (sendButton) {
      await sendButton.click();
    } else {
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
      throw new WebChatError(
        `送出後 ${Math.round(timeoutMs / 1000)} 秒內未見 ChatGPT 回覆（可能觸發驗證或速率限制）。`,
        "no_response",
      );
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
      } else {
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
  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) {
      await context.close().catch(() => {});
    }
  }

  /** 開啟模型選單（找不到開關即回報 UI 變動徵兆）。 */
  private async openModelMenu(page: Page): Promise<void> {
    const switcher =
      (await page.$(CHATGPT.selectors.modelSwitcher)) ??
      (await page.$(CHATGPT.selectors.modelSwitcherAlt));
    if (!switcher) {
      throw new WebChatError(
        "找不到模型選單按鈕（model switcher；ChatGPT UI 變動徵兆）。",
        "browser_error",
      );
    }
    await switcher.click();
    await page.waitForTimeout(500);
  }

  /** 列出可用模型（依帳號等級即時擷取，不寫死）。 */
  async listModels(): Promise<ModelEntry[]> {
    const page = this.requirePage();
    if (new URL(page.url()).origin !== CHATGPT_ORIGIN) {
      await this.openChatGPT();
    }
    await this.ensureNotChallenged(page);
    await this.waitForChatGPTReady(page);
    const loggedIn = await this.isLoggedIn();
    if (loggedIn !== true) {
      throw new WebChatError(
        "ChatGPT 尚未登入：請先呼叫 webchat_login 並在瀏覽器中完成登入。",
        "logged_out",
      );
    }
    await this.openModelMenu(page);
    const items = await page.$$(
      `${CHATGPT.selectors.modelMenuItem}, ${CHATGPT.selectors.modelMenuItemAlt}`,
    );
    const models: ModelEntry[] = [];
    for (const item of items) {
      const raw = ((await item.innerText().catch(() => "")) ?? "").trim();
      if (!raw) continue;
      const label = raw.split("\n")[0].trim();
      if (!label) continue;
      const checked =
        (await item.getAttribute("aria-checked")) === "true" ||
        (await item.getAttribute("data-state")) === "checked";
      models.push({ label, current: checked });
    }
    await page.keyboard.press("Escape").catch(() => {});
    return models;
  }

  /** 切換模型；名單比對不中即回 model_not_found（先呼叫 webchat_models 查看可用清單）。 */
  async selectModel(label: string): Promise<{ selected: boolean; label: string }> {
    const page = this.requirePage();
    await this.openModelMenu(page);
    const items = await page.$$(
      `${CHATGPT.selectors.modelMenuItem}, ${CHATGPT.selectors.modelMenuItemAlt}`,
    );
    const wanted = label.trim().toLowerCase();
    for (const item of items) {
      const raw = ((await item.innerText().catch(() => "")) ?? "").trim();
      const itemLabel = raw.split("\n")[0].trim();
      if (!itemLabel) continue;
      const key = itemLabel.toLowerCase();
      if (key === wanted || key.includes(wanted)) {
        await item.click();
        await page.waitForTimeout(800);
        return { selected: true, label: itemLabel };
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    throw new WebChatError(
      `找不到模型「${label}」。請先呼叫 webchat_models 查看可用清單。`,
      "model_not_found",
    );
  }

  /** 登入可能開啟新分頁；只接手同一 context 裡的 ChatGPT 頁面。 */
  private currentPage(): Page | null {
    const pages = this.context?.pages() ?? [];
    for (let i = pages.length - 1; i >= 0; i -= 1) {
      const page = pages[i];
      if (!page.isClosed() && new URL(page.url()).origin === CHATGPT_ORIGIN) {
        this.page = page;
        return page;
      }
    }
    if (this.page?.isClosed()) this.page = null;
    return this.page;
  }

  /** DOMContentLoaded 不代表輸入框已完成 hydration；等待可操作的畫面指標。 */
  private async waitForChatGPTReady(page: Page, timeoutMs: number = TIMEOUTS.navigationMs): Promise<void> {
    try {
      await page.locator(READY_SELECTOR).first().waitFor({ state: "visible", timeout: timeoutMs });
    } catch {
      throw new WebChatError(
        "ChatGPT 頁面尚未載入可用的輸入框或登入按鈕。請確認瀏覽器畫面與網路連線。",
        "browser_error",
      );
    }
  }

  private requirePage(): Page {
    const page = this.currentPage();
    if (!page) {
      throw new WebChatError("瀏覽器尚未啟動或 ChatGPT 分頁已關閉。", "browser_error");
    }
    return page;
  }

  private async lastAssistantText(): Promise<string> {
    const page = this.requirePage();
    const messages = await page.$$(CHATGPT.selectors.assistantMessage);
    if (messages.length === 0) return "";
    const last = messages[messages.length - 1];
    const markdown = await last.$(".markdown, .prose");
    const target = markdown ?? last;
    return ((await target.innerText().catch(() => "")) ?? "").trim();
  }
}
