/**
 * WebChatMCP.js — Codex 橋接（OpenAI Responses 協定）。
 *
 * Codex 的 `openai_base_url` 指到 `http://127.0.0.1:<port>/v1` 之後：
 * - `GET  /v1/models`          ：取得官方清單，再把網頁模型（顯示名稱以 `(WEB)` 結尾）併進去；
 * - `POST /v1/responses`       ：model 是 `webchat/<服務>[/<模型標籤>]` 就送進網頁聊天並以 SSE 回覆，其他一律原樣轉送官方後端；
 * - `GET  /v1/webchat/health`  ：安裝腳本用來確認伺服器版本支援橋接；
 * - `POST /v1/webchat/refresh` ：向各服務擷取模型清單並更新快取。
 * 其他路徑原樣轉送。
 *
 * 紀律：只轉送 Authorization 等標頭給官方後端，不讀取內容、不記錄、不儲存；網頁路徑完全不看憑證。
 * 網頁聊天沒有工具呼叫：只取使用者／助理的文字，Codex 的系統提示與工具定義一律不送。
 */

                                                                 
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";
import { APP, CODEX, PROVIDERS, providerIds, TIMEOUTS } from "../../dist/config.js";

                             
                   
                 
 

                             
                                                      
      
                     
                   
                                                                        
                                                  
                         
                                                  
                             
 

                                                                                                   

// ───────────────────────── 模型 slug 與清單 ─────────────────────────

export function slugOf(provider        , label         )         {
  return label ? `${CODEX.slugPrefix}/${provider}/${label}` : `${CODEX.slugPrefix}/${provider}`;
}

/** `webchat/chatgpt` → {chatgpt}；`webchat/gemini/3.5 Flash-Lite` → {gemini, "3.5 Flash-Lite"}；其他回 null。 */
export function parseSlug(model         )                    {
  if (typeof model !== "string") return null;
  const head = `${CODEX.slugPrefix}/`;
  if (!model.startsWith(head)) return null;
  const rest = model.slice(head.length);
  const slash = rest.indexOf("/");
  const provider = slash < 0 ? rest : rest.slice(0, slash);
  if (!providerIds().includes(provider)) return null;
  const label = slash < 0 ? "" : rest.slice(slash + 1);
  return label ? { provider, label } : { provider };
}

export function displayName(entry            )         {
  const service = PROVIDERS[entry.provider]?.label ?? entry.provider;
  return entry.label
    ? `${service} · ${entry.label} ${CODEX.nameSuffix}`
    : `${service} ${CODEX.nameSuffix}`;
}

                                    

/** 官方清單取不到時的最小模型描述（欄位形狀同 Codex 的 model catalog）。 */
const FALLBACK_MODEL       = {
  slug: "",
  display_name: "",
  description: "",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [{ effort: "medium", description: "No extra reasoning (web chat)" }],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 0,
  base_instructions: "",
  supports_reasoning_summaries: false,
  default_reasoning_summary: "none",
  support_verbosity: false,
  apply_patch_tool_type: "freeform",
  truncation_policy: { mode: "bytes", limit: 10000 },
  context_window: CODEX.contextWindow,
  max_context_window: CODEX.contextWindow,
  effective_context_window_percent: 95,
  supports_parallel_tool_calls: false,
  experimental_supported_tools: [],
  input_modalities: ["text"],
};

function makeModel(template      , entry            , index        )       {
  const service = PROVIDERS[entry.provider]?.label ?? entry.provider;
  return {
    ...structuredClone(template),
    slug: slugOf(entry.provider, entry.label),
    display_name: displayName(entry),
    description: `${service}${entry.label ? ` ${entry.label}` : ""} through WebChatMCP (private web chat; no tool calls).`,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "No extra reasoning (web chat)" }],
    visibility: "list",
    supported_in_api: true,
    priority: CODEX.priority + index,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    model_messages: null,
    context_window: CODEX.contextWindow,
    max_context_window: CODEX.contextWindow,
    input_modalities: ["text"],
    supports_parallel_tool_calls: false,
    supports_reasoning_summaries: false,
    support_verbosity: false,
  };
}

