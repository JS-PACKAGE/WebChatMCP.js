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
 * 網頁模型要求工具，本橋接只驗證與轉成原生事件；執行與權限確認留給 Codex。
 */

                                                                 
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { abortOnClose, decodeBody, fetchUpstream, pipeUpstream, readRaw, sendJson } from "../lib/bridgekit.js";
import { createToolExchange, ToolProtocolError } from "../lib/tool-protocol.js";
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
    description: `${service}${entry.label ? ` ${entry.label}` : ""} through WebChatMCP (private web chat; host-executed tool calls).`,
    ...reasoningLevels(entry.thinking),
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
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: false,
    support_verbosity: false,
  };
}

/**
 * 網頁有兩段以上的思考深度（滑桿、努力程度）才宣告成 Codex 的 reasoning 選項，值就是網頁標籤原樣；
 * 沒有或只有一個（開關型）就維持單一 medium，這時 Codex 送來的 effort 不會轉給網頁。
 */
function reasoningLevels(thinking) {
  if (!thinking) {
    return {
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium", description: "No extra reasoning (web chat)" }],
    };
  }
  return {
    default_reasoning_level: thinking.default,
    supported_reasoning_levels: thinking.levels.map((effort) => ({ effort, description: `Web chat thinking depth: ${effort}` })),
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

// Check filesystem identity on every access, including atomic replacements; never serve a TTL-stale model list.
const modelCaches = new Map();
const MODEL_CACHE_LIMIT = 8;

/** 快取檔：providers 是各服務的模型標籤；thinking 以 slug 為鍵，記錄該模型網頁上的思考深度（兩段以上才記）。 */
function readCacheFile(file) {
  let key = file;
  try {
    if (typeof file === "string") key = resolve(file);
    const stat = statSync(key, { bigint: true });
    const previous = modelCaches.get(key);
    if (previous && previous.stat.dev === stat.dev && previous.stat.ino === stat.ino
      && previous.stat.size === stat.size && previous.stat.mtimeNs === stat.mtimeNs && previous.stat.ctimeNs === stat.ctimeNs) {
      return previous.cache;
    }
    const parsed = JSON.parse(readFileSync(key, "utf8"));
    const providers = {};
    for (const [provider, labels] of Object.entries(parsed.providers ?? {})) {
      if (Array.isArray(labels)) providers[provider] = [...new Set(labels.filter((l) => typeof l === "string" && l !== ""))];
    }
    const thinking = {};
    for (const [slug, info] of Object.entries(parsed.thinking ?? {})) {
      const levels = Array.isArray(info?.levels) ? info.levels.filter((l) => typeof l === "string" && l !== "") : [];
      if (levels.length >= 2) thinking[slug] = { levels, default: levels.includes(info.default) ? info.default : levels[0] };
    }
    const cache = { providers, thinking };
    modelCaches.delete(key);
    if (modelCaches.size >= MODEL_CACHE_LIMIT) modelCaches.delete(modelCaches.keys().next().value);
    modelCaches.set(key, { stat, cache });
    return cache;
  } catch {
    modelCaches.delete(key);
    return { providers: {}, thinking: {} };
  }
}

/** 只列快取到的模型標籤；沒有模型的服務名稱不進清單。 */
export function cachedEntries(file = modelsFilePath()) {
  const cache = readCacheFile(file);
  const entries = [];
  for (const provider of providerIds()) {
    for (const label of cache.providers[provider] ?? []) {
      const thinking = cache.thinking[slugOf(provider, label)];
      entries.push(thinking ? { provider, label, thinking: { ...thinking, levels: [...thinking.levels] } } : { provider, label });
    }
  }
  return entries;
}

/** Codex 送來的 effort 若正是該模型網頁上的某個深度標籤，回傳它；否則 undefined（不轉給網頁）。 */
export function thinkingFor(provider, label, effort, file = modelsFilePath()) {
  const info = readCacheFile(file).thinking[slugOf(provider, label)];
  return info?.levels.includes(effort) ? effort : undefined;
}

/**
 * 以該服務最新擷取到的標籤取代快取（原子寫入）。
 * thinking：模型標籤 → { levels: 思考深度標籤[], default?: 目前選中的標籤 }；只有兩段以上的會寫入。
 */
export function recordModels(provider, labels, file = modelsFilePath(), thinking = {}) {
  const current = readCacheFile(file);
  const cache = { providers: { ...current.providers }, thinking: { ...current.thinking } };
  const unique = [...new Set(labels.filter((l) => l !== ""))];
  cache.providers[provider] = unique;
  const prefix = slugOf(provider, "x").slice(0, -1);
  for (const slug of Object.keys(cache.thinking)) if (slug.startsWith(prefix)) delete cache.thinking[slug];
  for (const label of unique) {
    const info = thinking[label];
    if (info && info.levels.length >= 2) {
      cache.thinking[slugOf(provider, label)] = { levels: info.levels, default: info.default ?? info.levels[0] };
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), providers: cache.providers, thinking: cache.thinking }, null, 2));
  renameSync(tmp, file);
  modelCaches.delete(resolve(file));
}

