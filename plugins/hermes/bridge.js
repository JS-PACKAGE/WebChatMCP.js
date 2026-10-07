/**
 * WebChatMCP.js — Hermes 橋接（OpenAI chat_completions 協定，給 Hermes Agent 的 `webchat` 模型提供商用）。
 *
 * Hermes 的提供商外掛以 `base_url = http://127.0.0.1:<port>/hermes` 連到這裡：
 * - `GET  /hermes/models`          ：模型清單（只含快取到的 `<服務>/<模型標籤>`）；
 * - `POST /hermes/chat/completions`：送進網頁聊天並以 SSE 回覆；model 是 `<服務>/<模型標籤>`（沒有標籤的服務名稱不進清單）；
 * - `GET  /hermes/webchat/health`  ：安裝腳本用來確認伺服器版本支援橋接；
 * - `POST /hermes/webchat/refresh` ：向各服務擷取模型標籤並更新快取。
 *
 * 紀律：Hermes 送來的任何憑證標頭，橋接完全不讀、不記錄、不轉送，也不會連到其他主機。
 * 工具要求只接受經驗證的 JSON 信封，轉為原生工具呼叫後由 Hermes 在自己的權限下執行。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { APP, HERMES, providerIds, TIMEOUTS } from "../../dist/config.js";
import { abortOnClose, readRaw, sendJson } from "../lib/bridgekit.js";
import { createToolExchange } from "../lib/tool-protocol.js";

// ───────────────────────── 模型 id 與清單 ─────────────────────────

/** `chatgpt` → {chatgpt}；`gemini/3.5 Flash-Lite` → {gemini, "3.5 Flash-Lite"}；服務不存在回 null。 */
export function parseModel(model) {
  if (typeof model !== "string" || model === "") return null;
  const slash = model.indexOf("/");
  const provider = slash < 0 ? model : model.slice(0, slash);
  if (!providerIds().includes(provider)) return null;
  const label = slash < 0 ? "" : model.slice(slash + 1);
  return label ? { provider, label } : { provider };
}

export function modelId(provider, label) {
  return label ? `${provider}/${label}` : provider;
}

function expandHome(path) {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function modelsFilePath() {
  return expandHome(HERMES.modelsFile);
}

// File metadata is checked on every access so external edits and atomic replacements are immediately visible.
const modelCaches = new Map();
const MODEL_CACHE_LIMIT = 8;

function readCache(file) {
  let key = file;
  try {
    if (typeof file === "string") key = resolve(file);
    const stat = statSync(key, { bigint: true });
    const previous = modelCaches.get(key);
    if (previous && previous.stat.dev === stat.dev && previous.stat.ino === stat.ino
      && previous.stat.size === stat.size && previous.stat.mtimeNs === stat.mtimeNs && previous.stat.ctimeNs === stat.ctimeNs) {
      return previous.providers;
    }
    const parsed = JSON.parse(readFileSync(key, "utf8"));
    const out = {};
    for (const [provider, labels] of Object.entries(parsed.providers ?? {})) {
      if (Array.isArray(labels)) out[provider] = [...new Set(labels.filter((l) => typeof l === "string" && l !== ""))];
    }
    modelCaches.delete(key);
    if (modelCaches.size >= MODEL_CACHE_LIMIT) modelCaches.delete(modelCaches.keys().next().value);
    modelCaches.set(key, { stat, providers: out });
    return out;
  } catch {
    modelCaches.delete(key);
    return {};
  }
}

/** 只列快取到的模型標籤；沒有模型的服務名稱不進清單。 */
export function modelIds(file = modelsFilePath()) {
  const cache = readCache(file);
  const ids = [];
  for (const provider of providerIds()) {
    for (const label of cache[provider] ?? []) ids.push(modelId(provider, label));
  }
  return ids;
}

export function recordModels(provider, labels, file = modelsFilePath()) {
  const providers = { ...readCache(file) };
  providers[provider] = [...new Set(labels.filter((l) => l !== ""))];
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), providers }, null, 2));
  renameSync(tmp, file);
  modelCaches.delete(resolve(file));
}

/** OpenAI 格式的 /models 回應。 */
export function modelsResponse(file = modelsFilePath()) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: modelIds(file).map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "webchatmcp",
      context_length: HERMES.contextWindow,
    })),
  };
}

export async function refreshModels(deps, file = modelsFilePath()) {
  const counts = {};
  const failed = [];
  for (const provider of providerIds()) {
    try {
      const labels = await deps.listLabels(provider);
      recordModels(provider, labels, file);
      counts[provider] = labels.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`hermes refresh: ${provider} skipped — ${message}`);
      failed.push({ provider, message });
    }
  }
  return { count: Object.values(counts).reduce((a, b) => a + b, 0), providers: counts, failed };
}

// ───────────────────────── messages 輸入 → 提示 ─────────────────────────

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
    const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.map(partText) : [];
    const text = parts.filter((t) => t.trim() !== "").join("\n").trim();
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
  return { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}

export function usageOf(prompt, answer) {
  const input = estimateTokens(prompt);
  const output = estimateTokens(answer);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

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

export const encodeSse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
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

export function createBridge(deps, modelsFile = modelsFilePath()) {
  async function completions(req, res) {
    let body;
    try {
      body = JSON.parse((await readRaw(req)).toString("utf8"));
    } catch {
      sendError(res, 400, "invalid_request_error", "請求本文不是合法的 JSON");
      return;
    }
    const target = parseModel(body?.model);
    if (!target) {
      sendError(res, 404, "model_not_found", `沒有這個模型：${String(body?.model)}（可用：${providerIds().join("、")}，或 <服務>/<模型標籤>）`);
      return;
    }
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

    const model = String(body.model);
    const id = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const controller = abortOnClose(req, res);
    const stream = body.stream === true;
    let keepAlive;
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(encodeSse(startChunks(id, model, created)));
      keepAlive = setInterval(() => res.write(": keep-alive\n\n"), HERMES.keepAliveMs);
    }

    try {
      const { answer, notes } = await deps.ask(target.provider, prompt, { model: target.label, timeoutMs: TIMEOUTS.answerMs, signal: controller.signal });
      if (notes.length > 0) deps.log(`hermes ${model}: ${notes.join("；")}`);
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
      deps.log(`hermes ${model} failed: ${message}`);
      if (stream) {
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
    let rest = url.pathname.slice(HERMES.path.length) || "/";
    if (rest === "/v1" || rest.startsWith("/v1/")) rest = rest.slice(3) || "/";
    const method = req.method ?? "GET";

    if (rest === "/webchat/health" && method === "GET") {
      sendJson(res, 200, { ok: true, name: APP.name, version: APP.version, providers: providerIds() });
      return;
    }
    if (rest === "/webchat/refresh" && method === "POST") {
      req.resume();
      try {
        sendJson(res, 200, await refreshModels(deps, modelsFile));
      } catch (err) {
        sendError(res, 500, "api_error", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (rest === "/models" && method === "GET") {
      sendJson(res, 200, modelsResponse(modelsFile));
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
