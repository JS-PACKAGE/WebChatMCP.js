/**
 * WebChatMCP.js — 網頁模型的「工具要求與結果往返」共用協定（所有模型外掛共用）。
 *
 * 網頁聊天沒有結構化工具呼叫，所以由這裡定義一套格式：
 *   1. 把宿主（OMP、Pi、Codex、Claude Code、Grok Build、Hermes）提供的工具定義寫進提示，
 *      並要求模型要用工具時「只輸出」一個帶有本次隨機 nonce 的 JSON 信封：
 *        {"webchat":"<nonce>","text":"前言（可省略）","tool_calls":[{"name":"read","arguments":{"path":"main.ts"}}]}
 *      自訂（freeform）工具用 {"name":"apply_patch","input":"…"}。
 *   2. 解析模型回覆：整段（或整段被一個 ``` 圍欄包住）必須是 nonce 相符的信封，
 *      工具名稱必須在宿主給的清單內、參數必須是物件並帶齊 schema 的 required 欄位，
 *      否則一律不當成工具要求。模型隨便寫出的文字永遠不會被當成指令。
 *   3. 把解析結果交給各外掛轉成宿主原生的工具事件；執行與權限／確認由宿主決定，這裡不執行任何東西。
 *   4. 每次網頁提問都是全新的無痕聊天，所以每一輪都重新帶入系統提示、對話、先前的工具要求與結果。
 *
 * 純邏輯、無相依，只用 node:crypto。omp／pi 外掛安裝後只有自己的目錄，所以它們各自帶一份同內容的副本
 * （omp、pi 的 webchat 目錄下的 tool-protocol.js），由 tests/tool-protocol.test.mjs 檢查與本檔一致。
 */

import { randomUUID } from "node:crypto";

/** 工具定義與工具結果太長會把網頁聊天塞爆：超過就截斷並註明。 */
export const MAX_SYSTEM_CHARS = 24_000;
export const MAX_RESULT_CHARS = 50_000;
/** 提示總長上限（每次都是新聊天、整段重送，太長會拖慢輸入甚至超出網站上限）。 */
export const MAX_PROMPT_CHARS = 200_000;
/** 縮減後每則回合的上限；截斷都有註明，最後一則（這次的請求）永不縮減。 */
export const MIN_TURN_CHARS = 2_000;

/** 模型輸出的工具要求不合格式或不合宿主給的工具清單。 */
export class ToolProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolProtocolError";
  }
}

