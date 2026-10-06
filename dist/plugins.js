/**
 * WebChatMCP.js — 外掛載入：以 JSON 檔新增其他聊天服務。
 *
 * 外掛只是資料（網址與 DOM 選擇器），不含程式碼，不會被執行；格式與欄位說明見 plugins/README.md。
 * 載入來源：倉庫的 plugins/（檔名以 _ 開頭的範本略過）與使用者目錄 ~/.webchatmcp/plugins
 * （WEBCHATMCP_PLUGINS_DIR 可改）。單一外掛格式錯誤只會被略過並回報原因，不影響其他服務。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { PLUGINS, PROVIDERS } from "./config.js";
const DEFAULT_STOP = 'button[aria-label*="停止"], button[aria-label*="Stop" i]';
const TOP_KEYS = new Set([
    "id",
    "label",
    "menu",
    "baseUrl",
    "askUrl",
    "privateMode",
    "guest",
    "domains",
    "loginUrlPattern",
    "selectors",
    "privateIndicators",
    "loggedOutIndicators",
    "thinkingMenuItem",
    "moreModelsMenuItem",
]);
const SELECTOR_KEYS = new Set([
    "composer",
    "sendButton",
    "stopButton",
    "assistantMessage",
    "loginButton",
    "modelSwitcher",
    "privateEnter",
    "privateActive",
    "dismiss",
    "blocking",
]);
function expandHome(path) {
    return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rejectUnknown(obj, allowed, where) {
    const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
        throw new Error(`${where}有不認得的欄位：${unknown.join("、")}`);
}
function requiredString(obj, key, where) {
    const value = obj[key];
    if (typeof value !== "string" || value.trim() === "")
        throw new Error(`${where}${key} 必須是非空字串`);
    return value;
}
function optionalString(obj, key, where) {
    const value = obj[key];
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string" || value.trim() === "")
        throw new Error(`${where}${key} 必須是非空字串或省略`);
    return value;
}
function stringList(obj, key, where) {
    const value = obj[key];
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
        throw new Error(`${where}${key} 必須是非空字串的陣列`);
    }
    return value;
}
function httpsUrl(value, key) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(`${key} 不是有效的網址`);
    }
    if (url.protocol !== "https:")
        throw new Error(`${key} 必須是 https 網址`);
    return url;
}
function checkRegExp(pattern, key) {
    if (pattern === null)
        return;
    try {
        new RegExp(pattern, "i");
    }
    catch {
        throw new Error(`${key} 不是有效的正規表達式`);
    }
}
/** 驗證並轉成 ProviderConfig；格式錯誤丟出 Error（訊息即略過原因）。 */
export function parsePlugin(raw) {
    if (!isObject(raw))
        throw new Error("內容必須是 JSON 物件");
    rejectUnknown(raw, TOP_KEYS, "");
    const id = requiredString(raw, "id", "");
    if (!new RegExp(PLUGINS.idPattern).test(id))
        throw new Error(`id「${id}」格式不符（${PLUGINS.idPattern}）`);
    if (id in PROVIDERS)
        throw new Error(`id「${id}」已被內建服務或其他外掛使用`);
    const label = requiredString(raw, "label", "");
    const menu = raw.menu ?? "radio";
    if (menu !== "radio")
        throw new Error('menu 外掛只能是 "radio"');
    const baseUrl = requiredString(raw, "baseUrl", "");
    const base = httpsUrl(baseUrl, "baseUrl");
    const askUrl = optionalString(raw, "askUrl", "") ?? baseUrl;
    httpsUrl(askUrl, "askUrl");
    const privateMode = raw.privateMode ?? "url";
    if (privateMode !== "url" && privateMode !== "button")
        throw new Error('privateMode 必須是 "url" 或 "button"');
    if (raw.guest !== undefined && typeof raw.guest !== "boolean")
        throw new Error("guest 必須是布林值");
    // 登出只清除這些網域的 cookie：必須是 baseUrl 主機本身或其上層網域，避免外掛去清別的網站。
    const domains = raw.domains === undefined ? [base.hostname] : stringList(raw, "domains", "");
    for (const domain of domains) {
        const ok = domain.includes(".") && (base.hostname === domain || base.hostname.endsWith(`.${domain}`));
        if (!ok)
            throw new Error(`domains 的「${domain}」必須是 baseUrl 主機（${base.hostname}）或其上層網域`);
    }
    const loginUrlPattern = optionalString(raw, "loginUrlPattern", "");
    const thinkingMenuItem = optionalString(raw, "thinkingMenuItem", "");
    const moreModelsMenuItem = optionalString(raw, "moreModelsMenuItem", "");
    checkRegExp(loginUrlPattern, "loginUrlPattern");
    checkRegExp(thinkingMenuItem, "thinkingMenuItem");
    checkRegExp(moreModelsMenuItem, "moreModelsMenuItem");
    if (!isObject(raw.selectors))
        throw new Error("selectors 必須是物件");
    const sel = raw.selectors;
    rejectUnknown(sel, SELECTOR_KEYS, "selectors 內");
    const privateEnter = optionalString(sel, "privateEnter", "selectors.");
    if (privateMode === "button" && privateEnter === null) {
        throw new Error('privateMode 為 "button" 時 selectors.privateEnter 必填');
    }
    const config = {
        label,
        menu: "radio",
        baseUrl,
        askUrl,
        privateMode,
        guest: raw.guest === true,
        domains,
        loginUrlPattern,
        selectors: {
            composer: requiredString(sel, "composer", "selectors."),
            sendButton: requiredString(sel, "sendButton", "selectors."),
            stopButton: optionalString(sel, "stopButton", "selectors.") ?? DEFAULT_STOP,
            assistantMessage: requiredString(sel, "assistantMessage", "selectors."),
            loginButton: requiredString(sel, "loginButton", "selectors."),
            modelSwitcher: requiredString(sel, "modelSwitcher", "selectors."),
            privateEnter,
            privateActive: optionalString(sel, "privateActive", "selectors."),
            dismiss: stringList(sel, "dismiss", "selectors."),
            blocking: optionalString(sel, "blocking", "selectors."),
        },
        privateIndicators: stringList(raw, "privateIndicators", ""),
        loggedOutIndicators: stringList(raw, "loggedOutIndicators", ""),
        thinkingMenuItem,
        moreModelsMenuItem,
    };
    return { id, config };
}
/** 外掛目錄清單：倉庫內建目錄＋使用者目錄。 */
export function pluginDirs() {
    const user = PLUGINS.userDirs
        .split(delimiter)
        .filter((dir) => dir.trim() !== "")
        .map(expandHome);
    return [PLUGINS.bundledDir, ...user];
}
/** 載入所有外掛並註冊到 PROVIDERS；單一外掛失敗只記錄原因，不中斷。 */
export function loadPlugins(dirs = pluginDirs()) {
    const report = { loaded: [], skipped: [] };
    for (const dir of dirs) {
        if (!existsSync(dir) || !statSync(dir).isDirectory())
            continue;
        const files = readdirSync(dir)
            .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
            .sort();
        for (const name of files) {
            const file = join(dir, name);
            try {
                const { id, config } = parsePlugin(JSON.parse(readFileSync(file, "utf8")));
                PROVIDERS[id] = config;
                report.loaded.push({ id, file });
            }
            catch (err) {
                report.skipped.push({ file, reason: err instanceof Error ? err.message : String(err) });
            }
        }
    }
    return report;
}
