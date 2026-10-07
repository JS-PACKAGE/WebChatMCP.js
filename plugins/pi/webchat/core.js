/**
 * WebChatMCP.js × Pi — 與 pi 無關的核心邏輯（MCP 用戶端、提示組裝、串流事件、模型清單）。
 *
 * 不匯入任何 pi 套件，方便在 node 下直接測試；與 pi 的接合在 index.js。
 * 只用 Node ≥ 18 內建的 fetch，不需要額外相依套件。
 */

import { createToolExchange } from "./tool-protocol.js";

export const PROVIDER_NAME = "webchat";

/** 內建的四個服務；實際清單以 MCP 伺服器的 provider 選項為準（含外掛）。 */
export const DEFAULT_SERVICES = ["chatgpt", "claude", "grok", "gemini"];

export const SERVICE_LABELS = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
  gemini: "Gemini",
};

export function serviceLabel(service) {
  return SERVICE_LABELS[service] ?? service;
}

/**
 * `/webchat-login` 沒給服務就檢查全部（含伺服器上的外掛服務）；
 * 給了就只檢查那些，空白分隔。args 不是字串時當作沒給。
 * @param {unknown} args
 * @param {string[]} [services]
 */
export function loginTargets(args, services = DEFAULT_SERVICES) {
  const requested = typeof args === "string" ? args.trim() : "";
  if (!requested) return [...services];
  return requested.split(/\s+/);
}

/** webchat_ask 在尾端附加的 WebChatMCP.js 註記（訪客／無法確認無痕），不屬於模型回覆。 */
const SERVER_NOTE = /\n\n\[WebChatMCP\.js\] [^\n]*$/;

export function stripServerNote(text) {
  return text.replace(SERVER_NOTE, "");
}

// ───────────────────────── MCP over Streamable HTTP ─────────────────────────

function parseRpcEvent(text) {
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
  }
  return lines.length ? JSON.parse(lines.join("\n")) : null;
}