/** 把網頁模型併進官方 /models 回應（重複併入時先移除舊的）；upstream 不是預期形狀就只回網頁模型。 */
export function mergeModels(upstream         , entries              )       {
  const base       = upstream && typeof upstream === "object" && !Array.isArray(upstream) ? (upstream        ) : {};
  const list = Array.isArray(base.models) ? (base.models          ) : [];
  const own = `${CODEX.slugPrefix}/`;
  const official = list.filter((m) => !(typeof m?.slug === "string" && m.slug.startsWith(own)));
  const template = official.find((m) => m?.visibility === "list") ?? official[0] ?? FALLBACK_MODEL;
  const web = entries.map((entry, i) => makeModel(template, entry, i));
  return { ...base, models: [...official, ...web] };
}

// ───────────────────────── 模型清單快取 ─────────────────────────

function expandHome(path        )         {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function modelsFilePath()         {
  return expandHome(CODEX.modelsFile);
}

function readCache(file        )                           {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))                                           ;
    const out                           = {};
    for (const [provider, labels] of Object.entries(parsed.providers ?? {})) {
      if (Array.isArray(labels)) out[provider] = labels.filter((l)              => typeof l === "string" && l !== "");
    }
    return out;
  } catch {
    return {};
  }
}

/** 每個服務一筆「目前選用的模型」，再加上快取到的模型標籤。 */
export function cachedEntries(file         = modelsFilePath())               {
  const cache = readCache(file);
  const entries               = [];
  for (const provider of providerIds()) {
    entries.push({ provider });
    for (const label of new Set(cache[provider] ?? [])) entries.push({ provider, label });
  }
  return entries;
}

/** 以該服務最新擷取到的標籤取代快取（原子寫入）。 */
export function recordModels(provider        , labels          , file         = modelsFilePath())       {
  const providers = readCache(file);
  providers[provider] = [...new Set(labels.filter((l) => l !== ""))];
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), providers }, null, 2));
  renameSync(tmp, file);
}

export async function refreshModels(
  deps                                        ,
  file         = modelsFilePath(),
)                                                                                                                 {
  const counts                         = {};
  const failed                                          = [];
  for (const provider of providerIds()) {
    try {
      const labels = await deps.listLabels(provider);
      recordModels(provider, labels, file);
      counts[provider] = labels.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`codex refresh: ${provider} skipped — ${message}`);
      failed.push({ provider, message });
    }
  }
  return { count: Object.values(counts).reduce((a, b) => a + b, 0), providers: counts, failed };
}

// ───────────────────────── Responses 輸入 → 提示 ─────────────────────────

function partText(part         )         {
  if (!part || typeof part !== "object") return "";
  const p = part                                     ;
  if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
    return typeof p.text === "string" ? p.text : "";
  }
  if (p.type === "input_image") return "[圖片已省略：網頁聊天無法接收圖片]";
  return "";
}

/** Codex 自己塞進使用者訊息的環境區塊，不是使用者說的話。 */
const HARNESS_BLOCK = /^\s*<environment_context>/;

/**
 * 每次網頁提問都是全新的無痕聊天，所以把對話攤平成一個提示。只取使用者與助理訊息的文字：
 * developer／system（Codex 的系統提示，動輒數萬字元）、工具定義、工具呼叫與思考都不送。
 */
export function flattenInput(input         )         {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  const turns                                                 = [];
  for (const item of input          ) {
    if (!item || item.type !== "message" && item.type !== undefined) continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    const content = item.content;
    const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.map(partText) : [];
    const text = texts
      .filter((t) => t.trim() !== "" && !(item.role === "user" && HARNESS_BLOCK.test(t)))
      .join("\n")
      .trim();
    if (text) turns.push({ role: item.role === "user" ? "User" : "Assistant", text });
  }
  if (turns.length === 0) return "";
  if (turns.length === 1 && turns[0].role === "User") return turns[0].text;
  const body = turns.map((t) => `${t.role}:\n${t.text}`).join("\n\n");
  return turns[turns.length - 1].role === "Assistant"
    ? body
    : `以下是目前為止的對話，請接著以 Assistant 的身分回覆最後一則訊息（只輸出回覆內容）。\n\n${body}\n\nAssistant:`;
}

// ───────────────────────── Responses SSE ─────────────────────────

const estimateTokens = (text        )         => Math.ceil(text.length / 4);

                              
                   
                  
                    
 

