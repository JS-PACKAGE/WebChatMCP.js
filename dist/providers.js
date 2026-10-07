/**
 * WebChatMCP.js — 各服務的模型選單與思考深度擷取。
 *
 * 四個服務的選單結構各異（ChatGPT 的兩層視圖、Claude 的子選單、Gemini 的 gem-menu），
 * 這裡集中處理差異；網址與選擇器仍全部來自 config.ts。
 */
import { PROVIDERS, TIMEOUTS } from "./config.js";
/** 找不到模型選單按鈕等 UI 變動徵兆 */
export class MenuError extends Error {
}
const RADIO = '[role="menuitemradio"]';
/** Gemini 的 gem-menu 不一定宣告 role；保留一般選單作為 fallback。 */
const GEMINI_MENU = '[role="menu"], gem-menu';
/** 標籤完全相同者優先，其次取包含關係者（「High」不該先被「Extra high」吃掉）；空字串不比對。 */
function pickByLabel(candidates, wanted) {
    const want = wanted.trim().toLowerCase();
    if (!want)
        return undefined;
    return (candidates.find((c) => c.label.toLowerCase() === want) ??
        candidates.find((c) => c.label.toLowerCase().includes(want)));
}
/** 一次在頁面內讀完整批標籤與勾選狀態，避免每個項目各來回兩次。 */
async function entriesOf(page, items) {
    if (items.length === 0)
        return [];
    const read = (nodes) => nodes.map((el) => {
        if (!(el instanceof HTMLElement))
            return null;
        const label = el.innerText.trim().split("\n")[0].trim();
        if (!label)
            return null;
        return {
            label,
            current: el.getAttribute("aria-checked") === "true" ||
                el.getAttribute("data-state") === "checked" ||
                el.classList.contains("selected"),
        };
    });
    // 某個 handle 若已失效，仍保留其他可讀項目，與原本逐項讀取的容錯一致。
    return page.evaluate(read, items).catch(() => Promise.all(items.map((item) => page.evaluate(read, [item]).then(([entry]) => entry).catch(() => null))));
}
async function menuEntries(page, items) {
    return (await entriesOf(page, items)).filter((entry) => entry !== null);
}
/** 同 entriesOf，但保留元素以便點擊。 */
async function entriesWithItems(page, items) {
    const out = [];
    const entries = await entriesOf(page, items);
    for (let i = 0; i < items.length; i += 1) {
        const entry = entries[i];
        if (entry)
            out.push({ ...entry, item: items[i] });
    }
    return out;
}
/**
 * 狀態一變就繼續；未變時只等到原本的等待上限。給了 settleMs 時，滿足條件後還要維持不變這麼久
 * （逐步繪製的選單才不會只讀到一半），整體仍不超過 timeoutMs。
 */
