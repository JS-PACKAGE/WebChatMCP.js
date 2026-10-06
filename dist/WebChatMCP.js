#!/usr/bin/env node
/**
 * WebChatMCP.js — MCP Server 主程式。
 *
 * 連線方式（同時啟用）：
 * - stdio：供 MCP 用戶端以子程序方式啟動（stdout 專供 JSON-RPC）。
 * - Streamable HTTP：開啟設定的 port（預設 http://127.0.0.1:8321/mcp），
 *   供客戶端直接以 HTTP 連線；port 與監聽位址寫在 src/config.ts，可用環境變數覆蓋。
 *
 * 工具：
 * - webchat_login  ：開啟內建瀏覽器，讓使用者人工登入 ChatGPT（登入狀態持久化）。
 * - webchat_ask    ：把提示文字送進 ChatGPT 臨時（無痕）聊天視窗，回傳回覆文字。
 * - webchat_models ：列出帳號可用的 ChatGPT 模型（即時擷取模型選單）。
 * - webchat_status ：回報瀏覽器、登入與 HTTP 連線狀態。
 * - webchat_close  ：關閉內建瀏覽器。
 *
 * 紀律：stdio 模式下 stdout 專供 JSON-RPC，日誌一律走 stderr；不讀寫任何密碼。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ChatGPTSession, WebChatError } from "./chatgpt.js";
import { APP, BROWSER, CHATGPT, TIMEOUTS } from "./config.js";
import { startHttpServer } from "./http.js";
const session = new ChatGPTSession();
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
/** 瀏覽器操作互斥：多個連線端同時呼叫時依序執行，避免交錯操作同一個瀏覽器。 */
let opChain = Promise.resolve();
function withBrowserLock(fn) {
    const run = opChain.then(fn, fn);
    opChain = run.catch(() => { });
    return run;
}
/** 建立一組完整工具的 McpServer（stdio 與每個 HTTP session 各用一組）。 */
function buildServer() {
    const server = new McpServer({ name: APP.name, version: APP.version });
    server.registerTool("webchat_login", {
        title: "開啟內建瀏覽器登入 ChatGPT",
        description: "Launch the built-in browser at ChatGPT so the user can log in manually once. " +
            "The login session is persisted in the profile directory and reused by later calls. " +
            `Waits up to timeout_seconds (default ${Math.round(TIMEOUTS.loginWaitMs / 1000)}) for the login to finish; ` +
            "on timeout the browser stays open and the user can finish later, then call webchat_status.",
        inputSchema: {
            timeout_seconds: z
                .number()
                .int()
                .min(10)
                .max(900)
                .optional()
                .describe(`How long to wait for a manual login (default ${Math.round(TIMEOUTS.loginWaitMs / 1000)}s).`),
        },
    }, async ({ timeout_seconds }) => {
        try {
            return await withBrowserLock(async () => {
                await session.launch({ headless: false });
                await session.openChatGPT();
                log("browser opened for manual ChatGPT login");
                const timeoutMs = (timeout_seconds ?? TIMEOUTS.loginWaitMs / 1000) * 1000;
                const { loggedIn, elapsedMs } = await session.waitForLogin(timeoutMs);
                const status = await session.statusAsync();
                return jsonResult({
                    loggedIn,
                    elapsedMs,
                    profileDir: status.profileDir,
                    currentUrl: status.currentUrl,
                    guidance: loggedIn === true
                        ? "Login detected. The session is saved; you can now call webchat_ask."
                        : "Login not detected yet. Finish the login in the open browser window, then call webchat_status.",
                });
            });
        }
        catch (err) {
            log(`webchat_login failed: ${err instanceof Error ? err.message : String(err)}`);
            return errorResult(err);
        }
    });
    server.registerTool("webchat_ask", {
        title: "以 ChatGPT 臨時聊天送出提示",
        description: "Send a prompt through a fresh ChatGPT temporary (incognito) chat in the built-in browser and return ChatGPT's answer text. " +
            "Every call opens a brand-new temporary chat: the prompt is not added to the account's chat history and is not used for model training. " +
            "Optionally select a ChatGPT model first via `model` (labels as returned by webchat_models). " +
            "Requires a completed webchat_login first. Prompts are typed exactly as given, including multi-line text.",
        inputSchema: {
            prompt: z.string().min(1).describe("The prompt text to send to ChatGPT."),
            model: z
                .string()
                .optional()
                .describe("Optional ChatGPT model label (from webchat_models) to switch to before sending."),
            timeout_seconds: z
                .number()
                .int()
                .min(10)
                .max(600)
                .optional()
                .describe(`How long to wait for the answer (default ${Math.round(TIMEOUTS.answerMs / 1000)}s).`),
        },
    }, async ({ prompt, model, timeout_seconds }) => {
        try {
            return await withBrowserLock(async () => {
                if (!session.browserRunning) {
                    await session.launch();
                }
                const timeoutMs = (timeout_seconds ?? TIMEOUTS.answerMs / 1000) * 1000;
                const result = await session.ask(prompt, { timeoutMs, model });
                log(`ask completed in ${Math.round(result.elapsedMs / 1000)}s (temporary=${result.temporaryChat})`);
                const prefix = result.completed
                    ? ""
                    : "（注意：等待逾時，以下為目前擷取到的回覆內容）\n\n";
                const suffix = result.temporaryChat === true
                    ? ""
                    : `\n\n[${APP.program}] 未能確認臨時聊天模式（temporary_chat=${String(result.temporaryChat)}）`;
                return { content: [{ type: "text", text: prefix + result.answer + suffix }] };
            });
        }
        catch (err) {
            log(`webchat_ask failed: ${err instanceof Error ? err.message : String(err)}`);
            return errorResult(err);
        }
    });
    server.registerTool("webchat_models", {
        title: "列出可用的 ChatGPT 模型",
        description: "List the ChatGPT models available to the logged-in account (scraped live from the model switcher menu, " +
            "so account tier differences are handled automatically). Each entry has a `label` (use it with webchat_ask's `model`) " +
            "and `current` (whether it is the selected model). Requires a completed webchat_login first.",
        inputSchema: {},
    }, async () => {
        try {
            return await withBrowserLock(async () => {
                if (!session.browserRunning) {
                    await session.launch();
                }
                const models = await session.listModels();
                log(`listed ${models.length} models`);
                return jsonResult({ count: models.length, models });
            });
        }
        catch (err) {
            log(`webchat_models failed: ${err instanceof Error ? err.message : String(err)}`);
            return errorResult(err);
        }
    });
    server.registerTool("webchat_status", {
        title: "回報瀏覽器與連線狀態",
        description: "Report whether the built-in browser is running, whether the ChatGPT login is active, " +
            "whether the current page is in temporary-chat mode, the profile directory, and the HTTP endpoint state.",
        inputSchema: {},
    }, async () => {
        try {
            const status = await session.statusAsync();
            return jsonResult({
                ...status,
                chatgptUrl: CHATGPT.baseUrl,
                temporaryChatUrl: CHATGPT.temporaryChatUrl,
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
        description: "Close the built-in browser cleanly. The ChatGPT login session stays saved in the profile directory and will be reused next time.",
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
    return server;
}
async function main() {
    // stdio：供 MCP 用戶端以子程序啟動
    const stdioServer = buildServer();
    await stdioServer.connect(new StdioServerTransport());
    // HTTP：開 port 讓客戶端直接連線（port 見 src/config.ts SERVER.httpPort）
    const http = await startHttpServer(buildServer, log);
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
