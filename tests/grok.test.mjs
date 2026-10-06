import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  answerChunks,
  completionJson,
  createBridge,
  encodeSse,
  entriesFrom,
  messageExchange,
  modelRows,
  parseSlug,
  SSE_DONE,
  startChunks,
} from "../plugins/grok/bridge.js";
import { applyConfig, isInstalled, revertConfig, selectGrok } from "../plugins/grok/grok-plugin.mjs";

test("模型 id：服務與含斜線／空白的標籤可解析；非網頁模型回 null", () => {
  assert.deepEqual(parseSlug("webchat/grok"), { provider: "grok" });
  assert.deepEqual(parseSlug("webchat/gemini/3.5 Flash-Lite"), { provider: "gemini", label: "3.5 Flash-Lite" });
  assert.equal(parseSlug("webchat/nope"), null);
  assert.equal(parseSlug("grok-4.7"), null);
});

test("模型列：只列有標籤的模型，名稱以 (WEB) 結尾", () => {
  const rows = modelRows(entriesFrom({ gemini: ["3.1 Pro", "3.1 Pro"] }));
  assert.deepEqual(rows.map((r) => r.id), ["webchat/gemini/3.1 Pro"]);
  assert.ok(rows.every((r) => r.name.endsWith("(WEB)")));
});

test("無工具：拆掉 user_query、略過環境區塊與系統提示；多輪要求接續", () => {
  const info = { role: "user", content: "<user_info>\nOS Version: macos\n</user_info>" };
  const reminder = { role: "user", content: "<system-reminder>\nskills…\n</system-reminder>" };
  const query = (t) => ({ role: "user", content: `<user_query>\n${t}\n</user_query>` });
  const system = { role: "system", content: "You are Grok released by xAI." };
  assert.equal(messageExchange({ messages: [system, info, reminder, query("你好")] }).prompt, "你好");
  const multi = messageExchange({ messages: [system, info, query("1+1?"), { role: "assistant", content: "2" }, query("再加 1？")] }).prompt;
  assert.match(multi, /User:\n1\+1\?\n\nAssistant:\n2\n\nUser:\n再加 1？\n\nAssistant:$/);
  assert.ok(!multi.includes("xAI") && !multi.includes("user_info") && !multi.includes("<user_query>"));
  assert.equal(messageExchange({ messages: [system, info] }).prompt, "");
});

test("chat.completion SSE：角色 delta → 內容 → stop → 用量 → [DONE]；非串流回完整 completion", () => {
  const chunks = [...startChunks("c1", "webchat/grok", 1), ...answerChunks("c1", "webchat/grok", 1, "問", "答案")];
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[1].choices[0].delta.content, "答案");
  assert.equal(chunks[2].choices[0].finish_reason, "stop");
  assert.deepEqual(chunks[3].choices, []);
  assert.equal(chunks[3].usage.total_tokens, chunks[3].usage.prompt_tokens + chunks[3].usage.completion_tokens);
  const text = encodeSse(chunks) + SSE_DONE;
  assert.ok(text.startsWith("data: {") && text.endsWith("data: [DONE]\n\n"));

  const json = completionJson("c1", "webchat/grok", 1, "問", "答案");
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices[0].message.content, "答案");
});

