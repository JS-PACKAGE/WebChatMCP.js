#!/usr/bin/env node
/**
 * WebChatMCP.js — MCP Server 主程式。
 *
 * 連線方式（同時啟用）：
 * - stdio：供 MCP 用戶端以子程序方式啟動（stdout 專供 JSON-RPC）。
 * - Streamable HTTP：開啟設定的 port（預設 http://127.0.0.1:8321/mcp），
 *   供客戶端直接以 HTTP 連線；port 與監聽位址寫在 src/config.ts，可用環境變數覆蓋。
 *
 * 工具（皆可用 provider 參數選擇 chatgpt｜claude｜grok｜gemini，預設 chatgpt）：
 * - webchat_login  ：先查詢是否已登入；未登入才顯示瀏覽器讓使用者人工登入（登入狀態持久化）。
 * - webchat_logout ：清除該服務的登入 cookie（不需畫面）。
 * - webchat_ask    ：把提示文字送進無痕（臨時）聊天視窗，回傳回覆文字；ChatGPT、Gemini 未登入也能用。
 * - webchat_models ：列出帳號可用的模型與思考深度（即時擷取選單）。
 * - webchat_status ：回報瀏覽器、登入與 HTTP 連線狀態。
 * - webchat_close  ：關閉內建瀏覽器。
 *
 * 紀律：stdio 模式下 stdout 專供 JSON-RPC，日誌一律走 stderr；不讀寫任何密碼。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP, BROWSER, CLAUDE, CODEX, GROK, HERMES, DEFAULT_PROVIDER, providerIds, PROVIDERS, TIMEOUTS } from "./config.js";
import { startHttpServer } from "./http.js";
import { loadPlugins } from "./plugins.js";
import { WebChatError, WebChatSession } from "./session.js";
const session = new WebChatSession();
let httpInfo = null;
function log(message) {
    console.error(`[${APP.program}] ${message}`);
}
function jsonResult(payload) {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
function errorResult(err) {
    const code = err instanceof WebChatError ? err.code : "browser_error";
    const message = err instanceof Error ? err.message : String(err);
    return {
        content: [{ type: "text", text: JSON.stringify({ error: code, message }, null, 2) }],
        isError: true,
    };
}
/**
 * 瀏覽器操作互斥：多個連線端同時呼叫時依序執行，避免交錯操作同一個瀏覽器。pendingOps＝尚未做完的操作數。
 * 全部操作做完後開始計時，最後一次通訊後閒置超過 TIMEOUTS.idleCloseSeconds 秒就關掉無頭瀏覽器（下次提問自動重開）。
 * prewarm 仍受同一把鎖保護，但新的正式操作可取消它；未開始的預載則直接略過。
 */
