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
 * 網頁聊天沒有工具呼叫：只取使用者／助理的文字，Grok 的系統提示與工具定義一律不送。
 */

import { randomUUID } from "node:crypto";
import { APP, GROK, PROVIDERS, providerIds, TIMEOUTS } from "../../dist/config.js";
import { abortOnClose, readRaw, sendJson } from "../lib/bridgekit.js";

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

/** 每個服務一筆「目前選用的模型」，加上擷取到的標籤。 */
export function entriesFrom(labelsByProvider) {
  const entries = [];
  for (const provider of providerIds()) {
    entries.push({ provider });
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

/** Grok 自己塞進使用者訊息的區塊（環境資訊、技能清單等），不是使用者說的話。 */
const HARNESS_BLOCK = /^\s*<(user_info|system-reminder)>/;
const USER_QUERY = /^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/;

function partText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (part.type === "text") return typeof part.text === "string" ? part.text : "";
  if (part.type === "image_url") return "[圖片已省略：網頁聊天無法接收圖片]";
  return "";
}

/**
 * 每次網頁提問都是全新的無痕聊天，所以把對話攤平成一個提示。只取使用者與助理的文字：
 * system、工具定義與工具結果都不送；使用者訊息的 <user_query> 包裝會拆掉。
 */
export function flattenMessages(messages) {
  if (!Array.isArray(messages)) return "";
  const turns = [];
  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const content = message.content;
    const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.map(partText) : [];
    const text = parts
      .filter((t) => t.trim() !== "" && !(message.role === "user" && HARNESS_BLOCK.test(t)))
      .map((t) => (message.role === "user" ? (t.match(USER_QUERY)?.[1] ?? t) : t))
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

/** 整段文字一次到齊：內容 delta → finish_reason 結束 → 用量（stream_options.include_usage）。 */
export function answerChunks(id, model, created, prompt, answer) {
  return [
    chunk(id, model, created, { content: answer }, null),
    chunk(id, model, created, {}, "stop"),
    { id, object: "chat.completion.chunk", created, model, choices: [], usage: usageOf(prompt, answer) },
  ];
}

export function encodeSse(chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
}

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
    const prompt = flattenMessages(body.messages);
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
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(encodeSse(startChunks(id, model, created)));
      keepAlive = setInterval(() => res.write(": keep-alive\n\n"), GROK.keepAliveMs);
    }

    try {
      const { answer, notes } = await deps.ask(target.provider, prompt, {
        model: target.label,
        timeoutMs: TIMEOUTS.answerMs,
        signal: controller.signal,
      });
      if (notes.length > 0) deps.log(`grok ${slugOf(target.provider, target.label)}: ${notes.join("；")}`);
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
