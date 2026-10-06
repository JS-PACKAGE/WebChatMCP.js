/**
 * WebChatMCP.js × Pi — 與 pi 無關的核心邏輯（MCP 用戶端、提示組裝、串流事件、模型清單）。
 *
 * 不匯入任何 pi 套件，方便在 node 下直接測試；與 pi 的接合在 index.js。
 * 只用 Node ≥ 18 內建的 fetch，不需要額外相依套件。
 */

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

/** 從 SSE 或 JSON 回應本文取出指定 id 的 JSON-RPC 訊息。 */
export function parseRpcBody(text, contentType, id) {
  if (contentType.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const message = JSON.parse(data);
      if (message.id === id) return message;
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
    const message = parseRpcBody(await response.text(), response.headers.get("content-type") ?? "", id);
    if (message.error) throw new Error(`MCP 錯誤：${message.error.message ?? JSON.stringify(message.error)}`);
    return message.result;
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
        const text = (result.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
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

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 組出 pi 的 ProviderModelConfig 清單。只收有模型標籤的項目；
 * chatgpt／claude／grok／gemini 這種沒有模型的服務名稱不進清單。
 * 網頁聊天沒有計價與固定的上下文長度，所以成本為 0，上下文長度用保守值；也不支援工具呼叫與圖片。
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
  return content
    .map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[圖片已省略：網頁聊天無法接收圖片]" : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * 每次 webchat_ask 都是全新的無痕聊天，沒有記憶，所以要把整段對話攤平成一個提示。
 * 工具呼叫與思考過程不送出（網頁聊天沒有工具）；pi 自己的系統提示預設不送，因為它在描述網頁聊天用不到的工具。
 * @param {{messages: any[]}} context（pi 的 TranscriptContext：系統提示在 messages 開頭的 system 訊息）
 * @param {{includeSystem?: boolean}} [options]
 */
export function buildPrompt(context, options = {}) {
  const sections = [];
  if (options.includeSystem) {
    // pi 把系統提示放在 transcript 開頭的 system 訊息裡（content 是字串或文字區塊）。
    const system = (context.messages ?? [])
      .filter((m) => m.role === "system")
      .map((m) => textOf(m.content).trim())
      .filter(Boolean)
      .join("\n\n");
    if (system) sections.push(`System:\n${system}`);
  }
  const turns = [];
  for (const message of context.messages ?? []) {
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      if (text) turns.push({ role: "User", text });
    } else if (message.role === "developer") {
      const text = textOf(message.content).trim();
      if (text) turns.push({ role: "System", text });
    } else if (message.role === "assistant") {
      const text = (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) turns.push({ role: "Assistant", text });
    } else if (message.role === "toolResult") {
      const text = textOf(message.content).trim();
      if (text) turns.push({ role: `Tool result (${message.toolName})`, text });
    }
  }
  // 只有單一則使用者訊息：直接送原文，不加角色標籤，回答最自然。
  if (sections.length === 0 && turns.length === 1 && turns[0].role === "User") return turns[0].text;
  for (const turn of turns) sections.push(`${turn.role}:\n${turn.text}`);
  if (turns.length > 0 && turns[turns.length - 1].role !== "Assistant") {
    sections.push("Assistant:");
    return `以下是目前為止的對話，請接著以 Assistant 的身分回覆最後一則訊息（只輸出回覆內容）。\n\n${sections.join("\n\n")}`;
  }
  return sections.join("\n\n");
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

export function pushFailure(stream, model, error, aborted) {
  const message = baseMessage(model, [], aborted ? "aborted" : "error");
  message.errorMessage = error instanceof Error ? error.message : String(error);
  stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
}

/**
 * pi 的 streamSimple 實作：組提示 → webchat_ask → 推送事件。
 * @param {McpHttpClient} client
 * @param {() => any} createStream 建立 AssistantMessageEventStream（由 pi 提供）
 * @param {{includeSystem?: boolean, timeoutSeconds?: number}} settings
 */
export function createStreamSimple(client, createStream, settings = {}) {
  return (model, context, options) => {
    const stream = createStream();
    void (async () => {
      const signal = options?.signal;
      try {
        const { service, label } = parseModelId(model.id);
        const prompt = buildPrompt(context, { includeSystem: settings.includeSystem });
        if (!prompt.trim()) throw new Error("沒有可以送出的訊息");
        const args = { provider: service, prompt, timeout_seconds: settings.timeoutSeconds ?? 300 };
        if (label) args.model = label;
        const answer = stripServerNote(await client.callTool("webchat_ask", args, signal));
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        pushAnswer(stream, model, answer);
      } catch (err) {
        pushFailure(stream, model, err, Boolean(signal?.aborted));
      }
    })();
    return stream;
  };
}
