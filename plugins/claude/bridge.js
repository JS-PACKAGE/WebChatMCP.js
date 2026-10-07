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
 * 網頁模型透過驗證過的 JSON 信封要求工具，轉成原生 tool_use，由 Claude Code 在自身權限下執行。
 */

import { randomUUID } from "node:crypto";
import { APP, CLAUDE, PROVIDERS, providerIds, TIMEOUTS } from "../../dist/config.js";
import { abortOnClose, decodeBody, fetchUpstream, pipeUpstream, readRaw, sendJson } from "../lib/bridgekit.js";
import { createToolExchange } from "../lib/tool-protocol.js";

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

/** 只列有模型標籤的項目；沒有模型的服務名稱不進清單。 */
export function entriesFrom(labelsByProvider) {
  const entries = [];
  for (const provider of providerIds()) {
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

function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return typeof block.text === "string" ? block.text : "";
  if (block.type === "image") return "[圖片已省略：網頁聊天無法接收圖片]";
  return "";
}

/** 保留完整工具往返與宿主提醒；thinking 不送出。 */
function messageTurns(messages) {
  const turns = [];
  const toolNames = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    if (typeof message.content === "string") {
      const text = message.content;
      if (text) turns.push({ role: message.role, text });
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    let texts = [];
    const calls = [];
    const flush = () => {
      const text = texts.join("\n");
      if (text) turns.push({ role: message.role, text });
      texts = [];
    };
    for (const block of blocks) {
      if (message.role === "assistant" && block?.type === "tool_use") {
        calls.push({ id: block.id, name: block.name, arguments: block.input });
        toolNames.set(block.id, block.name);
      } else if (message.role === "user" && block?.type === "tool_result") {
        flush();
        const text = typeof block.content === "string" ? block.content
          : Array.isArray(block.content) ? block.content.map(blockText).filter(Boolean).join("\n") : "";
        turns.push({ role: "tool", id: block.tool_use_id, name: toolNames.get(block.tool_use_id) ?? "unknown", text, isError: block.is_error === true });
      } else {
        const text = blockText(block);
        if (text) texts.push(text);
      }
    }
    if (message.role === "assistant" && calls.length) {
      turns.push({ role: "assistant", text: texts.join("\n"), calls });
    } else {
      flush();
    }
  }
  return turns;
}

export function createMessagesExchange(body) {
  const choice = body.tool_choice;
  return createToolExchange({
    system: typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map(blockText).filter(Boolean).join("\n") : "",
    turns: messageTurns(body.messages),
    tools: (Array.isArray(body.tools) ? body.tools : []).map((tool) => ({
      name: tool.name, description: tool.description, parameters: tool.input_schema,
    })),
    toolChoice: choice?.type === "any" ? "required" : choice?.type === "tool" ? choice.name : choice?.type ?? "auto",
    parallelToolCalls: choice?.disable_parallel_tool_use !== true,
  });
}

export function flattenMessages(messages) {
  return createMessagesExchange({ messages }).prompt;
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
    // 等回覆到齊才知道第一個區塊是 text 還是 tool_use。
    { event: "ping", data: { type: "ping" } },
  ];
}

/** 網頁回覆整段到齊後，依 Messages 協定逐一輸出內容區塊。 */
function answerContent(answer) {
  const result = typeof answer === "string" ? { text: answer, calls: [] } : answer;
  const content = result.text ? [{ type: "text", text: result.text }] : [];
  for (const call of result.calls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
  return { content, stopReason: result.calls.length ? "tool_use" : "end_turn" };
}

function outputTokens(content) {
  let length = 0;
  for (const block of content) length += (block.type === "text" ? block.text : JSON.stringify(block.input)).length;
  return Math.ceil(length / 4);
}

export function answerEvents(answer) {
  const { content, stopReason } = answerContent(answer);
  const events = [];
  let outputLength = 0;
  content.forEach((block, index) => {
    const text = block.type === "text";
    const value = text ? block.text : JSON.stringify(block.input);
    outputLength += value.length;
    events.push(
      { event: "content_block_start", data: { type: "content_block_start", index, content_block: text ? { type: "text", text: "" } : { ...block, input: {} } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index, delta: text ? { type: "text_delta", text: value } : { type: "input_json_delta", partial_json: value } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index } },
    );
  });
  events.push(
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: Math.ceil(outputLength / 4) } } },
    { event: "message_stop", data: { type: "message_stop" } },
  );
  return events;
}

export function errorEvents(message) {
  return [{ event: "error", data: { type: "error", error: { type: "api_error", message } } }];
}

export function encodeSse(events) {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

export function messageJson(id, model, prompt, answer) {
  const { content, stopReason } = answerContent(answer);
  return messageObject(id, model, content, stopReason, {
    input_tokens: estimateTokens(prompt),
    output_tokens: outputTokens(content),
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
      const decoded = await decodeBody(raw, req.headers["content-encoding"]);
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
    const exchange = createMessagesExchange(body);
    const { prompt } = exchange;
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
        "x-accel-buffering": "no",
      });
      res.write(encodeSse(startEvents(id, model, estimateTokens(prompt))));
      const ping = encodeSse([{ event: "ping", data: { type: "ping" } }]);
      // Pending bytes already keep the stream active; do not queue redundant heartbeats behind them.
      keepAlive = setInterval(() => {
        if (!controller.signal.aborted && !res.writableNeedDrain) res.write(ping);
      }, CLAUDE.keepAliveMs);
    }

    try {
      const { answer, notes } = await deps.ask(target.provider, prompt, {
        model: target.label,
        timeoutMs: TIMEOUTS.answerMs,
        signal: controller.signal,
      });
      if (notes.length > 0) deps.log(`claude ${slugOf(target.provider, target.label)}: ${notes.join("；")}`);
      if (controller.signal.aborted) return;
      const result = exchange.parse(answer);
      if (stream) {
        res.write(encodeSse(answerEvents(result)));
        res.end();
      } else {
        sendJson(res, 200, messageJson(id, model, prompt, result));
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
    sendJson(res, 200, { input_tokens: estimateTokens(createMessagesExchange(body).prompt) });
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
