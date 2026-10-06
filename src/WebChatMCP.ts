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
import { APP, BROWSER, CLAUDE, CODEX, DEFAULT_PROVIDER, providerIds, PROVIDERS, SERVER, TIMEOUTS } from "./config.js";
import { startHttpServer, type Bridge, type HttpServerInfo } from "./http.js";
import { loadPlugins } from "./plugins.js";
import { WebChatError, WebChatSession } from "./session.js";

const session = new WebChatSession();
let httpInfo: HttpServerInfo | null = null;

function log(message: string): void {
  console.error(`[${APP.program}] ${message}`);
}

function jsonResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const code = err instanceof WebChatError ? err.code : "browser_error";
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, message }, null, 2) }],
    isError: true,
  };
}

/** 瀏覽器操作互斥：多個連線端同時呼叫時依序執行，避免交錯操作同一個瀏覽器。 */
let opChain: Promise<unknown> = Promise.resolve();
function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => {});
  return run;
}

/** 在瀏覽器鎖內送出提示；webchat_ask 與 Codex 橋接共用。 */
async function runAsk(
  provider: string,
  prompt: string,
  options: { model?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ answer: string; prefix: string; notes: string[] }> {
  return withBrowserLock(async () => {
    if (options.signal?.aborted) throw new Error("request cancelled before it started");
    if (!session.browserRunning) {
      await session.launch();
    }
    const result = await session.ask(provider, prompt, { timeoutMs: options.timeoutMs, model: options.model });
    log(
      `${provider}: ask completed in ${Math.round(result.elapsedMs / 1000)}s ` +
        `(private=${String(result.temporaryChat)}, loggedIn=${String(result.loggedIn)})`,
    );
    const notes: string[] = [];
    if (result.loggedIn === false) notes.push("以訪客（未登入）身分送出");
    if (result.temporaryChat !== true) notes.push(`未能確認無痕模式（temporary_chat=${String(result.temporaryChat)}）`);
    return {
      answer: result.answer,
      prefix: result.completed ? "" : "（注意：等待逾時，以下為目前擷取到的回覆內容）\n\n",
      notes,
    };
  });
}

/**
 * 載入外掛橋接（plugins/codex、plugins/claude）：檔案存在且未停用才載入；失敗只記錄，不影響 MCP。
 * 橋接模組匯出 createBridge(deps)，deps 提供送出提示與擷取模型標籤的能力。
 */
async function loadBridges(): Promise<Bridge[]> {
  const specs = [
    { name: "codex", enabled: CODEX.enabled, path: CODEX.path, dir: "codex" },
    { name: "claude", enabled: CLAUDE.enabled, path: CLAUDE.path, dir: "claude" },
  ];
  const deps = {
    ask: async (provider: string, prompt: string, o: { model?: string; timeoutMs: number; signal: AbortSignal }) => {
      const r = await runAsk(provider, prompt, o);
      return { answer: r.prefix + r.answer, notes: r.notes };
    },
    listLabels: (provider: string) =>
      withBrowserLock(async () => {
        if (!session.browserRunning) await session.launch();
        return (await session.listModels(provider)).models.map((x) => x.label);
      }),
    log,
  };
  const bridges: Bridge[] = [];
  for (const spec of specs) {
    if (!spec.enabled) continue;
    const file = fileURLToPath(new URL(`../plugins/${spec.dir}/bridge.js`, import.meta.url));
    if (!existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      bridges.push({ path: spec.path, handle: mod.createBridge(deps) });
      log(`plugin loaded: ${spec.name} bridge (${spec.path})`);
    } catch (err) {
      log(`plugin skipped: ${spec.name} bridge — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return bridges;
}

/** 建立一組完整工具的 McpServer（stdio 與每個 HTTP session 各用一組）。 */
function buildServer(): McpServer {
  const server = new McpServer({ name: APP.name, version: APP.version });
  // 服務清單含外掛，所以在建立伺服器時才組出（main 已先載入外掛）。
  const ids = providerIds() as [string, ...string[]];
  const providerList = ids.map((id) => `${id} (${PROVIDERS[id].label})`).join(", ");
  const providerField = z
    .enum(ids)
    .default(DEFAULT_PROVIDER)
    .describe(`Which web chat service to use: ${providerList}. Default ${DEFAULT_PROVIDER}.`);

  server.registerTool(
    "webchat_login",
    {
      title: "登入網頁聊天服務（已登入則不開瀏覽器視窗）",
      description:
        "Check whether the built-in browser profile is already logged in to the chosen service (headless, no window shown). " +
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
    },
    async ({ provider, timeout_seconds }) => {
      try {
        return await withBrowserLock(async () => {
          const timeoutMs = (timeout_seconds ?? TIMEOUTS.loginWaitMs / 1000) * 1000;
          const { loggedIn, elapsedMs, alreadyLoggedIn } = await session.login(provider, timeoutMs);
          log(
            alreadyLoggedIn
              ? `${provider}: already logged in; no browser window shown`
              : `${provider}: manual login flow finished`,
          );
          const status = await session.statusAsync(provider);
          return jsonResult({
            provider,
            loggedIn,
            alreadyLoggedIn,
            elapsedMs,
            profileDir: status.profileDir,
            currentUrl: status.currentUrl,
            guidance:
              loggedIn === true
                ? alreadyLoggedIn
                  ? "Already logged in; no browser window was shown. You can call webchat_ask."
                  : "Login detected. The session is saved; you can now call webchat_ask."
                : "Login not detected yet. Finish the login in the open browser window, then call webchat_status.",
          });
        });
      } catch (err) {
        log(`webchat_login failed: ${err instanceof Error ? err.message : String(err)}`);
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "webchat_logout",
    {
      title: "登出網頁聊天服務（不開瀏覽器視窗）",
      description:
        "Log out of the chosen service by clearing its cookies from the built-in browser profile (headless, no window shown), " +
        "then re-check the login state. Logging out of gemini clears google.com cookies, which signs the profile out of Google. " +
        "Use webchat_login to log in again. Guest use (where the service allows it) keeps working.",
      inputSchema: { provider: providerField },
    },
    async ({ provider }) => {
      try {
        return await withBrowserLock(async () => {
          const { domains, loggedIn } = await session.logout(provider);
          log(`${provider}: logged out (cleared cookies for ${domains.join(", ")}); loggedIn=${String(loggedIn)}`);
          return jsonResult({
            provider,
            loggedOut: loggedIn !== true,
            loggedIn,
            clearedDomains: domains,
            guidance:
              loggedIn === true
                ? "Cookies were cleared but the page still looks logged in; call webchat_status to re-check."
                : "Logged out. Call webchat_login to log in again.",
          });
        });
      } catch (err) {
        log(`webchat_logout failed: ${err instanceof Error ? err.message : String(err)}`);
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "webchat_ask",
    {
      title: "以無痕聊天送出提示",
      description:
        "Send a prompt through a fresh private/temporary chat of the chosen service in the built-in browser and return the answer text. " +
        "Every call opens a brand-new chat: the prompt is not added to the account's chat history. " +
        "Works without logging in (guest) on chatgpt and gemini; claude and grok require webchat_login (a guest gets a logged_out error). " +
        "Optionally select a model first via `model` (labels as returned by webchat_models). " +
        "Prompts are typed exactly as given, including multi-line text.",
      inputSchema: {
        provider: providerField,
        prompt: z.string().min(1).describe("The prompt text to send."),
        model: z
          .string()
          .optional()
          .describe("Optional model label (from webchat_models) to switch to before sending."),
        timeout_seconds: z
          .number()
          .int()
          .min(10)
          .max(600)
          .optional()
          .describe(`How long to wait for the answer (default ${Math.round(TIMEOUTS.answerMs / 1000)}s).`),
      },
    },
    async ({ provider, prompt, model, timeout_seconds }) => {
      try {
        const timeoutMs = (timeout_seconds ?? TIMEOUTS.answerMs / 1000) * 1000;
        const { answer, prefix, notes } = await runAsk(provider, prompt, { timeoutMs, model });
        const suffix = notes.length > 0 ? `\n\n[${APP.program}] ${notes.join("；")}` : "";
        return { content: [{ type: "text", text: prefix + answer + suffix }] };
      } catch (err) {
        log(`webchat_ask failed: ${err instanceof Error ? err.message : String(err)}`);
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "webchat_models",
    {
      title: "列出可用的模型與思考深度",
      description:
        "List the models and thinking-depth options available for the chosen service (scraped live from its model menu, " +
        "so account tier differences are handled automatically). `models` entries have a `label` (use it with webchat_ask's `model`) " +
        "and `current`. `thinking` lists the thinking depth / effort levels (ChatGPT slider, Claude effort, Gemini extended thinking) " +
        "with `current`; it is empty for services without such a setting (Grok folds it into its modes). " +
        "Works as a guest where the service shows a model menu.",
      inputSchema: { provider: providerField },
    },
    async ({ provider }) => {
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
      } catch (err) {
        log(`webchat_models failed: ${err instanceof Error ? err.message : String(err)}`);
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "webchat_status",
    {
      title: "回報瀏覽器與連線狀態",
      description:
        "Report whether the built-in browser is running, whether the login is active for the given service (defaults to the service of the current page), " +
        "whether the current page is in private/temporary-chat mode, the profile directory, and the HTTP endpoint state. " +
        "Does not navigate: it inspects the page the browser is currently on.",
      inputSchema: {
        provider: z.enum(ids).optional().describe(`Service to report on (${providerList}); default: the service of the current page.`),
      },
    },
    async ({ provider }) => {
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
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "webchat_close",
    {
      title: "關閉內建瀏覽器",
      description:
        "Close the built-in browser cleanly. The login sessions stay saved in the profile directory and will be reused next time.",
      inputSchema: {},
    },
    async () => {
      try {
        return await withBrowserLock(async () => {
          await session.close();
          log("browser closed");
          return jsonResult({ closed: true, profileDir: session.profileDir });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  // stdio：供 MCP 用戶端以子程序啟動
  // 先載入外掛（新增的聊天服務），工具的 provider 選項才會包含它們。
  const plugins = loadPlugins();
  for (const { id, file } of plugins.loaded) log(`plugin loaded: ${id} (${file})`);
  for (const { file, reason } of plugins.skipped) log(`plugin skipped: ${file} — ${reason}`);
  const stdioServer = buildServer();
  await stdioServer.connect(new StdioServerTransport());

  // HTTP：開 port 讓客戶端直接連線（port 見 src/config.ts SERVER.httpPort）
  const http = await startHttpServer(buildServer, log, await loadBridges());
  httpInfo = http.info;

  log(
    `${APP.program} v${APP.version} ready — stdio + ` +
      (http.info.enabled ? `http ${http.info.url}` : "http disabled") +
      `; profile=${session.profileDir}`,
  );

  const shutdown = async () => {
    await http.close().catch(() => {});
    await session.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