const LOCAL_TOOLS = [{ type: "function", function: { name: "read_file", description: "Read a local file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
const toolRequest = (extra = {}) => ({
  model: "webchat/grok", messages: [{ role: "system", content: "local rules" }, { role: "developer", content: "developer rules" }, { role: "user", content: "Read README" }],
  tools: LOCAL_TOOLS, ...extra,
});
const envelope = (prompt, calls, text = "") => JSON.stringify({ webchat: prompt.match(/"webchat":"([^"]+)"/)[1], text, tool_calls: calls });
const readCall = { name: "read_file", arguments: { path: "README.md" } };

async function requestBridge(body, answer) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  const res = new EventEmitter();
  let data = "";
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (part) => { data += part; return true; };
  res.end = (part = "") => { data += part; res.writableEnded = true; };
  await createBridge({ ask: async (provider, prompt) => ({ answer: typeof answer === "function" ? answer(prompt) : answer, notes: [] }), log() {} })(req, res, new URL("http://localhost/grok/chat/completions"));
  return { status: res.status, data };
}
const sseObjects = (data) => data.split("\n\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));

test("工具信封轉原生 SSE：文字、呼叫名稱/id、參數、tool_calls 結束原因與用量", async () => {
  const response = await requestBridge(toolRequest({ stream: true }), (prompt) => envelope(prompt, [readCall, readCall], "Reading"));
  assert.equal(response.status, 200);
  const chunks = sseObjects(response.data);
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[1].choices[0].delta.content, "Reading");
  for (let index = 0; index < 2; index++) {
    const call = chunks[2 + index * 2].choices[0].delta.tool_calls[0];
    assert.equal(call.index, index);
    assert.ok(call.id);
    assert.equal(call.type, "function");
    assert.deepEqual(call.function, { name: "read_file", arguments: "" });
    assert.equal(chunks[3 + index * 2].choices[0].delta.tool_calls[0].function.arguments, '{"path":"README.md"}');
  }
  assert.equal(chunks[6].choices[0].finish_reason, "tool_calls");
  assert.deepEqual(chunks[7].choices, []);
  assert.ok(chunks[7].usage.total_tokens > 0);
  assert.ok(response.data.endsWith(SSE_DONE));
});

test("非串流原生工具呼叫，下一輪重送相同 id 的呼叫與工具結果", async () => {
  const response = await requestBridge(toolRequest(), (prompt) => envelope(prompt, [readCall]));
  const completion = JSON.parse(response.data);
  const { message, finish_reason } = completion.choices[0];
  assert.equal(finish_reason, "tool_calls");
  assert.equal(message.content, null);
  assert.equal(message.tool_calls[0].function.arguments, '{"path":"README.md"}');
  const followup = toolRequest({ messages: [...toolRequest().messages, message, { role: "tool", tool_call_id: message.tool_calls[0].id, content: "File contents" }] });
  const final = await requestBridge(followup, (prompt) => {
    assert.match(prompt, /local rules/);
    assert.match(prompt, /developer rules/);
    assert.ok(prompt.includes(`"id":"${message.tool_calls[0].id}"`));
    assert.ok(prompt.includes(`Tool result (read_file, id ${message.tool_calls[0].id}):\nFile contents`));
    assert.ok(prompt.includes('"arguments":{"path":"README.md"}'));
    return "Finished";
  });
  assert.equal(JSON.parse(final.data).choices[0].message.content, "Finished");
  assert.equal(JSON.parse(final.data).choices[0].finish_reason, "stop");
});

test("tool_choice 與 parallel_tool_calls 轉協定限制；none 保留一般聊天", () => {
  const required = messageExchange(toolRequest({ tool_choice: "required", parallel_tool_calls: false }));
  assert.match(required.prompt, /MUST call a tool/);
  assert.match(required.prompt, /exactly one call/);
  assert.throws(() => required.parse("No call"));
  assert.equal(required.parse(envelope(required.prompt, [readCall, readCall])).calls.length, 1);
  const named = messageExchange(toolRequest({ tool_choice: { type: "function", function: { name: "read_file" } } }));
  assert.match(named.prompt, /MUST call the tool "read_file"/);
  assert.equal(named.parse(envelope(named.prompt, [readCall])).calls[0].name, "read_file");
  const none = messageExchange(toolRequest({ tool_choice: "none" }));
  assert.equal(none.prompt, "Read README");
  assert.deepEqual(none.parse("ordinary answer"), { text: "ordinary answer", calls: [] });
});

test("無效工具信封走既有串流／非串流錯誤路徑，不會回傳工具呼叫", async () => {
  for (const stream of [true, false]) {
    const response = await requestBridge(toolRequest({ stream }), (prompt) => envelope(prompt, [{ name: "unknown", arguments: {} }]));
    if (stream) {
      assert.ok(sseObjects(response.data).some((chunk) => chunk.error?.type === "api_error"));
      assert.ok(!response.data.includes('"finish_reason":"tool_calls"'));
    } else {
      assert.equal(response.status, 502);
      assert.equal(JSON.parse(response.data).error.type, "api_error");
    }
  }
  const plain = await requestBridge({ model: "webchat/grok", messages: [{ role: "user", content: "Hi" }] }, (prompt) => {
    assert.equal(prompt, "Hi");
    return "Hello";
  });
  assert.equal(JSON.parse(plain.data).choices[0].message.content, "Hello");
});

const MODELS = [
  { id: "webchat/chatgpt", name: "ChatGPT (WEB)" },
  { id: 'webchat/gemini/3.5 "Flash"', name: 'Gemini · 3.5 "Flash" (WEB)' },
];

test("config.toml：保留原內容、冪等、還原後與原檔相同；標籤中的引號會跳脫", () => {
  const original = '[ui]\ntheme = "auto"\n\n[models]\ndefault = "grok-build"\n';
  const a = applyConfig(original, "http://127.0.0.1:8321/grok", MODELS);
  assert.equal(isInstalled(a), true);
  assert.ok(a.startsWith(original.trimEnd()));
  assert.match(a, /\[model\."webchat\/chatgpt"\]\nmodel = "webchat\/chatgpt"\nbase_url = "http:\/\/127\.0\.0\.1:8321\/grok"\nname = "ChatGPT \(WEB\)"/);
  assert.match(a, /\[model\."webchat\/gemini\/3\.5 \\"Flash\\""\]/);
  assert.match(a, /api_backend = "chat_completions"\ncontext_window = 128000/);
  assert.equal(applyConfig(a, "http://127.0.0.1:8321/grok", MODELS), a, "重複安裝不應改變檔案（模型表格不累積）");
  assert.equal(revertConfig(a), original);
  assert.equal(revertConfig(applyConfig("", "http://x/grok", MODELS)), "");
});

test("config.toml：已有不是本外掛寫的 webchat/ 模型表格時拒絕（避免重複表格）", () => {
  assert.throws(() => applyConfig('[model."webchat/chatgpt"]\nmodel = "x"\n', "http://x/grok", MODELS), /不是本外掛寫入/);
});

test("找出 grok：CLI／leader；不誤抓 Grok Bot 與名稱相近的程式；從 grok 裡執行時回報 blockedBy", () => {
  const rows = [
    { pid: 1, ppid: 0, args: "/sbin/launchd" },
    { pid: 10, ppid: 1, args: "grok" },
    { pid: 11, ppid: 1, args: "/Users/me/.grok/bin/grok leader --socket /x" },
    { pid: 12, ppid: 1, args: "grok -p hi -m x" },
    { pid: 20, ppid: 1, args: "/Applications/Grok Bot.app/Contents/MacOS/Grok Bot" },
    { pid: 21, ppid: 20, args: "/Applications/Grok Bot.app/Contents/Frameworks/Grok Bot Helper.app/Contents/MacOS/Grok Bot Helper --type=gpu-process" },
    { pid: 30, ppid: 1, args: "/usr/bin/vim grok-notes.txt" },
    { pid: 31, ppid: 1, args: "bash /repo/plugins/grok/install.sh" },
    { pid: 32, ppid: 31, args: "node /repo/plugins/grok/grok-plugin.mjs install" },
  ];
  const { list, blockedBy } = selectGrok(rows, 32);
  assert.deepEqual(list.map((t) => t.pid).sort((a, b) => a - b), [10, 11, 12]);
  assert.deepEqual(blockedBy, []);

  const inside = [
    { pid: 50, ppid: 1, args: "grok" },
    { pid: 51, ppid: 50, args: "bash /repo/plugins/grok/install.sh" },
    { pid: 52, ppid: 51, args: "node grok-plugin.mjs install" },
  ];
  const r = selectGrok(inside, 52);
  assert.deepEqual(r.blockedBy.map((t) => t.pid), [50]);
  assert.deepEqual(r.list, []);
});
