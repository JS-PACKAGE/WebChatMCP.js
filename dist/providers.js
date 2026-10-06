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
function firstLine(text) {
    return text.trim().split("\n")[0].trim();
}
async function entryOf(item) {
    const label = firstLine((await item.innerText().catch(() => "")) ?? "");
    if (!label)
        return null;
    const current = await item
        .evaluate((node) => {
        const el = node;
        return (el.getAttribute("aria-checked") === "true" ||
            el.getAttribute("data-state") === "checked" ||
            el.classList.contains("selected"));
    })
        .catch(() => false);
    return { label, current };
}
async function entriesOf(items) {
    const entries = [];
    for (const item of items) {
        const entry = await entryOf(item);
        if (entry)
            entries.push(entry);
    }
    return entries;
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
    await switcher.click();
    // 選單項目是逐步繪製的：等選單文字連續兩次取樣相同才算就緒，避免漏掉後面的項目。
    let last = "";
    for (let i = 0; i < 10; i += 1) {
        await page.waitForTimeout(400);
        const text = await page
            .locator('[role="menu"]')
            .evaluateAll((menus) => menus.map((menu) => menu.innerText).join("\n"))
            .catch(() => "");
        if (text !== "" && text === last)
            break;
        last = text;
    }
    return () => ADAPTERS[provider].modelItems(page);
}
/** 開啟選單並讀取模型與思考深度，最後關閉選單。 */
export async function readMenu(page, provider) {
    const items = await openModelMenu(page, provider);
    try {
        return await ADAPTERS[provider].read(page, items);
    }
    finally {
        await page.keyboard.press("Escape").catch(() => { });
        await page.keyboard.press("Escape").catch(() => { });
    }
}
/** 開啟選單並點選標籤相符（完全相同或包含）的模型；比對不中回 null。 */
export async function selectModelItem(page, provider, wanted) {
    const items = await openModelMenu(page, provider);
    const want = wanted.trim().toLowerCase();
    const pick = async (candidates) => {
        for (const item of candidates) {
            const label = firstLine((await item.innerText().catch(() => "")) ?? "");
            if (!label)
                continue;
            const key = label.toLowerCase();
            if (key === want || key.includes(want)) {
                await item.click();
                await page.waitForTimeout(800);
                return label;
            }
        }
        return null;
    };
    try {
        const direct = await pick(await items());
        if (direct !== null)
            return direct;
        const moreItems = ADAPTERS[provider].moreItems;
        return moreItems ? await pick(await moreItems(page)) : null;
    }
    finally {
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
                await page.waitForTimeout(500);
            }
        }
        return page.$$(RADIO);
    },
    async read(page, items) {
        const thinking = await readChatGPTThinking(page);
        return { models: await entriesOf(await items()), thinking };
    },
};
/**
 * 以方向鍵逐段走過滑桿並讀取每段的名稱，最後回到原本的位置（會短暫改動設定，結束時還原）。
 * 滑桿本身沒有列出全部段名的 DOM。
 */
async function readChatGPTThinking(page) {
    const start = await sliderState(page);
    const slider = page.locator('[role="slider"]').first();
    if (!start || (await slider.count()) === 0)
        return [];
    await slider.focus().catch(() => { });
    const press = async (key) => {
        await page.keyboard.press(key);
        await page.waitForTimeout(250);
        return sliderState(page);
    };
    const levels = new Map([[start.index, start.label]]);
    try {
        let state = start;
        for (let i = 0; i < start.count && state.index > 1; i += 1) {
            state = (await press("ArrowLeft")) ?? state;
            levels.set(state.index, state.label);
        }
        for (let i = 0; i < start.count && state.index < start.count; i += 1) {
            const next = (await press("ArrowRight")) ?? state;
            if (next.index === state.index)
                break;
            state = next;
            levels.set(state.index, state.label);
        }
    }
    finally {
        let state = await sliderState(page);
        for (let i = 0; i < start.count && state && state.index !== start.index; i += 1) {
            state = await press(state.index > start.index ? "ArrowLeft" : "ArrowRight");
        }
    }
    return [...levels.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, label]) => ({ label, current: index === start.index }));
}
const radioOnly = {
    modelItems: (page) => page.$$(RADIO),
    async read(page, items) {
        return { models: await entriesOf(await items()), thinking: [] };
    },
};
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
    await page.waitForTimeout(600);
    if ((await signature()) === before) {
        await entry.click().catch(() => { });
        await page.waitForTimeout(600);
        if ((await signature()) === before)
            return [];
    }
    return page.locator('[role="menu"]').last().locator(RADIO).elementHandles();
}
const claude = {
    modelItems: radioOnly.modelItems,
    moreItems: (page) => submenuRadios(page, PROVIDERS.claude.moreModelsMenuItem),
    async read(page, items) {
        const main = await entriesOf(await items());
        // 一次只能開一個子選單，且展開的子選單會蓋住其他選單項；讀完先按 Escape 收起（只收子選單）。
        const thinking = await entriesOf(await submenuRadios(page, PROVIDERS.claude.thinkingMenuItem));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        const more = await entriesOf(await submenuRadios(page, PROVIDERS.claude.moreModelsMenuItem));
        const known = new Set(main.map((entry) => entry.label));
        return { models: [...main, ...more.filter((entry) => !known.has(entry.label))], thinking };
    },
};
const GEMINI_MODEL = '[data-test-id^="bard-mode-option-"]';
/** 訪客選單裡的「登入以使用所有模型」是升級提示，不是思考設定。 */
const SIGN_IN_PROMPT = /sign in|log in|登入/i;
const gemini = {
    modelItems: (page) => page.$$(GEMINI_MODEL),
    async read(page, items) {
        const models = await entriesOf(await items());
        // 同一選單中不是模式的項目（如「延伸思考」）屬於思考設定的開關。
        const toggles = await page
            .locator(`gem-menu [role="menuitem"]:not(${GEMINI_MODEL})`)
            .elementHandles();
        const thinking = (await entriesOf(toggles)).filter((entry) => !SIGN_IN_PROMPT.test(entry.label));
        return { models, thinking };
    },
};
const ADAPTERS = { chatgpt, claude, grok: radioOnly, gemini };