let opChain = Promise.resolve();
let pendingOps = 0;
let idleTimer = null;
let prewarmAbort = null;
let prewarmTimer = null;
function armIdleClose() {
    if (TIMEOUTS.idleCloseSeconds <= 0 || !session.browserRunning || !session.isHeadless)
        return;
    idleTimer = setTimeout(() => {
        idleTimer = null;
        void withBrowserLock(async () => {
            if (!session.browserRunning || !session.isHeadless)
                return;
            await session.close();
            log(`browser closed after ${TIMEOUTS.idleCloseSeconds}s idle`);
        }).catch(() => { });
    }, TIMEOUTS.idleCloseSeconds * 1000);
    idleTimer.unref();
}
function settleOp() {
    pendingOps -= 1;
    if (pendingOps === 0)
        armIdleClose();
}
function withBrowserLock(fn) {
    if (prewarmTimer) {
        clearImmediate(prewarmTimer);
        prewarmTimer = null;
    }
    pendingOps += 1;
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    prewarmAbort?.abort();
    const run = opChain.then(fn, fn);
    opChain = run.then(settleOp, settleOp);
    return run;
}
/** 等目前操作釋放鎖後才排預載，避免在鎖內改寫 opChain 而遺失排程。 */
function schedulePrewarm(provider, options) {
    clearImmediate(prewarmTimer ?? undefined);
    prewarmTimer = setImmediate(() => {
        prewarmTimer = null;
        if (pendingOps > 0)
            return;
        const abort = new AbortController();
        void withBrowserLock(async () => {
            prewarmAbort = abort;
            try {
                await session.prewarm(provider, { ...options, signal: abort.signal });
            }
            finally {
                prewarmAbort = null;
            }
        }).catch(() => { });
    });
}
/** 在瀏覽器鎖內送出提示；webchat_ask 與 Codex 橋接共用。 */
async function runAsk(provider, prompt, options) {
    return withBrowserLock(async () => {
        if (options.signal?.aborted)
            throw new Error("request cancelled before it started");
        if (!session.browserRunning) {
            await session.launch();
        }
        const result = await session.ask(provider, prompt, {
            timeoutMs: options.timeoutMs,
            model: options.model,
            thinking: options.thinking,
        });
        log(`${provider}: ask completed in ${Math.round(result.elapsedMs / 1000)}s ` +
            `(private=${String(result.temporaryChat)}, loggedIn=${String(result.loggedIn)})`);
        const notes = [];
        if (result.loggedIn === false)
            notes.push("以訪客（未登入）身分送出");
        if (result.temporaryChat !== true)
            notes.push(`未能確認無痕模式（temporary_chat=${String(result.temporaryChat)}）`);
        // 沒有別的操作在排隊時，趁空檔先載好同服務的下一個無痕聊天頁。
        // 新的正式操作會取消預載；完成取消前仍保留互斥，避免交錯導航。
        if (pendingOps === 1) {
            schedulePrewarm(provider, { model: options.model, thinking: options.thinking });
        }
        return {
            answer: result.answer,
            prefix: result.completed ? "" : "（注意：等待逾時，以下為目前擷取到的回覆內容）\n\n",
            notes,
        };
    });
}
/**
 * 載入外掛橋接（plugins/codex、claude、grok、hermes）：檔案存在且未停用才載入；失敗只記錄，不影響 MCP。
 * 橋接模組匯出 createBridge(deps)，deps 提供送出提示與擷取模型標籤的能力。
 */
