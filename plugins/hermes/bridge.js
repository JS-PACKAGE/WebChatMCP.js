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
 * 網頁聊天沒有工具呼叫：只取使用者／助理的文字，Hermes 的系統提示與工具定義一律不送。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { APP, HERMES, providerIds, TIMEOUTS } from "../../dist/config.js";
import { abortOnClose, readRaw, sendJson } from "../lib/bridgekit.js";

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

function readCache(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const out = {};
    for (const [provider, labels] of Object.entries(parsed.providers ?? {})) {
      if (Array.isArray(labels)) out[provider] = labels.filter((l) => typeof l === "string" && l !== "");
    }
    return out;
  } catch {
    return {};
  }
}

/** 只列快取到的模型標籤；沒有模型的服務名稱不進清單。 */
export function modelIds(file = modelsFilePath()) {
  const cache = readCache(file);
  const ids = [];
  for (const provider of providerIds()) {
    for (const label of new Set(cache[provider] ?? [])) if (label) ids.push(modelId(provider, label));
  }
  return ids;
}

export function recordModels(provider, labels, file = modelsFilePath()) {
  const providers = readCache(file);
  providers[provider] = [...new Set(labels.filter((l) => l !== ""))];
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), providers }, null, 2));
  renameSync(tmp, file);
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

/**
 * 每次網頁提問都是全新的無痕聊天，所以把對話攤平成一個提示。只取使用者與助理的文字：
 * system、工具定義與工具結果都不送。
 */
export function flattenMessages(messages) {
  if (!Array.isArray(messages)) return "";
  const turns = [];
  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const content = message.content;
    const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.map(partText) : [];
    const text = parts.filter((t) => t.trim() !== "").join("\n").trim();
    if (text) turns.push({ role: message.role === "user" ? "User" : "Assistant", text });
  }
  if (turns.length === 0) return "";
  if (turns.length === 1 && turns[0].role === "User") return turns[0].text;
  const body = turns.map((t) => `${t.role}:\n${t.text}`).join("\n\n");
  return turns[turns.length - 1].role === "Assistant"
    ? body
    : `以下是目前為止的對話，請接著以 Assistant 的身分回覆最後一則訊息（只輸出回覆內容）。\n\n${body}\n\nAssistant:`;
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

/** 整段文字一次到齊：內容 delta → finish_reason 結束 → 用量。 */
export function answerChunks(id, model, created, prompt, answer) {
  return [
    chunk(id, model, created, { content: answer }, null),
    chunk(id, model, created, {}, "stop"),
    { id, object: "chat.completion.chunk", created, model, choices: [], usage: usageOf(prompt, answer) },
  ];
}

export const encodeSse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
export const SSE_DONE = "data: [DONE]\n\n";

export function completionJson(id, model, created, prompt, answer) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
    usage: usageOf(prompt, answer),
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
    const prompt = flattenMessages(body.messages);
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
      if (stream) {
        res.write(encodeSse(answerChunks(id, model, created, prompt, answer)) + SSE_DONE);
        res.end();
      } else {
        sendJson(res, 200, completionJson(id, model, created, prompt, answer));
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
