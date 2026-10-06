/**
 * WebChatMCP.js × Oh My Pi — 把 WebChatMCP 變成 omp 的模型提供商「webchat」。
 *
 * 載入後 omp 會多出提供商 `webchat`。模型清單只有 `/webchat-refresh` 取得的
 * `webchat/<服務>/<模型標籤>`，不會放入沒有模型的服務名稱。
 * 每次對話都經由 webchat_ask 在臨時聊天中完成；驗證後的工具要求交由 omp 執行，不支援圖片。
 *
 * 環境變數：WEBCHATMCP_URL（預設 http://127.0.0.1:8321/mcp）、WEBCHATMCP_OMP_TIMEOUT（秒，預設 300）、
 * WEBCHATMCP_OMP_INCLUDE_SYSTEM（1＝無工具時也送 omp 系統提示；有工具時一律送）、WEBCHATMCP_OMP_CACHE（模型快取檔位置）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildModels,
  createStreamSimple,
  loginTargets,
  DEFAULT_SERVICES,
  McpHttpClient,
  PROVIDER_NAME,
  serviceLabel,
} from "./core.js";

const URL = process.env.WEBCHATMCP_URL ?? "http://127.0.0.1:8321/mcp";
const CACHE = process.env.WEBCHATMCP_OMP_CACHE ?? join(homedir(), ".omp", "agent", "webchat-models.json");
const TIMEOUT_SECONDS = Math.min(600, Math.max(10, Number(process.env.WEBCHATMCP_OMP_TIMEOUT ?? 300) || 300));
const INCLUDE_SYSTEM = process.env.WEBCHATMCP_OMP_INCLUDE_SYSTEM === "1";

/** 依 omp 的 ProviderConfig 的 `api` 欄位：自訂 API 代號，由 streamSimple 處理。 */
const API = "webchatmcp";

function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE, "utf8"));
    const services = Array.isArray(parsed.services) ? parsed.services.filter((s) => typeof s === "string") : [];
    const models = Array.isArray(parsed.models)
      ? parsed.models.filter((m) => typeof m?.service === "string" && typeof m?.label === "string")
      : [];
    return { services, models };
  } catch {
    return { services: [], models: [] };
  }
}

function writeCache(state) {
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify({ updatedAt: new Date().toISOString(), ...state }, null, 2));
}

export default async function webchat(pi) {
  // createAssistantMessageEventStream 由 omp 提供；放在函式內動態載入，核心邏輯才能脫離 omp 單獨測試。
  const { createAssistantMessageEventStream } = await import("@oh-my-pi/pi-ai");
  const client = new McpHttpClient(URL);
  const streamSimple = createStreamSimple(client, createAssistantMessageEventStream, {
    includeSystem: INCLUDE_SYSTEM,
    timeoutSeconds: TIMEOUT_SECONDS,
  });

  const register = (state) => {
    const services = state.services.length > 0 ? state.services : DEFAULT_SERVICES;
    pi.registerProvider(PROVIDER_NAME, {
      baseUrl: URL,
      // 本地 MCP 端點沒有金鑰；給一個固定字串讓 omp 視為已設定憑證。
      apiKey: "webchatmcp-local",
      api: API,
      streamSimple,
      models: buildModels(services, state.models).map((model) => ({ ...model, api: API })),
    });
  };

  register(readCache());

  pi.registerCommand("webchat-refresh", {
    description: "向 WebChatMCP 伺服器取得各服務目前可用的模型，更新 webchat 提供商的模型清單",
    handler: async (_args, ctx) => {
      ctx.ui.notify("webchat：正在讀取各服務的模型清單（每個服務約需 10 秒）…", "info");
      const services = await client.listServices();
      const models = [];
      const failed = [];
      for (const service of services) {
        try {
          const payload = JSON.parse(await client.callTool("webchat_models", { provider: service }));
          for (const entry of payload.models ?? []) models.push({ service, label: entry.label });
        } catch (err) {
          failed.push(`${serviceLabel(service)}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const state = { services, models };
      writeCache(state);
      register(state);
      ctx.ui.notify(`webchat：已更新，共 ${models.length} 個模型。`, "info");
      for (const line of failed) ctx.ui.notify(`webchat：略過 ${line}`, "warning");
    },
  });

  pi.registerCommand("webchat-login", {
    description: "登入網頁聊天服務：/webchat-login [chatgpt|claude|grok|gemini…]（省略＝全部檢查；已登入不開視窗）",
    handler: async (args, ctx) => {
      try {
        const services = loginTargets(args, await client.listServices());
        ctx.ui.notify(`webchat：檢查 ${services.map(serviceLabel).join("、")} 的登入狀態…`, "info");
        for (const service of services) {
          try {
            const payload = JSON.parse(await client.callTool("webchat_login", { provider: service }));
            ctx.ui.notify(
              `webchat：${serviceLabel(service)} — ${payload.guidance ?? JSON.stringify(payload)}`,
              payload.loggedIn === true ? "info" : "warning",
            );
          } catch (err) {
            ctx.ui.notify(`webchat：${serviceLabel(service)} — ${err instanceof Error ? err.message : String(err)}`, "error");
          }
        }
      } catch (err) {
        ctx.ui.notify(`webchat：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("webchat-logout", {
    description: "登出網頁聊天服務：/webchat-logout [chatgpt|claude|grok|gemini]（不開視窗）",
    handler: async (args, ctx) => {
      const service = (typeof args === "string" ? args : "").trim() || "chatgpt";
      try {
        const payload = JSON.parse(await client.callTool("webchat_logout", { provider: service }));
        ctx.ui.notify(`webchat：${payload.guidance ?? JSON.stringify(payload)}`, "info");
      } catch (err) {
        ctx.ui.notify(`webchat：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