/** A matching result is complete even when the server keeps its SSE connection open. */
async function readRpcResponse(response, id) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    return parseRpcBody(await response.text(), contentType, id);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  const separator = /\r?\n\r?\n/g;
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      const chunk = pending + decoder.decode(value, { stream: !done });
      let start = 0;
      separator.lastIndex = 0;
      let boundary;
      while ((boundary = separator.exec(chunk))) {
        parts.push(chunk.slice(start, boundary.index));
        const message = parseRpcEvent(parts.join(""));
        parts.length = 0;
        start = separator.lastIndex;
        if (message?.id === id) return message;
      }
      // Only the final three characters can begin a split CRLF separator.
      // Keep scanned fragments separate instead of copying/rescanning a large result per chunk.
      const end = Math.max(start, chunk.length - 3);
      if (end > start) parts.push(chunk.slice(start, end));
      pending = chunk.slice(end);
      if (done) {
        parts.push(pending);
        const message = parseRpcEvent(parts.join(""));
        if (message?.id === id) return message;
        throw new Error("MCP 回應中沒有對應的結果");
      }
    }
  } finally {
    // Do not wait for remote stream teardown after receiving the complete result.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 從 SSE 或 JSON 回應本文取出指定 id 的 JSON-RPC 訊息。 */
export function parseRpcBody(text, contentType, id) {
  if (contentType.includes("text/event-stream")) {
    const separator = /\r?\n\r?\n/g;
    let start = 0;
    while (start <= text.length) {
      const boundary = separator.exec(text);
      const end = boundary ? boundary.index : text.length;
      const message = parseRpcEvent(text.slice(start, end));
      if (message?.id === id) return message;
      if (!boundary) break;
      start = separator.lastIndex;
    }
    throw new Error("MCP 回應中沒有對應的結果");
  }
  const message = JSON.parse(text);
  if (message.id !== id) throw new Error("MCP 回應的 id 不符");
  return message;
}

export class McpHttpClient {
  /**
   * @param {string} url MCP endpoint（預設 http://127.0.0.1:8321/mcp）
   * @param {typeof fetch} [fetchImpl]
   */
  constructor(url, fetchImpl = fetch) {
    this.url = url;
    this.fetch = fetchImpl;
    this.sessionId = null;
    this.nextId = 1;
    /** @type {Promise<void> | null} */
    this.ready = null;
  }

  async post(body, signal) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    let response;
    try {
      response = await this.fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(
        `連不上 WebChatMCP 伺服器（${this.url}）：${err instanceof Error ? err.message : String(err)}。` +
          "請先安裝並啟動服務（script/install.sh），或用 WEBCHATMCP_URL 指定位址。",
      );
    }
    return response;
  }

  async rpc(method, params, signal) {
    const id = this.nextId++;
    try {
      const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
      if (response.status === 404 && this.sessionId) {
        // 伺服器重啟後舊 session 已失效：重新握手一次。
        this.sessionId = null;
        this.ready = null;
        throw new SessionExpired();
      }
      if (!response.ok) throw new Error(`MCP 請求失敗：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      const sid = response.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      const message = await readRpcResponse(response, id);
      if (message.error) throw new Error(`MCP 錯誤：${message.error.message ?? JSON.stringify(message.error)}`);
      return message.result;
    } catch (err) {
      if (signal?.aborted && (err === signal.reason || err?.name === "AbortError") && this.sessionId) {
        // HTTP 中止不代表伺服器停止工作；取消通知不可沿用已中止的 signal。
        void this.post({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: {
            requestId: id,
            reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted"),
          },
        }).catch(() => {});
      }
      throw err;
    }
  }

  async initialize(signal) {
    await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "webchatmcp-pi", version: "1.0.0" },
      },
      signal,
    );
    const response = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
    if (!response.ok && response.status !== 202) throw new Error(`MCP 握手失敗：HTTP ${response.status}`);
  }

  async ensureReady(signal) {
    this.ready ??= this.initialize(signal).catch((err) => {
      this.ready = null;
      throw err;
    });
    await this.ready;
  }

  /** 呼叫 MCP 工具，回傳文字；工具回報錯誤時丟出含錯誤碼的 Error。 */
  async callTool(name, args, signal) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.ensureReady(signal);
        const result = await this.rpc("tools/call", { name, arguments: args }, signal);
        const parts = [];
        for (const part of result.content ?? []) {
          if (part.type === "text") parts.push(part.text);
        }
        const text = parts.join("\n");
        if (result.isError) throw new Error(describeToolError(text));
        return text;
      } catch (err) {
        if (err instanceof SessionExpired && attempt === 0) continue;
        throw err;
      }
    }
  }

  /** 伺服器上可用的服務代號（含外掛）；取不到就用內建四個。 */
  async listServices(signal) {
    try {
      await this.ensureReady(signal);
      const result = await this.rpc("tools/list", {}, signal);
      const tool = (result.tools ?? []).find((t) => t.name === "webchat_models");
      const enumValues = tool?.inputSchema?.properties?.provider?.enum;
      if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues;
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    return DEFAULT_SERVICES;
  }
}

class SessionExpired extends Error {}

/** webchat 工具的錯誤是 JSON：{"error":"logged_out","message":"..."}；盡量轉成好讀的一行。 */
export function describeToolError(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.message) return `${parsed.error ?? "error"}: ${parsed.message}`;
  } catch {
    // 不是 JSON，原樣回傳
  }
  return text || "WebChatMCP 工具回報錯誤";
}

// ───────────────────────── 模型 id 與清單 ─────────────────────────

/** `chatgpt` ＝該服務目前選的模型；`chatgpt/GPT-5.5` ＝指定模型標籤（標籤本身可含斜線）。 */
export function parseModelId(id) {
  const slash = id.indexOf("/");
  if (slash < 0) return { service: id, label: undefined };
  return { service: id.slice(0, slash), label: id.slice(slash + 1) };
}

export function modelId(service, label) {
  return label ? `${service}/${label}` : service;
}

/**
 * 追蹤目前選的模型是否屬於 webchat：切到 webchat 模型就請伺服器先載入對應服務的無痕聊天頁（webchat_warmup），
 * 切離開（或結束）就請它釋放背景瀏覽器（webchat_release）。只在狀態改變時才呼叫伺服器；呼叫在背景進行，失敗只通知 onError，不影響宿主。
 * @param {{callTool(name: string, args: object): Promise<string>}} client
 * @param {(err: unknown) => void} [onError]
 */
export function createModelWatcher(client, onError = () => {}) {
  /** 目前已請伺服器預先載入的模型 id；null＝沒有在用 webchat */
  let active = null;
  const send = (name, args) => {
    client.callTool(name, args).catch(onError);
  };
  return {
    /** @param {{provider?: string, id?: string} | null | undefined} model 宿主目前的模型 */
    sync(model) {
      const next = model?.provider === PROVIDER_NAME && typeof model.id === "string" ? model.id : null;
      if (next === active) return;
      const previous = active;
      active = next;
      if (next) {
        const { service, label } = parseModelId(next);
        send("webchat_warmup", label ? { provider: service, model: label } : { provider: service });
      } else if (previous) send("webchat_release", {});
    },
    /** 宿主結束：還在用 webchat 就釋放。 */
    stop() {
      this.sync(null);
    },
  };
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 組出 pi 的 ProviderModelConfig 清單。只收有模型標籤的項目；
 * chatgpt／claude／grok／gemini 這種沒有模型的服務名稱不進清單。
 * 網頁聊天沒有計價與固定的上下文長度，所以成本為 0，上下文長度用保守值；工具由宿主執行，不支援圖片。
 * @param {string[]} services 目前存在的服務；不在這裡的快取標籤丟掉
 * @param {{service: string, label: string}[]} discovered 由 /webchat-refresh 取得並快取的模型
 */
export function buildModels(services, discovered) {
  const models = [];
  const seen = new Set();
  for (const { service, label } of discovered) {
    if (!label || !services.includes(service)) continue;
    const id = modelId(service, label);
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: `${serviceLabel(service)} · ${label}`,
      reasoning: false,
      input: ["text"],
      cost: { ...ZERO_COST },
      contextWindow: 128_000,
      maxTokens: 16_000,
    });
  }
  return models;
}

// ───────────────────────── 提示組裝 ─────────────────────────

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = [];
  for (const part of content) {
    const text = part.type === "text" ? part.text : part.type === "image" ? "[圖片已省略：網頁聊天無法接收圖片]" : "";
    if (text) texts.push(text);
  }
  return texts.join("\n");
}

/** 每次臨時聊天重送完整對話，工具要求與結果保留相同 id。 */
function buildExchange(context, options = {}) {
  const systemMessages = (context.messages ?? []).filter((message) => message.role === "system");
  const sections = new Map();
  for (const message of systemMessages) {
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  const system = [context.systemPrompt, ...systemMessages.map((message) => textOf(message.content)), ...sections.values()]
    .filter(Boolean).join("\n\n");
  // Pi 的正規化 transcript 將工具宣告放在 system 訊息；原始 Context 則有 tools。
  const activeTools = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
  for (const message of systemMessages) {
    for (const tool of message.toolsAdded ?? []) activeTools.set(tool.name, tool);
    for (const tool of message.toolsRemoved ?? []) activeTools.delete(tool.name);
  }
  const turns = [];
  for (const message of context.messages ?? []) {
    const text = textOf(message.content);
    if (message.role === "user" || message.role === "developer") {
      if (text) turns.push({ role: message.role === "user" ? "user" : "system", text });
    } else if (message.role === "assistant") {
      const calls = [];
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part.type === "toolCall") calls.push({ id: part.id, name: part.name, arguments: part.arguments });
      }
      if (text || calls.length) turns.push({ role: "assistant", text, calls });
    } else if (message.role === "toolResult") {
      turns.push({ role: "tool", id: message.toolCallId, name: message.toolName, text, isError: message.isError });
    }
  }
  const tools = [...activeTools.values()];
  const choice = options.toolChoice;
  const toolChoice = choice === "any" ? "required" : typeof choice === "object" ? choice?.name ?? choice?.function?.name : choice;
  return createToolExchange({ system, turns, tools, toolChoice, parallelToolCalls: options.parallelToolCalls });
}

export function buildPrompt(context, options = {}) {
  return buildExchange(context, options).prompt;
}

// ───────────────────────── 串流事件 ─────────────────────────

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function baseMessage(model, content, stopReason) {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * 把一次 webchat_ask 的結果轉成 pi 的 AssistantMessageEvent 序列推進 stream。
 * 網頁聊天一次回傳整段文字，所以只有一個 text_delta。
 */
export function pushAnswer(stream, model, text) {
  const partial = baseMessage(model, [{ type: "text", text: "" }], "pending");
  stream.push({ type: "start", partial });
  stream.push({ type: "text_start", contentIndex: 0, partial });
  const pending = baseMessage(model, [{ type: "text", text }], "pending");
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
  stream.push({ type: "done", reason: "stop", message: baseMessage(model, [{ type: "text", text }], "stop") });
}

function pushToolCalls(stream, model, text, calls) {
  const partial = baseMessage(model, [], "pending");
  stream.push({ type: "start", partial });
  if (text) {
    const part = { type: "text", text: "" };
    partial.content.push(part);
    stream.push({ type: "text_start", contentIndex: 0, partial });
    part.text = text;
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
  }
  for (const call of calls) {
    const contentIndex = partial.content.length;
    const toolCall = { type: "toolCall", id: call.id, name: call.name, arguments: {} };
    partial.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex, partial });
    toolCall.arguments = call.arguments;
    stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
  }
  partial.stopReason = "toolUse";
  stream.push({ type: "done", reason: "toolUse", message: partial });
}

export function pushFailure(stream, model, error, aborted) {
  const message = baseMessage(model, [], aborted ? "aborted" : "error");
  message.errorMessage = error instanceof Error ? error.message : String(error);
  stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
}

/**
 * pi 的 streamSimple 實作：組提示 → webchat_ask → 推送事件。
 * @param {McpHttpClient} client
 * @param {() => any} createStream 建立 AssistantMessageEventStream（由 pi 提供）
 * @param {{timeoutSeconds?: number}} settings
 */
export function createStreamSimple(client, createStream, settings = {}) {
  return (model, context, options) => {
    const stream = createStream();
    void (async () => {
      const signal = options?.signal;
      try {
        const { service, label } = parseModelId(model.id);
        const exchange = buildExchange(context, options ?? undefined);
        const { prompt } = exchange;
        if (!prompt.trim()) throw new Error("沒有可以送出的訊息");
        const args = { provider: service, prompt, timeout_seconds: settings.timeoutSeconds ?? 300 };
        if (label) args.model = label;
        const answer = stripServerNote(await client.callTool("webchat_ask", args, signal));
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        const parsed = exchange.parse(answer);
        if (parsed.calls.length) pushToolCalls(stream, model, parsed.text, parsed.calls);
        else pushAnswer(stream, model, parsed.text);
      } catch (err) {
        pushFailure(stream, model, err, Boolean(signal?.aborted));
      }
    })();
    return stream;
  };
}