export async function refreshModels(deps, file = modelsFilePath()) {
  const counts = {};
  const failed = [];
  for (const provider of providerIds()) {
    try {
      // 思考深度隨模型而異：有逐模型讀取的能力就用它（較慢，因為要逐一切換模型）。
      const detailed = deps.listModelsDetailed ? await deps.listModelsDetailed(provider) : null;
      const labels = detailed ? detailed.map((m) => m.label) : await deps.listLabels(provider);
      const thinking = {};
      for (const model of detailed ?? []) {
        thinking[model.label] = { levels: model.thinking.map((t) => t.label), default: model.thinking.find((t) => t.current)?.label };
      }
      recordModels(provider, labels, file, thinking);
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

/** 每次都是新聊天：保留訊息、工具要求與結果；不支援的內建工具項目安全略過。 */
export function inputTurns(input) {
  if (typeof input === "string") return [{ role: "user", text: input }];
  if (!Array.isArray(input)) return [];
  const turns = [];
  const names = new Map(input.filter((item) => item?.call_id && item?.name).map((item) => [item.call_id, item.name]));
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string") continue;
      const call = { id: item.call_id, name: item.name };
      if (item.type === "custom_tool_call") {
        if (typeof item.input !== "string") continue;
        call.input = item.input;
      } else {
        try {
          call.arguments = JSON.parse(item.arguments);
          if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) continue;
        } catch {
          continue;
        }
      }
      turns.push({ role: "assistant", text: "", calls: [call] });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (typeof item.call_id !== "string") continue;
      const text = typeof item.output === "string" ? item.output : Array.isArray(item.output) ? item.output.map(partText).filter(Boolean).join("\n") : "";
      turns.push({ role: "tool", id: item.call_id, name: names.get(item.call_id) ?? item.name ?? "unknown", text });
    } else if (item.type === "message" || item.type === undefined) {
      if (!["user", "assistant", "developer", "system"].includes(item.role)) continue;
      const texts = typeof item.content === "string" ? [item.content] : Array.isArray(item.content) ? item.content.map(partText) : [];
      const text = texts.filter((t) => t.trim() && !(item.role === "user" && HARNESS_BLOCK.test(t))).join("\n").trim();
      if (text) turns.push({ role: ["developer", "system"].includes(item.role) ? "system" : item.role, text });
    }
  }
  return turns;
}

export function toolExchange(body) {
  const turns = inputTurns(body.input);
  const system = [typeof body.instructions === "string" ? body.instructions : "", ...turns.filter((t) => t.role === "system").map((t) => t.text)].filter(Boolean).join("\n\n");
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t) => t && ["function", "custom"].includes(t.type) && typeof t.name === "string").map((t) => ({
    name: t.name, description: t.description, parameters: t.parameters, kind: t.type, format: t.format,
  }));
  const toolChoice = typeof body.tool_choice === "object" && body.tool_choice !== null ? body.tool_choice.name : body.tool_choice;
  return createToolExchange({ system, turns: turns.filter((t) => t.role !== "system"), tools, toolChoice, parallelToolCalls: body.parallel_tool_calls });
}

export function flattenInput(input) {
  return toolExchange({ input }).prompt;
}

// ───────────────────────── Responses SSE ─────────────────────────

const estimateTokens = (text        )         => Math.ceil(text.length / 4);

                              
                   
                  
                    
 

export function newIds(settings = {}) {
  return {
    response: `resp_${randomUUID().replace(/-/g, "")}`,
    message: `msg_${randomUUID().replace(/-/g, "")}`,
    createdAt: Math.floor(Date.now() / 1000),
    settings,
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
    ...ids.settings,
    ...extra,
  };
}

                           
                
             
 

export function createdEvents(ids             , model        )             {
  return [{ event: "response.created", data: { type: "response.created", response: responseObject(ids, model, "in_progress") } }];
}