function clip(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[已截斷 ${text.length - limit} 字元]`;
}

// ───────────────────────── 對話 → 提示 ─────────────────────────

/**
 * @typedef {{id: string, name: string, arguments?: object, input?: string}} ToolCallTurn
 * @typedef {{role: "user" | "system", text: string}
 *   | {role: "assistant", text: string, calls?: ToolCallTurn[]}
 *   | {role: "tool", id: string, name: string, text: string, isError?: boolean}} Turn
 * @typedef {{name: string, description?: string, parameters?: object, kind?: "function" | "custom", format?: object}} ToolSpec
 */

function envelopeOf(nonce, text, calls) {
  const envelope = { webchat: nonce };
  if (text) envelope.text = text;
  envelope.tool_calls = calls.map((call) =>
    call.input !== undefined
      ? { id: call.id, name: call.name, input: call.input }
      : { id: call.id, name: call.name, arguments: call.arguments ?? {} },
  );
  return JSON.stringify(envelope);
}

function renderTurn(turn, nonce, maxResultChars) {
  if (turn.role === "user") return `User:\n${turn.text}`;
  if (turn.role === "system") return `System:\n${turn.text}`;
  if (turn.role === "assistant") {
    // 有工具要求的助理回合用和要求模型輸出的同一種信封重現，模型才看得出自己上一輪做了什麼。
    const body = turn.calls?.length ? envelopeOf(nonce, turn.text, turn.calls) : turn.text;
    return `Assistant:\n${body}`;
  }
  const status = turn.isError ? ", error" : "";
  return `Tool result (${turn.name}, id ${turn.id}${status}):\n${clip(turn.text, maxResultChars)}`;
}

/** 宿主常在參數 schema 最上層附 `$schema`（方言網址），對模型沒有資訊卻每輪都要重送，所以不放進提示。 */
function schemaText(parameters) {
  const schema = parameters ?? { type: "object", properties: {} };
  if (schema && typeof schema === "object" && !Array.isArray(schema) && Object.hasOwn(schema, "$schema")) {
    const { $schema: _dialect, ...rest } = schema;
    return JSON.stringify(rest);
  }
  return JSON.stringify(schema);
}

function describeTool(tool) {
  const kind = tool.kind === "custom" ? "custom (freeform)" : "function";
  const lines = [`- ${tool.name} [${kind}]${tool.description ? `: ${tool.description.trim()}` : ""}`];
  if (tool.kind === "custom") {
    lines.push(`  input: a single string${tool.format ? `, format ${JSON.stringify(tool.format)}` : ""}`);
  } else {
    lines.push(`  parameters (JSON Schema): ${schemaText(tool.parameters)}`);
  }
  return lines.join("\n");
}

function protocolInstructions(nonce, tools, toolChoice, parallel) {
  const callsRule = parallel ? "one or more calls" : "exactly one call";
  const choice =
    toolChoice === "required"
      ? "You MUST call a tool in this reply."
      : toolChoice && toolChoice !== "auto"
        ? `You MUST call the tool "${toolChoice}" in this reply.`
        : "Call a tool only when you need information or an action you cannot do from the conversation; otherwise answer directly.";
  return [
    "You are connected to tools that run on the user's computer through a local agent. You cannot run them yourself;",
    "you request a call and the agent runs it (subject to the user's permissions) and sends the result back in the next turn.",
    "",
    "To request tools, reply with ONLY one JSON object and nothing else (no prose, no markdown fence):",
    `{"webchat":"${nonce}","text":"optional short note","tool_calls":[{"name":"<tool name>","arguments":{...}}]}`,
    `- "webchat" MUST be exactly "${nonce}". tool_calls holds ${callsRule}.`,
    '- Function tools take "arguments" (a JSON object matching the schema; every parameter listed under "required" MUST be present). Custom tools take "input" (a string) instead of "arguments".',
    "- Use only the tools listed below, with exactly these names. Never invent tools, never put the call inside prose or code.",
    "- To answer without tools, just write the answer as plain text (no JSON envelope).",
    "- After a tool result arrives, continue the task: request another tool or give the final answer.",
    `- ${choice}`,
    "",
    "Available tools:",
    ...tools.map(describeTool),
  ].join("\n");
}

/**
 * 組出各則回合的文字。總長超過預算時，從最舊的回合開始縮減：先縮佔位最大的工具結果，
 * 再縮較舊的回合文字；一律保留最後一則（這次的請求）。每則截斷都帶註明，模型知道內容被省略。
 */
function fitTurnBudget(turns, nonce, maxResultChars, minTurnChars, budget) {
  const rendered = turns.map((turn) => renderTurn(turn, nonce, maxResultChars));
  let length = rendered.reduce((sum, text) => sum + text.length, 0);
  const shrink = (index) => {
    const turn = turns[index];
    // 工具結果的截斷交給 renderTurn（註明的數字才是原始長度）；其餘回合縮的是文字本身。
    const next = renderTurn(
      turn.role === "tool" ? turn : { ...turn, text: clip(turn.text, minTurnChars) },
      nonce,
      minTurnChars,
    );
    length += next.length - rendered[index].length;
    rendered[index] = next;
  };
  for (let i = 0; i < turns.length - 1 && length > budget; i += 1) {
    if (turns[i].role === "tool") shrink(i);
  }
  for (let i = 0; i < turns.length - 1 && length > budget; i += 1) {
    if (turns[i].role !== "tool") shrink(i);
  }
  return rendered;
}

/**
 * 組出送給網頁聊天的完整提示，並回傳解析回覆用的 parse。
 *
 * @param {{
 *   system?: string,
 *   turns: Turn[],
 *   tools?: ToolSpec[],
 *   toolChoice?: string,
 *   parallelToolCalls?: boolean,
 *   maxSystemChars?: number,
 *   maxResultChars?: number,
 *   maxPromptChars?: number,
 *   minTurnChars?: number,
 * }} options
 *   tools 為空（或 toolChoice 為 "none"）＝一般聊天，行為與先前的攤平提示相同；
 *   有工具時才帶入系統提示（宿主的規則在有工具時才有意義），並截斷到 maxSystemChars。
 *   對話總長超過 maxPromptChars 時，從最舊的回合開始縮到 minTurnChars（截斷有註明，最後一則不縮）。
 */
export function createToolExchange(options) {
  const toolChoice = options.toolChoice ?? "auto";
  const tools = toolChoice === "none" ? [] : (options.tools ?? []).filter((t) => t && typeof t.name === "string" && t.name !== "");
  const parallel = options.parallelToolCalls !== false;
  const maxResultChars = options.maxResultChars ?? MAX_RESULT_CHARS;
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
  const turns = options.turns ?? [];

  const hasTools = tools.length > 0;
  let prompt = "";

  if (turns.length > 0) {
    const sections = [];
    if (hasTools) {
      sections.push(protocolInstructions(nonce, tools, toolChoice, parallel));
      const system = (options.system ?? "").trim();
      if (system) sections.push(`Agent instructions (from the local agent):\n${clip(system, options.maxSystemChars ?? MAX_SYSTEM_CHARS)}`);
    }
    const onlyUser = turns.length === 1 && turns[0].role === "user";
    if (!hasTools && onlyUser) {
      // 單一使用者訊息、沒有工具：直接送原文，回答最自然。
      prompt = turns[0].text;
    } else {
      const last = turns[turns.length - 1];
      const needsCue = last.role !== "assistant" || Boolean(last.calls?.length);
      const cue = "以下是目前為止的對話，請接著以 Assistant 的身分回覆最後一則訊息（只輸出回覆內容）。";
      const head = needsCue ? `${cue}\n\n` : "";
      const tail = needsCue ? "\n\nAssistant:" : "";
      // 預算扣掉提示的其他部分（工具定義、系統提示與結尾 cue）；超過就從最舊的回合開始縮減。
      const fixed =
        sections.reduce((sum, section) => sum + section.length, 0) + sections.length * 2 + head.length + tail.length;
      const budget = Math.max(0, (options.maxPromptChars ?? MAX_PROMPT_CHARS) - fixed);
      const body = fitTurnBudget(turns, nonce, maxResultChars, options.minTurnChars ?? MIN_TURN_CHARS, budget).join("\n\n");
      sections.push(`${head}${body}${tail}`);
      prompt = sections.join("\n\n");
    }
  }

  let toolsByName;
  // 一般文字回覆不需要索引；工具信封首次解析時才建立，重複名稱保留第一個定義。
  const lookup = () => {
    if (!toolsByName) {
      toolsByName = new Map();
      for (const tool of tools) {
        if (!toolsByName.has(tool.name)) toolsByName.set(tool.name, tool);
      }
    }
    return toolsByName;
  };

  return {
    prompt,
    nonce,
    hasTools,
    /** 解析網頁模型的回覆：{text, calls}；格式錯誤的工具要求丟 ToolProtocolError。 */
    parse: (answer) => parseAnswer(String(answer ?? ""), { nonce, tools, toolChoice, parallel, lookup }),
  };
}

// ───────────────────────── 回覆 → 工具要求 ─────────────────────────

const FENCE = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/;

/** 整段是 JSON 物件，或整段被一個圍欄包住的 JSON 物件；否則 null。 */
function envelopeCandidate(answer) {
  const trimmed = answer.trim();
  const body = trimmed.match(FENCE)?.[1] ?? trimmed;
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function checkRequired(tool, args) {
  const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
  const missing = required.filter((key) => !(key in args));
  if (missing.length > 0) throw new ToolProtocolError(`工具 ${tool.name} 缺少必要參數：${missing.join("、")}`);
}

function parseAnswer(answer, { nonce, tools, toolChoice, parallel, lookup }) {
  if (tools.length === 0) return { text: answer, calls: [] };

  const envelope = envelopeCandidate(answer);
  const marked = envelope?.webchat === nonce;
  if (!marked) {
    // 回覆提到 nonce 卻不是合格信封：模型想呼叫工具但格式壞了，不能當成最終回答漏給使用者。
    if (answer.includes(nonce)) throw new ToolProtocolError("模型輸出的工具要求格式不正確（不是單一合格的 JSON 信封）");
    if (toolChoice === "required" || (toolChoice !== "auto" && toolChoice !== "none")) {
      throw new ToolProtocolError("這一輪必須呼叫工具，但模型只回了文字");
    }
    return { text: answer, calls: [] };
  }

  const rawCalls = envelope.tool_calls;
  if (rawCalls !== undefined && !Array.isArray(rawCalls)) throw new ToolProtocolError("tool_calls 必須是陣列");
  const calls = [];
  for (const raw of rawCalls ?? []) {
    if (!raw || typeof raw !== "object" || typeof raw.name !== "string") throw new ToolProtocolError("工具要求缺少 name");
    const tool = lookup().get(raw.name);
    if (!tool) throw new ToolProtocolError(`模型要求了不存在的工具：${raw.name}`);
    const id = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    if (tool.kind === "custom") {
      if (typeof raw.input !== "string") throw new ToolProtocolError(`自訂工具 ${tool.name} 需要字串 input`);
      calls.push({ id, name: tool.name, kind: "custom", input: raw.input });
    } else {
      const args = raw.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new ToolProtocolError(`工具 ${tool.name} 的 arguments 必須是物件`);
      checkRequired(tool, args);
      calls.push({ id, name: tool.name, kind: "function", arguments: args });
    }
  }

  const text = typeof envelope.text === "string" ? envelope.text.trim() : "";
  if (calls.length === 0) {
    if (toolChoice === "required" || (toolChoice !== "auto" && toolChoice !== "none")) {
      throw new ToolProtocolError("這一輪必須呼叫工具，但模型沒有提出任何要求");
    }
    return { text, calls: [] };
  }
  if (toolChoice !== "auto" && toolChoice !== "required" && calls[0].name !== toolChoice) {
    throw new ToolProtocolError(`這一輪必須呼叫工具 ${toolChoice}，模型卻要求了 ${calls[0].name}`);
  }
  // 宿主不允許平行呼叫時只取第一個；其餘等模型看過結果後會再要求。
  return { text, calls: parallel ? calls : calls.slice(0, 1) };
}