export function newIds()              {
  return {
    response: `resp_${randomUUID().replace(/-/g, "")}`,
    message: `msg_${randomUUID().replace(/-/g, "")}`,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function responseObject(ids             , model        , status        , extra       = {})       {
  return {
    id: ids.response,
    object: "response",
    created_at: ids.createdAt,
    status,
    model,
    output: [],
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    store: false,
    error: null,
    incomplete_details: null,
    usage: null,
    ...extra,
  };
}

                           
                
             
 

export function createdEvents(ids             , model        )             {
  return [{ event: "response.created", data: { type: "response.created", response: responseObject(ids, model, "in_progress") } }];
}

/** 整段文字一次到齊：output_item.added → 文字 delta → done → completed。 */
export function answerEvents(ids             , model        , prompt        , answer        )             {
  const empty = { type: "message", id: ids.message, status: "in_progress", role: "assistant", content: [] };
  const part = { type: "output_text", text: answer, annotations: [] };
  const item = { type: "message", id: ids.message, status: "completed", role: "assistant", content: [part] };
  const usage = {
    input_tokens: estimateTokens(prompt),
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: estimateTokens(answer),
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: estimateTokens(prompt) + estimateTokens(answer),
  };
  return [
    { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: empty } },
    {
      event: "response.content_part.added",
      data: { type: "response.content_part.added", item_id: ids.message, output_index: 0, content_index: 0, part: { ...part, text: "" } },
    },
    {
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", item_id: ids.message, output_index: 0, content_index: 0, delta: answer },
    },
    {
      event: "response.output_text.done",
      data: { type: "response.output_text.done", item_id: ids.message, output_index: 0, content_index: 0, text: answer },
    },
    {
      event: "response.content_part.done",
      data: { type: "response.content_part.done", item_id: ids.message, output_index: 0, content_index: 0, part },
    },
    { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item } },
    {
      event: "response.completed",
      data: { type: "response.completed", response: responseObject(ids, model, "completed", { output: [item], usage }) },
    },
  ];
}

export function failedEvents(ids             , model        , code        , message        )             {
  return [
    {
      event: "response.failed",
      data: { type: "response.failed", response: responseObject(ids, model, "failed", { error: { code, message } }) },
    },
  ];
}

/** 加上遞增的 sequence_number 後序列化成 SSE 文字。 */
export function encodeSse(events            , startSequence        )                                 {
  let seq = startSequence;
  const text = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify({ ...e.data, sequence_number: seq++ })}\n\n`)
    .join("");
  return { text, next: seq };
}

// ───────────────────────── HTTP 輔助 ─────────────────────────

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readRaw(req                 )                  {
  return new Promise((resolve, reject) => {
    const chunks           = [];
    let size = 0;
    req.on("data", (c        ) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

                                          

/** 依 Content-Encoding 解開請求本文；不支援的編碼（或 Node 太舊沒有 zstd）回 null。 */
export function decodeBody(raw        , encoding                    )                {
  const enc = (encoding ?? "identity").trim().toLowerCase();
  if (enc === "" || enc === "identity") return raw;
  if (enc === "gzip") return zlib.gunzipSync(raw);
  if (enc === "deflate") return zlib.inflateSync(raw);
  if (enc === "br") return zlib.brotliDecompressSync(raw);
  if (enc === "zstd") {
    const zstd = (zlib                                                  ).zstdDecompressSync;
    return zstd ? zstd(raw) : null;
  }
  return null;
}

function sendJson(res                , status        , payload         )       {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res                , status        , code        , message        )       {
  sendJson(res, status, { error: { type: code, code, message } });
}

const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "expect", "accept-encoding"]);

function upstreamBase(req                 )         {
  if (CODEX.upstreamOverride) return CODEX.upstreamOverride.replace(/\/+$/, "");
  return req.headers["chatgpt-account-id"] ? CODEX.upstream.chatgpt : CODEX.upstream.api;
}

async function fetchUpstream(
  req                 ,
  url     ,
  rest        ,
  raw                    ,
  signal             ,
  dropConditional         ,
)                    {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (dropConditional && (name === "if-none-match" || name === "if-modified-since")) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("accept-encoding", "identity");
  const hasBody = raw !== undefined && raw.length > 0 && req.method !== "GET" && req.method !== "HEAD";
  return fetch(`${upstreamBase(req)}${rest}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? new Uint8Array(raw) : undefined,
    signal,
    redirect: "manual",
  });
}

