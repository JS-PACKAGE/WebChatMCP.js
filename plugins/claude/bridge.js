/**
 * WebChatMCP.js — Claude 橋接（Anthropic Messages 協定）。
 *
 * Claude Code 的 `ANTHROPIC_BASE_URL` 指到 `http://127.0.0.1:<port>/claude` 之後：
 * - `POST /claude/v1/messages`              ：model 是 `webchat/<服務>[/<模型標籤>]` 就送進網頁聊天並以 SSE 回覆，其他一律原樣轉送官方；
 * - `POST /claude/v1/messages/count_tokens` ：網頁模型回估算值，其他原樣轉送；
 * - `GET  /claude/webchat/health`           ：安裝腳本用來確認伺服器版本支援橋接；
 * - `POST /claude/webchat/refresh`          ：向各服務擷取模型標籤（安裝腳本據此寫入 modelPicker）。
 * 其他路徑原樣轉送。
 *
 * 紀律：只轉送 Authorization／x-api-key 等標頭給官方後端，不讀取內容、不記錄、不儲存；網頁路徑完全不看憑證。
 * 網頁聊天沒有工具呼叫：只取使用者／助理的文字，Claude Code 的系統提示與工具定義一律不送。
 */

import { randomUUID } from "node:crypto";
import { APP, CLAUDE, PROVIDERS, providerIds, TIMEOUTS } from "../../dist/config.js";
import { abortOnClose, decodeBody, fetchUpstream, pipeUpstream, readRaw, sendJson } from "../lib/bridgekit.js";

// ───────────────────────── 模型 id 與清單 ─────────────────────────

export function slugOf(provider, label) {
  return label ? `${CLAUDE.slugPrefix}/${provider}/${label}` : `${CLAUDE.slugPrefix}/${provider}`;
}

/** `webchat/chatgpt` → {chatgpt}；`webchat/gemini/3.5 Flash-Lite` → {gemini, "3.5 Flash-Lite"}；其他回 null。 */
export function parseSlug(model) {
  if (typeof model !== "string") return null;
  const head = `${CLAUDE.slugPrefix}/`;
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
  return entry.label ? `${service} · ${entry.label} ${CLAUDE.nameSuffix}` : `${service} ${CLAUDE.nameSuffix}`;
}

/** 每個服務一筆「目前選用的模型」，加上擷取到的標籤。 */
export function entriesFrom(labelsByProvider) {
  const entries = [];
  for (const provider of providerIds()) {
    entries.push({ provider });
    for (const label of new Set(labelsByProvider[provider] ?? [])) if (label) entries.push({ provider, label });
  }
  return entries;
}

/** 安裝腳本寫入 modelPicker 用的資料：id＝送給 API 的 model、name＝選單上的名稱（結尾 (WEB)）。 */
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
      deps.log(`claude refresh: ${provider} skipped — ${message}`);
      failed.push({ provider, message });
    }
  }
  return { count: Object.values(labels).reduce((n, l) => n + l.length, 0), models: modelRows(entriesFrom(labels)), failed };
}

// ───────────────────────── Messages 輸入 → 提示 ─────────────────────────

/** Claude Code 自己塞進使用者訊息的區塊（CLAUDE.md、git 狀態等），不是使用者說的話。 */
const HARNESS_BLOCK = /^\s*<system-reminder>/;

function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return typeof block.text === "string" ? block.text : "";
  if (block.type === "image") return "[圖片已省略：網頁聊天無法接收圖片]";
  return "";
}

/**
 * 每次網頁提問都是全新的無痕聊天，所以把對話攤平成一個提示。只取使用者與助理的文字：
 * system、工具定義、tool_use／tool_result、thinking 都不送。
 */
export function flattenMessages(messages) {
  if (!Array.isArray(messages)) return "";
  const turns = [];
  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const content = message.content;
    const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.map(blockText) : [];
    const text = texts
      .filter((t) => t.trim() !== "" && !(message.role === "user" && HARNESS_BLOCK.test(t)))
      .join("\n")
      .trim();
    if (text) turns.push({ role: message.role === "user" ? "User" : "Assistant", text });
  }
  if (turns.length === 0) return "";
  if (turns.length === 1 && turns[0].role === "User") return turns[0].text;
  const body = turns.map((t) => `${t.role}:\n${t.text}`).join("\n\n");
  return turns[turns.length - 1].role === "Assistant"
    ? body
    : `以下是目前為止的對話，請接著以 Assistant 的身分回覆最後一則訊息（只輸出回覆內容）。\n\n${body}\n\nAssistant:`;
}

// ───────────────────────── Messages SSE ─────────────────────────

export const estimateTokens = (text) => Math.ceil(text.length / 4);