async function pollUntil(page, read, ready, timeoutMs, settleMs = 0) {
    const deadline = Date.now() + timeoutMs;
    let state = await read();
    let since = Date.now();
    while (!(ready(state) && Date.now() - since >= settleMs)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        await page.waitForTimeout(Math.min(TIMEOUTS.menuPollMs, remaining));
        const next = await read();
        if (next !== state)
            since = Date.now();
        state = next;
    }
    return state;
}
/** 開啟模型選單（找不到開關即回報 UI 變動徵兆）；回傳選單項目的取得函式。 */
export async function openModelMenu(page, provider) {
    const config = PROVIDERS[provider];
    const switcher = await page
        .locator(config.selectors.modelSwitcher)
        .first()
        .elementHandle({ timeout: TIMEOUTS.modelSwitcherMs })
        .catch(() => null);
    if (!switcher) {
        throw new MenuError(`找不到 ${config.label} 的模型選單按鈕（model switcher；UI 變動徵兆）。`);
    }
    if (await switcher.getAttribute("aria-expanded") !== "true")
        await switcher.click();
    // 選單項目是逐步繪製的：等選單文字出現且維持不變才算就緒，避免漏掉後面的項目。
    await pollUntil(page, () => page.locator(config.menu === "gemini" ? GEMINI_MENU : '[role="menu"]').evaluateAll((menus) => menus.map((menu) => menu.innerText).join("\n")).catch(() => ""), (text) => text !== "", 4_000, TIMEOUTS.menuSettleMs);
    return () => adapterOf(provider).modelItems(page);
}
/** 開啟選單並讀取模型與思考深度，最後關閉選單。 */
export async function readMenu(page, provider) {
    const items = await openModelMenu(page, provider);
    try {
        return await adapterOf(provider).read(page, items, PROVIDERS[provider]);
    }
    finally {
        await page.keyboard.press("Escape").catch(() => { });
        await page.keyboard.press("Escape").catch(() => { });
    }
}
/** 點選項目後等選單收起（最多 800ms；不收起的選單就等滿），再留一點時間讓設定生效。 */
async function settleAfterPick(page, kind) {
    await page
        .locator(kind === "gemini" ? GEMINI_MENU : '[role="menu"]')
        .filter({ visible: true })
        .first()
        .waitFor({ state: "hidden", timeout: 800 })
        .catch(() => { });
    await page.waitForTimeout(150);
}
/** 開啟選單並點選標籤相符的模型（完全相同優先，其次包含）；比對不中回 null。 */
export async function selectModelItem(page, provider, wanted) {
    const items = await openModelMenu(page, provider);
    const pick = async (candidates) => {
        const target = pickByLabel(await entriesWithItems(page, candidates), wanted);
        if (!target)
            return null;
        // 已經是目前選中的模型就不必再點（也省下切換後的等待）
        if (target.current)
            return target.label;
        await target.item.click();
        await settleAfterPick(page, PROVIDERS[provider].menu);
        return target.label;
    };
    try {
        const direct = await pick(await items());
        if (direct !== null)
            return direct;
        const moreItems = adapterOf(provider).moreItems;
        return moreItems ? await pick(await moreItems(page, PROVIDERS[provider])) : null;
    }
    finally {
        await page.keyboard.press("Escape").catch(() => { });
    }
}
/**
 * 開啟選單並把思考深度設成指定項目（labels 即 webchat_models 的 thinking[].label）；
 * 比對不中或此服務沒有思考設定回 null。須在選完模型之後呼叫，因為可選的深度會隨模型而異。
 */
export async function selectThinkingItem(page, provider, wanted) {
    await openModelMenu(page, provider);
    try {
        return await adapterOf(provider).selectThinking(page, wanted, PROVIDERS[provider]);
    }
    finally {
        await page.keyboard.press("Escape").catch(() => { });
        await page.keyboard.press("Escape").catch(() => { });
    }
}
/** 項目的圓心座標是否落在項目自己身上（DOM 存在且 visible 不代表沒被別的視圖蓋住）。 */
function clickable(page, selector) {
    return page
        .locator(selector)
        .first()
        .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!top && el.contains(top);
    })
        .catch(() => false);
}
/** ChatGPT 滑桿的朗讀文字，例如「Medium, 2 of 3.」。 */
async function sliderState(page) {
    return page
        .evaluate(() => {
        for (const el of document.querySelectorAll('[role="menu"] *')) {
            if (el.children.length > 0)
                continue;
            const m = /^(.+), (\d+) of (\d+)\.?$/.exec((el.textContent ?? "").trim());
            if (m)
                return { label: m[1], index: Number(m[2]), count: Number(m[3]) };
        }
        return null;
    })
        .catch(() => null);
}
const chatgpt = {
    /**
     * 新版選單預設顯示「思考強度」視圖，模型清單被它遮住，
     * 需點擊標題列（第一個 menuitem）切換到模型視圖。
     */
    async modelItems(page) {
        if (!(await clickable(page, RADIO))) {
            const header = page.locator('[role="menuitem"]').first();
            if (await header.isVisible().catch(() => false)) {
                await header.click();
                // 視圖切換後清單也是逐步繪製：等模型項目可點且選單文字穩定後才讀取。
                await pollUntil(page, async () => ((await clickable(page, RADIO))
                    ? page.locator('[role="menu"]').evaluateAll((menus) => menus.map((menu) => menu.innerText).join("\n")).catch(() => "")
                    : ""), (text) => text !== "", TIMEOUTS.menuViewMs, TIMEOUTS.menuSettleMs);
            }
        }
        return page.$$(RADIO);
    },
    async read(page, items) {
        const thinking = await readChatGPTThinking(page);
        return { models: await menuEntries(page, await items()), thinking };
    },
    selectThinking: selectChatGPTThinking,
};
async function pressSlider(page, key, previous) {
    await page.keyboard.press(key);
    return pollUntil(page, () => sliderState(page), (state) => state !== null && state.index !== previous.index, TIMEOUTS.sliderStepMs);
}
/**
 * 以方向鍵逐段走過滑桿並讀取每段的名稱，最後回到原本的位置（會短暫改動設定，結束時還原）。
 * 滑桿本身沒有列出全部段名的 DOM。
 */