async function pipeUpstream(upstream          , res                )                {
  const headers                         = {};
  upstream.headers.forEach((value, name) => {
    if (["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(name)) return;
    headers[name] = value;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  await new Promise      ((resolve) => {
    const body = Readable.fromWeb(upstream.body         );
    body.on("error", () => {
      res.destroy();
      resolve();
    });
    res.on("close", () => {
      body.destroy();
      resolve();
    });
    body.on("end", resolve);
    body.pipe(res);
  });
}

// ───────────────────────── 橋接本體 ─────────────────────────

export function createBridge(deps            , modelsFile         = modelsFilePath())                {
  const abortOnClose = (req                 , res                )                  => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    req.on("aborted", () => controller.abort());
    return controller;
  };

  async function passthrough(req                 , res                , url     , rest        , raw         )                {
    const controller = abortOnClose(req, res);
    try {
      const body = raw ?? (req.method === "GET" || req.method === "HEAD" ? undefined : await readRaw(req));
      const upstream = await fetchUpstream(req, url, rest, body, controller.signal, false);
      await pipeUpstream(upstream, res);
    } catch (err) {
      if (controller.signal.aborted) return;
      deps.log(`codex upstream error (${req.method} ${rest}): ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendError(res, 502, "bridge_upstream_unreachable", "WebChatMCP 無法連到官方後端");
      else res.destroy();
    }
  }

  async function models(req                 , res                , url     )                {
    const controller = abortOnClose(req, res);
    const entries = cachedEntries(modelsFile);
    let upstream          ;
    try {
      upstream = await fetchUpstream(req, url, "/models", undefined, controller.signal, true);
    } catch (err) {
      if (controller.signal.aborted) return;
      // 連不到官方後端：至少讓網頁模型可用。
      deps.log(`codex models: upstream unreachable (${err instanceof Error ? err.message : String(err)}); serving web models only`);
      sendJson(res, 200, mergeModels(null, entries));
      return;
    }
    if (!upstream.ok) {
      // 例如 401：原樣交回，Codex 才知道要重新授權。
      await pipeUpstream(upstream, res);
      return;
    }
    let merged      ;
    try {
      merged = mergeModels(await upstream.json(), entries);
    } catch {
      sendError(res, 502, "bridge_bad_models", "官方後端的模型清單不是預期的 JSON");
      return;
    }
    sendJson(res, 200, merged);
  }

  async function responses(req                 , res                , url     )                {
    let raw        ;
    try {
      raw = await readRaw(req);
    } catch (err) {
      sendError(res, 413, "bridge_body", err instanceof Error ? err.message : String(err));
      return;
    }
    let body              = null;
    try {
      const decoded = decodeBody(raw, req.headers["content-encoding"]                      );
      if (decoded) body = JSON.parse(decoded.toString("utf8"))        ;
    } catch {
      body = null;
    }
    const target = parseSlug(body?.model);
    if (!body || !target) {
      await passthrough(req, res, url, "/responses", raw);
      return;
    }

    const model = String(body.model);
    const prompt = flattenInput(body.input);
    if (prompt.trim() === "") {
      sendError(res, 400, "bridge_empty_prompt", "沒有可以送出的使用者訊息");
      return;
    }

    const ids = newIds();
    const controller = abortOnClose(req, res);
    const timeoutMs = TIMEOUTS.answerMs;
    const stream = body.stream !== false;
    let seq = 0;
    const write = (events            )       => {
      const { text, next } = encodeSse(events, seq);
      seq = next;
      res.write(text);
    };

    let keepAlive                            ;
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      write(createdEvents(ids, model));
      keepAlive = setInterval(() => res.write(": keep-alive\n\n"), CODEX.keepAliveMs);
    }

    try {
      const { answer, notes } = await deps.ask(target.provider, prompt, {
        model: target.label,
        timeoutMs,
        signal: controller.signal,
      });
      if (notes.length > 0) deps.log(`codex ${slugOf(target.provider, target.label)}: ${notes.join("；")}`);
      if (controller.signal.aborted) return;
      if (stream) {
        write(answerEvents(ids, model, prompt, answer));
        res.end();
      } else {
        const done = answerEvents(ids, model, prompt, answer).at(-1) ;
        sendJson(res, 200, (done.data                      ).response);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const code = (err                     ).code ?? "browser_error";
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`codex ${slugOf(target.provider, target.label)} failed: ${code}: ${message}`);
      if (stream) {
        write(failedEvents(ids, model, code, message));
        res.end();
      } else {
        sendError(res, 502, code, message);
      }
    } finally {
      if (keepAlive) clearInterval(keepAlive);
    }
  }

  return async (req, res, url) => {
    const rest = url.pathname.slice(CODEX.path.length) || "/";
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
        sendError(res, 500, "refresh_failed", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (rest === "/models" && method === "GET") {
      await models(req, res, url);
      return;
    }
    if (rest === "/responses" && method === "POST") {
      await responses(req, res, url);
      return;
    }
    await passthrough(req, res, url, rest);
  };
}