/** JSON 與 SSE 共用完成回應；JSON 不建立用不到的中間事件。 */
function completedResponse(ids, model, prompt, answer, events) {
  const { text, calls } = typeof answer === "string" ? { text: answer, calls: [] } : answer;
  const output = [];
  let outputLength = text.length;
  if (text || calls.length === 0) {
    const part = { type: "output_text", text, annotations: [] };
    const item = { type: "message", id: ids.message, status: "completed", role: "assistant", content: [part] };
    events?.push(
      { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { type: "message", id: ids.message, status: "in_progress", role: "assistant", content: [] } } },
      {
        event: "response.content_part.added",
        data: { type: "response.content_part.added", item_id: ids.message, output_index: 0, content_index: 0, part: { ...part, text: "" } },
      },
      {
        event: "response.output_text.delta",
        data: { type: "response.output_text.delta", item_id: ids.message, output_index: 0, content_index: 0, delta: text },
      },
      {
        event: "response.output_text.done",
        data: { type: "response.output_text.done", item_id: ids.message, output_index: 0, content_index: 0, text },
      },
      {
        event: "response.content_part.done",
        data: { type: "response.content_part.done", item_id: ids.message, output_index: 0, content_index: 0, part },
      },
      { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item } },
    );
    output.push(item);
  }
  for (const call of calls) {
    const custom = call.kind === "custom";
    const field = custom ? "input" : "arguments";
    const value = custom ? call.input : JSON.stringify(call.arguments);
    outputLength += value.length;
    const item = {
      type: custom ? "custom_tool_call" : "function_call",
      id: `${custom ? "ctc" : "fc"}_${randomUUID().replace(/-/g, "")}`,
      call_id: call.id, name: call.name, [field]: value,
      ...(custom ? {} : { status: "completed" }),
    };
    const output_index = output.length;
    const eventBase = custom ? "response.custom_tool_call_input" : "response.function_call_arguments";
    events?.push(
      { event: "response.output_item.added", data: { type: "response.output_item.added", output_index, item: { ...item, [field]: "", ...(custom ? {} : { status: "in_progress" }) } } },
      { event: `${eventBase}.delta`, data: { type: `${eventBase}.delta`, item_id: item.id, output_index, delta: value } },
      { event: `${eventBase}.done`, data: { type: `${eventBase}.done`, item_id: item.id, output_index, [field]: value, ...(!custom ? { name: call.name } : {}) } },
      { event: "response.output_item.done", data: { type: "response.output_item.done", output_index, item } },
    );
    output.push(item);
  }
  const inputTokens = estimateTokens(prompt);
  const outputTokens = Math.ceil(outputLength / 4);
  const usage = {
    input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
  return responseObject(ids, model, "completed", { output, usage });
}

/** 整段回覆到齊後，依序送文字、工具要求與完成事件。 */
export function answerEvents(ids, model, prompt, answer) {
  const events = [];
  const response = completedResponse(ids, model, prompt, answer, events);
  events.push({ event: "response.completed", data: { type: "response.completed", response } });
  return events;
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

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { type: code, code, message } });
}

function upstreamBase(req) {
  if (CODEX.upstreamOverride) return CODEX.upstreamOverride.replace(/\/+$/, "");
  return req.headers["chatgpt-account-id"] ? CODEX.upstream.chatgpt : CODEX.upstream.api;
}

// ───────────────────────── 橋接本體 ─────────────────────────

export function createBridge(deps            , modelsFile         = modelsFilePath())                {
  async function passthrough(req                 , res                , url     , rest        , raw         )                {
    const controller = abortOnClose(req, res);
    try {
      const body = raw ?? (req.method === "GET" || req.method === "HEAD" ? undefined : await readRaw(req));
      const upstream = await fetchUpstream(req, url, upstreamBase(req), rest, body, controller.signal, false);
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
      upstream = await fetchUpstream(req, url, upstreamBase(req), "/models", undefined, controller.signal, true);
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
      const decoded = await decodeBody(raw, req.headers["content-encoding"]                      );
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
    const exchange = toolExchange(body);
    const prompt = exchange.prompt;
    if (prompt.trim() === "") {
      sendError(res, 400, "bridge_empty_prompt", "沒有可以送出的使用者訊息");
      return;
    }

    const ids = newIds({ tools: Array.isArray(body.tools) ? body.tools.filter((t) => t && ["function", "custom"].includes(t.type)) : [], tool_choice: body.tool_choice ?? "auto", parallel_tool_calls: body.parallel_tool_calls !== false });
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
      // Pending bytes already keep the stream active; do not queue redundant heartbeats behind them.
      keepAlive = setInterval(() => {
        if (!controller.signal.aborted && !res.writableNeedDrain) res.write(": keep-alive\n\n");
      }, CODEX.keepAliveMs);
    }

    try {
      // Codex 的 reasoning effort 若正是這個模型的網頁思考深度標籤，就先設定好再送出。
      const effort = typeof body.reasoning?.effort === "string" ? body.reasoning.effort : "";
      const { answer, notes } = await deps.ask(target.provider, prompt, {
        model: target.label,
        thinking: target.label && effort ? thinkingFor(target.provider, target.label, effort, modelsFile) : undefined,
        timeoutMs,
        signal: controller.signal,
      });
      if (notes.length > 0) deps.log(`codex ${slugOf(target.provider, target.label)}: ${notes.join("；")}`);
      if (controller.signal.aborted) return;
      const parsed = exchange.parse(answer);
      if (stream) {
        write(answerEvents(ids, model, prompt, parsed));
        res.end();
      } else {
        sendJson(res, 200, completedResponse(ids, model, prompt, parsed));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const code = err instanceof ToolProtocolError ? "tool_protocol_error" : err.code ?? "browser_error";
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`codex ${slugOf(target.provider, target.label)} failed: ${code}: ${message}`);
      if (stream) {
        write(failedEvents(ids, model, code, message));
        res.end();
      } else {
        if (err instanceof ToolProtocolError) sendJson(res, 502, failedEvents(ids, model, code, message)[0].data.response);
        else sendError(res, 502, code, message);
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