async function scanChatGPTSlider(page) {
    const start = await sliderState(page);
    const slider = page.locator('[role="slider"]').first();
    if (!start || (await slider.count()) === 0)
        return null;
    await slider.focus().catch(() => { });
    const levels = new Map([[start.index, start.label]]);
    try {
        let state = start;
        for (let i = 0; i < start.count && state.index > 1; i += 1) {
            state = (await pressSlider(page, "ArrowLeft", state)) ?? state;
            levels.set(state.index, state.label);
        }
        for (let i = 0; i < start.count && state.index < start.count; i += 1) {
            const next = (await pressSlider(page, "ArrowRight", state)) ?? state;
            if (next.index === state.index)
                break;
            state = next;
            levels.set(state.index, state.label);
        }
    }
    finally {
        let state = await sliderState(page);
        for (let i = 0; i < start.count && state && state.index !== start.index; i += 1) {
            state = await pressSlider(page, state.index > start.index ? "ArrowLeft" : "ArrowRight", state);
        }
    }
    return { start: start.index, count: start.count, levels };
}
async function readChatGPTThinking(page) {
    const scan = await scanChatGPTSlider(page);
    if (!scan)
        return [];
    return [...scan.levels.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, label]) => ({ label, current: index === scan.start }));
}
/** 先走訪滑桿取得各段名稱（並還原），再依方向鍵移到目標段，最後以讀數確認真的停在那裡。 */
async function selectChatGPTThinking(page, wanted) {
    const current = await sliderState(page);
    // 只有完全相符才可略過走訪；包含比對仍需先確認其他段是否有更優先的完全相符標籤。
    if (current && current.label.toLowerCase() === wanted.trim().toLowerCase() &&
        await page.locator('[role="slider"]').count() > 0)
        return current.label;
    const scan = await scanChatGPTSlider(page);
    if (!scan)
        return null;
    const target = pickByLabel([...scan.levels].map(([index, label]) => ({ index, label })), wanted);
    if (!target)
        return null;
    await page.locator('[role="slider"]').first().focus().catch(() => { });
    let state = await sliderState(page);
    for (let i = 0; i < scan.count && state && state.index !== target.index; i += 1) {
        state = await pressSlider(page, state.index > target.index ? "ArrowLeft" : "ArrowRight", state);
    }
    if (state?.index !== target.index) {
        throw new MenuError(`無法把 ChatGPT 的思考強度調到「${target.label}」（滑桿沒有回應；UI 變動徵兆）。`);
    }
    return target.label;
}
/** 點開指定的子選單項（Claude 的「努力程度」「更多模型」），回傳子選單中的 radio 項目。 */
async function submenuRadios(page, pattern) {
    if (!pattern)
        return [];
    const entry = page.locator('[role="menuitem"]').filter({ hasText: new RegExp(pattern, "i") }).first();
    if (!(await entry.isVisible().catch(() => false)))
        return [];
    // 子選單可能在 hover 時就展開，再點擊反而會收起；以「最上層選單的內容是否改變」判斷是否已展開。
    const signature = () => page
        .locator('[role="menu"]')
        .evaluateAll((menus) => `${menus.length}:${menus.at(-1)?.innerText ?? ""}`)
        .catch(() => "");
    const before = await signature();
    await entry.hover().catch(() => { });
    if ((await pollUntil(page, signature, (value) => value !== before, TIMEOUTS.submenuMs, TIMEOUTS.menuSettleMs)) === before) {
        await entry.click().catch(() => { });
        if ((await pollUntil(page, signature, (value) => value !== before, TIMEOUTS.submenuMs, TIMEOUTS.menuSettleMs)) === before)
            return [];
    }
    return page.locator('[role="menu"]').last().locator(RADIO).elementHandles();
}
/**
 * 一般的 radio 選單（Grok、Claude 與外掛預設）：模型是 menuitemradio；
 * 設定了 thinkingMenuItem／moreModelsMenuItem 時，另從子選單讀思考深度與其餘模型。
 */