async function loadBridges() {
    const specs = [
        { name: "codex", enabled: CODEX.enabled, path: CODEX.path, dir: "codex" },
        { name: "claude", enabled: CLAUDE.enabled, path: CLAUDE.path, dir: "claude" },
        { name: "grok", enabled: GROK.enabled, path: GROK.path, dir: "grok" },
        { name: "hermes", enabled: HERMES.enabled, path: HERMES.path, dir: "hermes" },
    ];
    const deps = {
        ask: async (provider, prompt, o) => {
            const r = await runAsk(provider, prompt, o);
            return { answer: r.prefix + r.answer, notes: r.notes };
        },
        listLabels: (provider) => withBrowserLock(async () => {
            if (!session.browserRunning)
                await session.launch();
            return (await session.listModels(provider)).models.map((x) => x.label);
        }),
        /** 每個模型各自的思考深度（逐一切換模型，較慢）；目前只有 Codex 橋接使用。 */
        listModelsDetailed: (provider) => withBrowserLock(async () => {
            if (!session.browserRunning)
                await session.launch();
            return (await session.listModelsDetailed(provider)).map((m) => ({
                label: m.label,
                thinking: m.thinking.map((t) => ({ label: t.label, current: t.current })),
            }));
        }),
        log,
    };
    const bridges = [];
    for (const spec of specs) {
        if (!spec.enabled)
            continue;
        const file = fileURLToPath(new URL(`../plugins/${spec.dir}/bridge.js`, import.meta.url));
        if (!existsSync(file))
            continue;
        try {
            const mod = await import(pathToFileURL(file).href);
            bridges.push({ path: spec.path, handle: mod.createBridge(deps) });
            log(`plugin loaded: ${spec.name} bridge (${spec.path})`);
        }
        catch (err) {
            log(`plugin skipped: ${spec.name} bridge — ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return bridges;
}
/** 建立一組完整工具的 McpServer（stdio 與每個 HTTP session 各用一組）。 */
function buildServer() {
    const server = new McpServer({ name: APP.name, version: APP.version });
    // 服務清單含外掛，所以在建立伺服器時才組出（main 已先載入外掛）。
    const ids = providerIds();
    const providerList = ids.map((id) => `${id} (${PROVIDERS[id].label})`).join(", ");
    const providerField = z
        .enum(ids)
        .default(DEFAULT_PROVIDER)
        .describe(`Which web chat service to use: ${providerList}. Default ${DEFAULT_PROVIDER}.`);
    server.registerTool("webchat_login", {
        title: "登入網頁聊天服務（已登入則不開瀏覽器視窗）",
        description: "Check whether the built-in browser profile is already logged in to the chosen service (headless, no window shown). " +
            "If so, return immediately. Only when not logged in does it show a browser window so the user can log in manually once; " +
            "the window is hidden again after login succeeds. The session is persisted in the profile directory and reused by later calls. " +
            "Logging in is optional for chatgpt and gemini: webchat_ask also works as a guest there. Claude and Grok require it. " +
            `Waits up to timeout_seconds (default ${Math.round(TIMEOUTS.loginWaitMs / 1000)}) for the manual login; ` +
            "on timeout the window stays open and the user can finish later, then call webchat_status.",
        inputSchema: {
            provider: providerField,
            timeout_seconds: z
                .number()
                .int()
                .min(10)
                .max(900)
                .optional()
                .describe(`How long to wait for a manual login (default ${Math.round(TIMEOUTS.loginWaitMs / 1000)}s).`),
        },
    }, async ({ provider, timeout_seconds }) => {
        try {
            return await withBrowserLock(async () => {
                const timeoutMs = (timeout_seconds ?? TIMEOUTS.loginWaitMs / 1000) * 1000;
                const { loggedIn, elapsedMs, alreadyLoggedIn } = await session.login(provider, timeoutMs);
                log(alreadyLoggedIn
                    ? `${provider}: already logged in; no browser window shown`
                    : `${provider}: manual login flow finished`);
                const status = await session.statusAsync(provider);
                return jsonResult({
                    provider,
                    loggedIn,
                    alreadyLoggedIn,
                    elapsedMs,
                    profileDir: status.profileDir,
                    currentUrl: status.currentUrl,
                    guidance: loggedIn === true
                        ? alreadyLoggedIn
                            ? "Already logged in; no browser window was shown. You can call webchat_ask."
                            : "Login detected. The session is saved; you can now call webchat_ask."
                        : "Login not detected yet. Finish the login in the open browser window, then call webchat_status.",
                });
            });
        }
        catch (err) {
            log(`webchat_login failed: ${err instanceof Error ? err.message : String(err)}`);
            return errorResult(err);
        }
    });
    server.registerTool("webchat_logout", {
        title: "登出網頁聊天服務（不開瀏覽器視窗）",
        description: "Log out of the chosen service by clearing its cookies from the built-in browser profile (headless, no window shown), " +
            "then re-check the login state. Logging out of gemini clears google.com cookies, which signs the profile out of Google. " +
            "Use webchat_login to log in again. Guest use (where the service allows it) keeps working.",
        inputSchema: { provider: providerField },
    }, async ({ provider }) => {
        try {
            return await withBrowserLock(async () => {
                const { domains, loggedIn } = await session.logout(provider);
                log(`${provider}: logged out (cleared cookies for ${domains.join(", ")}); loggedIn=${String(loggedIn)}`);
                return jsonResult({
                    provider,
                    loggedOut: loggedIn !== true,
                    loggedIn,
                    clearedDomains: domains,
                    guidance: loggedIn === true
                        ? "Cookies were cleared but the page still looks logged in; call webchat_status to re-check."
                        : "Logged out. Call webchat_login to log in again.",
                });
            });
        }
        catch (err) {
            log(`webchat_logout failed: ${err instanceof Error ? err.message : String(err)}`);
            return errorResult(err);
        }
    });
    server.registerTool("webchat_ask", {
        title: "以無痕聊天送出提示",
        description: "Send a prompt through a fresh private/temporary chat of the chosen service in the built-in browser and return the answer text. " +
            "Every call opens a brand-new chat: the prompt is not added to the account's chat history. " +
            "Works without logging in (guest) on chatgpt and gemini; claude and grok require webchat_login (a guest gets a logged_out error). " +
            "Optionally select a model first via `model` and then a thinking depth via `thinking` (labels as returned by webchat_models; " +
            "pick `thinking` after `model` since the available depths can depend on the model; an unknown label fails with thinking_not_found). " +
            "Prompts are typed exactly as given, including multi-line text.",
        inputSchema: {
            provider: providerField,
            prompt: z.string().min(1).describe("The prompt text to send."),
            model: z
                .string()
                .optional()
                .describe("Optional model label (from webchat_models) to switch to before sending."),
            thinking: z
                .string()
                .optional()
                .describe("Optional thinking-depth label (from webchat_models `thinking`) to set after the model is selected. " +
                "For gemini's on/off toggles (e.g. extended thinking) it turns the toggle on."),
            timeout_seconds: z
                .number()
                .int()
                .min(10)
                .max(600)
                .optional()
                .describe(`How long to wait for the answer (default ${Math.round(TIMEOUTS.answerMs / 1000)}s).`),
        },
    }, async ({ provider, prompt, model, thinking, timeout_seconds }) => {
        try {
            const timeoutMs = (timeout_seconds ?? TIMEOUTS.answerMs / 1000) * 1000;
            const { answer, prefix, notes } = await runAsk(provider, prompt, { timeoutMs, model, thinking });
            const suffix = notes.length > 0 ? `\n\n[${APP.program}] ${notes.join("；")}` : "";
            return { content: [{ type: "text", text: prefix + answer + suffix }] };
        }
        catch (err) {
            log(`webchat_ask failed: ${err instanceof Error ? err.message : String(err)}`);
            return errorResult(err);
        }
    });
    server.registerTool("webchat_models", {
        title: "列出可用的模型與思考深度",
        description: "List the models and thinking-depth options available for the chosen service (scraped live from its model menu, " +
            "so account tier differences are handled automatically). `models` entries have a `label` (use it with webchat_ask's `model`) " +
            "and `current`. `thinking` lists the thinking depth / effort levels (ChatGPT slider, Claude effort, Gemini extended thinking) " +
            "with `current`; it is empty for services without such a setting (Grok folds it into its modes). " +
            "Works as a guest where the service shows a model menu.",
        inputSchema: { provider: providerField },
    }, async ({ provider }) => {
        try {
            return await withBrowserLock(async () => {
                if (!session.browserRunning) {
                    await session.launch();
                }
                const { models, thinking } = await session.listModels(provider);
                log(`${provider}: listed ${models.length} models, ${thinking.length} thinking options`);
                return jsonResult({
                    provider,
                    count: models.length,
                    models,
                    thinkingCount: thinking.length,
                    thinking,
                });
            });
        }
        catch (err) {
            log(`webchat_models failed: ${err instanceof Error ? err.message : String(err)}`);
            return errorResult(err);
        }
    });
    server.registerTool("webchat_status", {
        title: "回報瀏覽器與連線狀態",
        description: "Report whether the built-in browser is running, whether the login is active for the given service (defaults to the service of the current page), " +
            "whether the current page is in private/temporary-chat mode, the profile directory, and the HTTP endpoint state. " +
            "Does not navigate: it inspects the page the browser is currently on.",
        inputSchema: {
            provider: z.enum(ids).optional().describe(`Service to report on (${providerList}); default: the service of the current page.`),
        },
    }, async ({ provider }) => {
        try {
            const status = await session.statusAsync(provider);
            const config = status.provider ? PROVIDERS[status.provider] : null;
            return jsonResult({
                ...status,
                chatUrl: config?.baseUrl ?? null,
                privateChatUrl: config?.askUrl ?? null,
                guestAllowed: config?.guest ?? null,
                channel: BROWSER.channel,
                http: httpInfo,
            });
        }
        catch (err) {
            return errorResult(err);
        }
    });
    server.registerTool("webchat_close", {
        title: "關閉內建瀏覽器",
        description: "Close the built-in browser cleanly. The login sessions stay saved in the profile directory and will be reused next time.",
        inputSchema: {},
    }, async () => {
        try {
            return await withBrowserLock(async () => {
                await session.close();
                log("browser closed");
                return jsonResult({ closed: true, profileDir: session.profileDir });
            });
        }
        catch (err) {
            return errorResult(err);
        }
    });
    server.registerTool("webchat_warmup", {
        title: "預先載入服務的無痕聊天頁",
        description: "Preload the private (temporary) chat page of the chosen service in the background browser, so the next webchat_ask skips the page load. " +
            "With `model` (a label from webchat_models) the model is selected ahead of time too, and a later webchat_ask with the same model skips the switch. " +
            "Meant for host integrations: call it when the user switches to a webchat model, and webchat_release when they switch away. " +
            "Never an error when preloading is not possible (visible browser window, verification page, login required): warmed=false and the next webchat_ask just loads the page as usual.",
        inputSchema: {
            provider: providerField,
            model: z.string().optional().describe("Model label to select in advance (from webchat_models). A label that cannot be selected is ignored here; webchat_ask reports the error."),
        },
    }, async ({ provider, model }) => {
        try {
            return await withBrowserLock(async () => {
                if (!session.browserRunning)
                    await session.launch();
                const warmed = await session.prewarm(provider, { model });
                log(`${provider}: warmup ${warmed ? "ready" : "skipped"}`);
                return jsonResult({ provider, warmed });
            });
        }
        catch (err) {
            log(`webchat_warmup failed: ${err instanceof Error ? err.message : String(err)}`);
            return errorResult(err);
        }
    });
    server.registerTool("webchat_release", {
        title: "釋放背景瀏覽器",
        description: "Close the background (headless) browser and its preloaded chat page because the user no longer uses any webchat model. " +
            "The next webchat_ask or webchat_warmup starts it again. A visible browser window (login in progress) is left alone. Login sessions stay saved.",
        inputSchema: {},
    }, async () => {
        try {
            return await withBrowserLock(async () => {
                const released = session.browserRunning && session.isHeadless;
                if (released) {
                    await session.close();
                    log("browser released");
                }
                return jsonResult({ released });
            });
        }
        catch (err) {
            return errorResult(err);
        }
    });
    return server;
}
async function main() {
    // stdio：供 MCP 用戶端以子程序啟動
    // 先載入外掛（新增的聊天服務），工具的 provider 選項才會包含它們。
    const plugins = loadPlugins();
    for (const { id, file } of plugins.loaded)
        log(`plugin loaded: ${id} (${file})`);
    for (const { file, reason } of plugins.skipped)
        log(`plugin skipped: ${file} — ${reason}`);
    const stdioServer = buildServer();
    await stdioServer.connect(new StdioServerTransport());
    // HTTP：開 port 讓客戶端直接連線（port 見 src/config.ts SERVER.httpPort）
    const http = await startHttpServer(buildServer, log, await loadBridges());
    httpInfo = http.info;
    log(`${APP.program} v${APP.version} ready — stdio + ` +
        (http.info.enabled ? `http ${http.info.url}` : "http disabled") +
        `; profile=${session.profileDir}`);
    const shutdown = async () => {
        await http.close().catch(() => { });
        await session.close().catch(() => { });
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
}
main().catch((err) => {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
});
