/**
 * WebChatMCP.js — Grok 橋接（chat_completions 協定，給 Grok Build 的自訂模型用）。
 *
 * Grok Build 的 `[model.<id>]` 以 `base_url = http://127.0.0.1:<port>/grok` 指到這裡之後：
 * - `POST /grok/chat/completions`  ：model 是 `webchat/<服務>[/<模型標籤>]` 就送進網頁聊天並以 SSE 回覆；其他 model 回 404；
 * - `GET  /grok/webchat/health`    ：安裝腳本用來確認伺服器版本支援橋接；
 * - `POST /grok/webchat/refresh`   ：向各服務擷取模型標籤（安裝腳本據此寫入 config.toml）。
 * 只有網頁模型會走這裡，官方模型不經過本機。
 *
 * 紀律：Grok 會把它的登入標頭一起送來；橋接完全不讀、不記錄、不轉送，也不會連到 xAI。
 * 工具要求只接受經驗證的 JSON 信封，轉為原生工具呼叫後由 Grok 在自己的權限下執行。
 */

import { randomUUID } from "node:crypto";
import { APP, GROK, PROVIDERS, providerIds, TIMEOUTS } from "../../dist/config.js";
import { abortOnClose, readRaw, sendJson } from "../lib/bridgekit.js";
import { createToolExchange } from "../lib/tool-protocol.js";

// ───────────────────────── 模型 id 與清單 ─────────────────────────

export function slugOf(provider, label) {
  return label ? `${GROK.slugPrefix}/${provider}/${label}` : `${GROK.slugPrefix}/${provider}`;
}

/** `webchat/chatgpt` → {chatgpt}；`webchat/gemini/3.5 Flash-Lite` → {gemini, "3.5 Flash-Lite"}；其他回 null。 */
export function parseSlug(model) {
  if (typeof model !== "string") return null;
  const head = `${GROK.slugPrefix}/`;
  if (!model.startsWith(head)) return null;
  const rest = model.slice(head.length);
  const slash = rest.indexOf("/");
  const provider = slash < 0 ? rest : rest.slice(0, slash);
  if (!providerIds().includes(provider)) return null;
  const label = slash < 0 ? "" : rest.slice(slash + 1);
  return label ? { provider, label } : { provider };
}

export function displayName(entry) {
  const service = PROVIDERS[entry.provider]?.label ?? entry.provider;
  return entry.label ? `${service} · ${entry.label} ${GROK.nameSuffix}` : `${service} ${GROK.nameSuffix}`;
}

/** 只列有模型標籤的項目；沒有模型的服務名稱不進清單。 */
export function entriesFrom(labelsByProvider) {
  const entries = [];
  for (const provider of providerIds()) {
    for (const label of new Set(labelsByProvider[provider] ?? [])) if (label) entries.push({ provider, label });
  }
  return entries;
}

/** 安裝腳本寫入 config.toml 用的資料：id＝`-m` 與送給 API 的 model、name＝選單上的名稱（結尾 (WEB)）。 */
export function modelRows(entries) {
  return entries.map((e) => ({ id: slugOf(e.provider, e.label), name: displayName(e) }));
}

/** 向各服務擷取模型標籤；某個服務失敗（例如沒登入）只略過它。 */
export async function refreshLabels(deps) {
  const labels = {};
  const failed = [];
  for (const provider of providerIds()) {
    try {
      labels[provider] = await deps.listLabels(provider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`grok refresh: ${provider} skipped — ${message}`);
      failed.push({ provider, message });
    }
  }
  return { count: Object.values(labels).reduce((n, l) => n + l.length, 0), models: modelRows(entriesFrom(labels)), failed };
}

// ───────────────────────── messages 輸入 → 提示 ─────────────────────────

const USER_QUERY = /^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/;

function partText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (part.type === "text") return typeof part.text === "string" ? part.text : "";
  if (part.type === "image_url") return "[圖片已省略：網頁聊天無法接收圖片]";
  return "";
}

/** 每輪重送完整對話；只有合法的工具信封能轉成宿主工具呼叫。 */
export function messageExchange(body) {
  const turns = [];
  const system = [];
  const names = new Map();
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message) continue;
    const content = message.content;
    let text;
    if (typeof content === "string") {
      text = message.role === "user" ? content.match(USER_QUERY)?.[1] ?? content : content;
    } else {
      const parts = [];
      for (const part of Array.isArray(content) ? content : []) {
        const value = partText(part);
        if (!value) continue;
        parts.push(message.role === "user" ? value.match(USER_QUERY)?.[1] ?? value : value);
      }
      text = parts.join("\n");
    }
    if (message.role === "system" || message.role === "developer") {
      if (text) system.push(text);
    } else if (message.role === "assistant") {
      const calls = (message.tool_calls ?? []).filter((call) => call.type === "function").map((call) => {
        names.set(call.id, call.function.name);
        return { id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) };
      });
      if (text || calls.length) turns.push({ role: "assistant", text, calls });
    } else if (message.role === "tool") {
      turns.push({ role: "tool", id: message.tool_call_id, name: names.get(message.tool_call_id) ?? message.name ?? "unknown", text });
    } else if (message.role === "user" && text) {
      turns.push({ role: "user", text });
    }
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((tool) => tool.type === "function")
    .map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
  return createToolExchange({
    system: system.join("\n\n"), turns, tools,
    toolChoice: typeof body.tool_choice === "object" ? body.tool_choice?.function?.name : body.tool_choice,
    parallelToolCalls: body.parallel_tool_calls,
  });
}