const radio = {
    modelItems: (page) => page.$$(RADIO),
    moreItems: (page, config) => submenuRadios(page, config.moreModelsMenuItem),
    async read(page, items, config) {
        const main = await menuEntries(page, await items());
        let thinking = [];
        if (config.thinkingMenuItem) {
            thinking = await menuEntries(page, await submenuRadios(page, config.thinkingMenuItem));
            // 一次只能開一個子選單，且展開的子選單會蓋住其他選單項；讀完先按 Escape 收起（只收子選單）。
            const menusBefore = await page.locator('[role="menu"]').count();
            await page.keyboard.press("Escape");
            await pollUntil(page, () => page.locator('[role="menu"]').count(), (count) => count < menusBefore, TIMEOUTS.submenuCloseMs);
        }
        const more = await menuEntries(page, await submenuRadios(page, config.moreModelsMenuItem));
        const known = new Set(main.map((entry) => entry.label));
        return { models: [...main, ...more.filter((entry) => !known.has(entry.label))], thinking };
    },
    /** 思考深度收在子選單（Claude 的「努力程度」）；沒設定 thinkingMenuItem 的服務沒有此設定。 */
    async selectThinking(page, wanted, config) {
        const target = pickByLabel(await entriesWithItems(page, await submenuRadios(page, config.thinkingMenuItem)), wanted);
        if (!target)
            return null;
        if (target.current)
            return target.label;
        await target.item.click();
        await settleAfterPick(page, config.menu);
        return target.label;
    },
};
const GEMINI_MODEL = '[data-test-id^="bard-mode-option-"]';
/** 訪客選單裡的「登入以使用所有模型」是升級提示，不是思考設定。 */
const SIGN_IN_PROMPT = /sign in|log in|登入/i;
const gemini = {
    modelItems: (page) => page.$$(GEMINI_MODEL),
    async read(page, items) {
        const models = await menuEntries(page, await items());
        // 同一選單中不是模式的項目（如「延伸思考」）屬於思考設定的開關。
        const toggles = await page
            .locator(`gem-menu [role="menuitem"]:not(${GEMINI_MODEL})`)
            .elementHandles();
        const thinking = (await menuEntries(page, toggles)).filter((entry) => !SIGN_IN_PROMPT.test(entry.label));
        return { models, thinking };
    },
    /** 思考設定是選單裡的開關項：指定即「開啟」，已開啟就不再點（再點會關掉）。 */
    async selectThinking(page, wanted) {
        const toggles = await entriesWithItems(page, await page.locator(`gem-menu [role="menuitem"]:not(${GEMINI_MODEL})`).elementHandles());
        const target = pickByLabel(toggles.filter((entry) => !SIGN_IN_PROMPT.test(entry.label)), wanted);
        if (!target)
            return null;
        if (!target.current) {
            await target.item.click();
            await settleAfterPick(page, "gemini");
        }
        return target.label;
    },
};
const ADAPTERS = { chatgpt, radio, gemini };
function adapterOf(provider) {
    return ADAPTERS[PROVIDERS[provider].menu];
}