export function newMessageId() {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

function messageObject(id, model, content, stopReason, usage) {
  return { id, type: "message", role: "assistant", model, content, stop_reason: stopReason, stop_sequence: null, usage };
}

export function startEvents(id, model, inputTokens) {
  return [
    { event: "message_start", data: { type: "message_start", message: messageObject(id, model, [], null, { input_tokens: inputTokens, output_tokens: 1 }) } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "ping", data: { type: "ping" } },
  ];
}

/** 整段文字一次到齊：delta → block_stop → message_delta → message_stop。 */
export function answerEvents(answer) {
  return [
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: estimateTokens(answer) } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

export function errorEvents(message) {
  return [{ event: "error", data: { type: "error", error: { type: "api_error", message } } }];
}

export function encodeSse(events) {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

export function messageJson(id, model, prompt, answer) {
  return messageObject(id, model, [{ type: "text", text: answer }], "end_turn", {
    input_tokens: estimateTokens(prompt),
    output_tokens: estimateTokens(answer),
  });
}

// ───────────────────────── 橋接本體 ─────────────────────────

function sendError(res, status, type, message) {
  sendJson(res, status, { type: "error", error: { type, message } });
}

function upstreamBase() {
  return (CLAUDE.upstreamOverride ?? CLAUDE.upstream).replace(/\/+$/, "");
}

export function createBridge(deps) {
  async function passthrough(req, res, url, rest, raw) {
    const controller = abortOnClose(req, res);
    try {
      const body = raw ?? (req.method === "GET" || req.method === "HEAD" ? undefined : await readRaw(req));
      const upstream = await fetchUpstream(req, url, upstreamBase(), rest, body, controller.signal);
      await pipeUpstream(upstream, res);
    } catch (err) {
      if (controller.signal.aborted) return;
      deps.log(`claude upstream error (${req.method} ${rest}): ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendError(res, 502, "api_error", "WebChatMCP 無法連到官方後端");
      else res.destroy();
    }
  }

  /** 讀取並解碼 JSON 本文；解不開（不支援的編碼、不是 JSON）回 body=null，由呼叫端原樣轉送。 */
  async function readJson(req) {
    const raw = await readRaw(req);
    try {
      const decoded = decodeBody(raw, req.headers["content-encoding"]);
      return { raw, body: decoded ? JSON.parse(decoded.toString("utf8")) : null };
    } catch {
      return { raw, body: null };
    }
  }

  async function messages(req, res, url) {
    let parsed;
    try {
      parsed = await readJson(req);
    } catch (err) {
      sendError(res, 413, "invalid_request_error", err instanceof Error ? err.message : String(err));
      return;
    }
    const { raw, body } = parsed;
    const target = parseSlug(body?.model);
    if (!body || !target) {
      await passthrough(req, res, url, "/v1/messages", raw);
      return;
    }

    const model = String(body.model);
    const prompt = flattenMessages(body.messages);
    if (prompt.trim() === "") {
      sendError(res, 400, "invalid_request_error", "沒有可以送出的使用者訊息");
      return;
    }

    const id = newMessageId();
    const controller = abortOnClose(req, res);
    const stream = body.stream === true;
    let keepAlive;
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(encodeSse(startEvents(id, model, estimateTokens(prompt))));
      keepAlive = setInterval(() => res.write(encodeSse([{ event: "ping", data: { type: "ping" } }])), CLAUDE.keepAliveMs);
    }

    try {
      const { answer, notes } = await deps.ask(target.provider, prompt, {
        model: target.label,
        timeoutMs: TIMEOUTS.answerMs,
        signal: controller.signal,
      });
      if (notes.length > 0) deps.log(`claude ${slugOf(target.provider, target.label)}: ${notes.join("；")}`);
      if (controller.signal.aborted) return;
      if (stream) {
        res.write(encodeSse(answerEvents(answer)));
        res.end();
      } else {
        sendJson(res, 200, messageJson(id, model, prompt, answer));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`claude ${slugOf(target.provider, target.label)} failed: ${message}`);
      if (stream) {
        res.write(encodeSse(errorEvents(message)));
        res.end();
      } else {
        sendError(res, 502, "api_error", message);
      }
    } finally {
      clearInterval(keepAlive);
    }
  }

  async function countTokens(req, res, url) {
    let parsed;
    try {
      parsed = await readJson(req);
    } catch (err) {
      sendError(res, 413, "invalid_request_error", err instanceof Error ? err.message : String(err));
      return;
    }
    const { raw, body } = parsed;
    if (!body || !parseSlug(body.model)) {
      await passthrough(req, res, url, "/v1/messages/count_tokens", raw);
      return;
    }
    sendJson(res, 200, { input_tokens: estimateTokens(flattenMessages(body.messages)) });
  }

  return async (req, res, url) => {
    const rest = url.pathname.slice(CLAUDE.path.length) || "/";
    const method = req.method ?? "GET";

    if (rest === "/webchat/health" && method === "GET") {
      sendJson(res, 200, { ok: true, name: APP.name, version: APP.version, providers: providerIds(), models: modelRows(entriesFrom({})) });
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
    if (rest === "/v1/messages" && method === "POST") {
      await messages(req, res, url);
      return;
    }
    if (rest === "/v1/messages/count_tokens" && method === "POST") {
      await countTokens(req, res, url);
      return;
    }
    await passthrough(req, res, url, rest);
  };
}