// ───────────────────────── chat.completion SSE ─────────────────────────

export const estimateTokens = (text) => Math.ceil(text.length / 4);

export function newCompletionId() {
  return `chatcmpl-${randomUUID().replace(/-/g, "")}`;
}

function chunk(id, model, created, delta, finishReason, usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

export function usageOf(prompt, answer) {
  const input = estimateTokens(prompt);
  const output = estimateTokens(answer);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

/** 起手式：角色 delta（先送出，等待網頁回覆期間連線才不會被視為閒置）。 */
export function startChunks(id, model, created) {
  return [chunk(id, model, created, { role: "assistant", content: "" }, null)];
}

/** 文字先送，再送各工具的名稱／id 與參數，最後送結束原因與用量。 */
export function answerChunks(id, model, created, prompt, answer, calls = [], usageAnswer = answer) {
  const chunks = [];
  if (answer || calls.length === 0) chunks.push(chunk(id, model, created, { content: answer }, null));
  calls.forEach((call, index) => {
    chunks.push(chunk(id, model, created, { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] }, null));
    chunks.push(chunk(id, model, created, { tool_calls: [{ index, function: { arguments: JSON.stringify(call.arguments) } }] }, null));
  });
  chunks.push(chunk(id, model, created, {}, calls.length ? "tool_calls" : "stop"));
  chunks.push({ id, object: "chat.completion.chunk", created, model, choices: [], usage: usageOf(prompt, usageAnswer) });
  return chunks;
}

export function encodeSse(chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
}

export const SSE_DONE = "data: [DONE]\n\n";

export function completionJson(id, model, created, prompt, answer, calls = [], usageAnswer = answer) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: answer || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: usageOf(prompt, usageAnswer),
  };
}

// ───────────────────────── 橋接本體 ─────────────────────────

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { message, type: code, code } });
}

export function createBridge(deps) {
  async function completions(req, res) {
    let body;
    try {
      body = JSON.parse((await readRaw(req)).toString("utf8"));
    } catch {
      sendError(res, 400, "invalid_request_error", "請求本文不是合法的 JSON");
      return;
    }
    const target = parseSlug(body?.model);
    if (!target) {
      // 例如 Grok 產生對話標題時用的內建模型：橋接只服務網頁模型，也不會把請求（含登入標頭）轉到別處。
      sendError(res, 404, "model_not_found", `這個端點只服務 ${GROK.slugPrefix}/<服務> 的網頁模型，沒有 ${String(body?.model)}`);
      return;
    }

    const model = String(body.model);
    let exchange;
    try {
      exchange = messageExchange(body);
    } catch (err) {
      sendError(res, 400, "invalid_request_error", err instanceof Error ? err.message : String(err));
      return;
    }
    const prompt = exchange.prompt;
    if (prompt.trim() === "") {
      sendError(res, 400, "invalid_request_error", "沒有可以送出的使用者訊息");
      return;
    }

    const id = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const controller = abortOnClose(req, res);
    const stream = body.stream === true;
    let keepAlive;
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
      res.write(encodeSse(startChunks(id, model, created)));
      // Pending bytes already keep the stream active; do not queue redundant heartbeats behind them.
      keepAlive = setInterval(() => {
        if (!controller.signal.aborted && !res.writableNeedDrain) res.write(": keep-alive\n\n");
      }, GROK.keepAliveMs);
    }

    try {
      const { answer, notes } = await deps.ask(target.provider, prompt, {
        model: target.label,
        timeoutMs: TIMEOUTS.answerMs,
        signal: controller.signal,
      });
      if (notes.length > 0) deps.log(`grok ${slugOf(target.provider, target.label)}: ${notes.join("；")}`);
      if (controller.signal.aborted) return;
      const parsed = exchange.parse(answer);
      if (stream) {
        res.write(encodeSse(answerChunks(id, model, created, prompt, parsed.text, parsed.calls, answer)) + SSE_DONE);
        res.end();
      } else {
        sendJson(res, 200, completionJson(id, model, created, prompt, parsed.text, parsed.calls, answer));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`grok ${slugOf(target.provider, target.label)} failed: ${message}`);
      if (stream) {
        // 串流已經開始：以 error 事件回報（OpenAI 串流的錯誤格式），然後結束。
        res.write(`data: ${JSON.stringify({ error: { message, type: "api_error", code: "browser_error" } })}\n\n${SSE_DONE}`);
        res.end();
      } else {
        sendError(res, 502, "api_error", message);
      }
    } finally {
      clearInterval(keepAlive);
    }
  }

  return async (req, res, url) => {
    const rest = url.pathname.slice(GROK.path.length) || "/";
    const method = req.method ?? "GET";

    if (rest === "/webchat/health" && method === "GET") {
      sendJson(res, 200, { ok: true, name: APP.name, version: APP.version, providers: providerIds(), models: modelRows(entriesFrom({})), contextWindow: GROK.contextWindow });
      return;
    }
    if (rest === "/webchat/refresh" && method === "POST") {
      req.resume();
      try {
        sendJson(res, 200, await refreshLabels(deps));
      } catch (err) {
        sendError(res, 500, "api_error", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (rest === "/chat/completions" && method === "POST") {
      await completions(req, res);
      return;
    }
    req.resume();
    sendError(res, 404, "not_found", `沒有這個路徑：${rest}`);
  };
}
