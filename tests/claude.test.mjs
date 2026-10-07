import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  answerEvents,
  createBridge,
  createMessagesExchange,
  encodeSse,
  entriesFrom,
  errorEvents,
  flattenMessages,
  messageJson,
  modelRows,
  parseSlug,
  startEvents,
} from "../plugins/claude/bridge.js";
import { applySettings, isInstalled, revertSettings, selectClaude, serialize } from "../plugins/claude/claude-plugin.mjs";

test("模型 id：服務與含斜線／空白的標籤可解析；非網頁模型回 null", () => {
  assert.deepEqual(parseSlug("webchat/claude"), { provider: "claude" });
  assert.deepEqual(parseSlug("webchat/gemini/3.5 Flash-Lite"), { provider: "gemini", label: "3.5 Flash-Lite" });
  assert.equal(parseSlug("webchat/nope"), null);
  assert.equal(parseSlug("claude-sonnet-4-6"), null);
});

test("模型列：只列有標籤的模型，名稱以 (WEB) 結尾", () => {
  const rows = modelRows(entriesFrom({ chatgpt: ["GPT-5.5", "GPT-5.5"], gemini: ["3.1 Pro"] }));
  assert.deepEqual(rows.map((r) => r.id), ["webchat/chatgpt/GPT-5.5", "webchat/gemini/3.1 Pro"]);
  assert.ok(rows.every((r) => r.name.endsWith("(WEB)")));
  assert.equal(rows[0].name, "ChatGPT · GPT-5.5 (WEB)");
});

test("無工具輸入：略過 system 角色、system-reminder 與思考；單一提問送原文", () => {
  const reminder = { type: "text", text: "<system-reminder>\nCLAUDE.md 內容\n</system-reminder>" };
  const user = (t) => ({ role: "user", content: [reminder, { type: "text", text: t }] });
  assert.equal(flattenMessages([user("你好"), { role: "system", content: [{ type: "text", text: "# Environment" }] }]), "你好");

  const multi = flattenMessages([
    user("1+1?"),
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "內部思考" },
        { type: "text", text: "2" },
      ],
    },
    { role: "user", content: "再加 1？" },
  ]);
  assert.match(multi, /User:\n1\+1\?\n\nAssistant:\n2\n\nUser:\n再加 1？\n\nAssistant:$/);
  assert.ok(!multi.includes("內部思考") && !multi.includes("CLAUDE.md") && !multi.includes("Bash"));
  assert.equal(flattenMessages([{ role: "user", content: [reminder] }]), "");
});

test("文字 fast path 與區塊輸入一致：空白、宿主提醒及 assistant 提醒保留原語意", () => {
  const messages = [
    { role: "user", content: " \n<system-reminder>hidden</system-reminder>" },
    { role: "user", content: "  第一題 \n" },
    { role: "assistant", content: " <system-reminder>assistant text</system-reminder> " },
    { role: "user", content: " \t " },
    { role: "user", content: "\n第二題  " },
  ];
  assert.equal(flattenMessages(messages), flattenMessages(messages.map((message) => ({
    ...message, content: [{ type: "text", text: message.content }],
  }))));
});

test("Messages SSE：事件順序符合 Anthropic 串流格式；錯誤以 error 事件回報", () => {
  const events = [...startEvents("msg_1", "webchat/claude", 5), ...answerEvents("答案")];
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "ping", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.ok(events.every((e) => e.data.type === e.event));
  assert.equal(events[3].data.delta.text, "答案");
  assert.equal(events[5].data.delta.stop_reason, "end_turn");
  const text = encodeSse(events);
  assert.match(text, /^event: message_start\ndata: \{/);
  assert.ok(text.endsWith("\n\n"));

  const json = messageJson("msg_1", "webchat/claude", "問", "答案");
  assert.equal(json.content[0].text, "答案");
  assert.equal(json.stop_reason, "end_turn");
  assert.deepEqual(errorEvents("壞了")[0].data.error, { type: "api_error", message: "壞了" });
});

const TOOLS = [{ name: "read_file", description: "Read a local file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const toolBody = (extra = {}) => ({ model: "webchat/claude", messages: [{ role: "user", content: "Read example.txt" }], tools: TOOLS, ...extra });
const envelope = (prompt, calls, text = "") => JSON.stringify({
  webchat: prompt.match(/"webchat":"([a-f0-9]+)"/)[1], text, tool_calls: calls,
});

test("工具歷史：完整重送 system、tool_use 與以 id 對應的 tool_result，略過 thinking／提醒", () => {
  const exchange = createMessagesExchange(toolBody({
    system: [{ type: "text", text: "Host instructions" }],
    messages: [
      { role: "user", content: "Read example.txt" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "private thought" },
        { type: "text", text: "Reading" },
        { type: "tool_use", id: "stable_id", name: "read_file", input: { path: "example.txt" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "stable_id", content: [{ type: "text", text: "file contents" }], is_error: true },
        { type: "text", text: "<system-reminder>hidden</system-reminder>" },
      ] },
    ],
  }));
  assert.match(exchange.prompt, /Host instructions/);
  assert.match(exchange.prompt, /"id":"stable_id","name":"read_file","arguments":\{"path":"example.txt"\}/);
  assert.match(exchange.prompt, /Tool result \(read_file, id stable_id, error\):\nfile contents/);
  assert.ok(!exchange.prompt.includes("private thought") && !exchange.prompt.includes("hidden"));
  assert.match(exchange.prompt, /Assistant:$/);
});

test("tool_choice：auto、any、tool、none 與停用平行呼叫", () => {
  assert.equal(createMessagesExchange(toolBody()).parse("Final").text, "Final");
  for (const choice of [{ type: "any" }, { type: "tool", name: "read_file" }]) {
    const exchange = createMessagesExchange(toolBody({ tool_choice: choice, system: "System string" }));
    assert.match(exchange.prompt, /System string/);
    assert.throws(() => exchange.parse("Final"), /必須呼叫工具/);
    assert.equal(exchange.parse(envelope(exchange.prompt, [{ name: "read_file", arguments: { path: "a" } }])).calls[0].name, "read_file");
  }
  const selected = createMessagesExchange(toolBody({
    tools: [...TOOLS, { name: "other", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "read_file" },
  }));
  assert.throws(() => selected.parse(envelope(selected.prompt, [{ name: "other", arguments: {} }])), /必須呼叫工具 read_file/);
  const none = createMessagesExchange(toolBody({ tool_choice: { type: "none" } }));
  assert.equal(none.prompt, "Read example.txt");
  assert.deepEqual(none.parse("Plain text"), { text: "Plain text", calls: [] });
  const single = createMessagesExchange(toolBody({ tool_choice: { type: "auto", disable_parallel_tool_use: true } }));
  const calls = [{ name: "read_file", arguments: { path: "a" } }, { name: "read_file", arguments: { path: "b" } }];
  assert.equal(single.parse(envelope(single.prompt, calls)).calls.length, 1);
  const parallel = createMessagesExchange(toolBody());
  assert.equal(parallel.parse(envelope(parallel.prompt, calls)).calls.length, 2);
});

test("工具 SSE：可先文字再工具，或工具獨佔 index 0；JSON 使用相同的內容與停止原因", () => {
  for (const text of ["", "Reading now"]) {
    const exchange = createMessagesExchange(toolBody());
    const result = exchange.parse(envelope(exchange.prompt, [{ name: "read_file", arguments: { path: "example.txt" } }], text));
    const events = [...startEvents("msg_1", "webchat/claude", 10), ...answerEvents(result)];
    const starts = events.filter((e) => e.event === "content_block_start");
    assert.deepEqual(starts.map((e) => e.data.index), text ? [0, 1] : [0]);
    const tool = starts.at(-1).data.content_block;
    assert.deepEqual(tool, { type: "tool_use", id: result.calls[0].id, name: "read_file", input: {} });
    const delta = events.find((e) => e.data.delta?.type === "input_json_delta");
    assert.deepEqual(JSON.parse(delta.data.delta.partial_json), { path: "example.txt" });
    assert.equal(events.at(-2).data.delta.stop_reason, "tool_use");
    const json = messageJson("msg_1", "webchat/claude", exchange.prompt, result);
    assert.equal(json.stop_reason, "tool_use");
    assert.deepEqual(json.content.at(-1), { ...tool, input: { path: "example.txt" } });
  }
});

async function withBridge(t, ask) {
  const bridge = createBridge({ ask, log() {} });
  const server = createServer((req, res) => bridge(req, res, new URL(req.url, "http://localhost")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return (body, route = "messages") => fetch(`http://127.0.0.1:${server.address().port}/claude/v1/${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("Messages 橋接：要求工具後回傳原生 SSE／JSON，下一輪完整帶回結果", async (t) => {
  const prompts = [];
  const post = await withBridge(t, async (_provider, prompt) => {
    prompts.push(prompt);
    return { answer: envelope(prompt, [{ name: "read_file", arguments: { path: "example.txt" } }]), notes: [] };
  });
  const stream = await post(toolBody({ stream: true }));
  const sse = await stream.text();
  assert.match(sse, /"content_block":\{"type":"tool_use"/);
  assert.match(sse, /"stop_reason":"tool_use"/);
  const response = await post(toolBody());
  const json = await response.json();
  assert.equal(json.stop_reason, "tool_use");
  await post(toolBody({ messages: [
    { role: "user", content: "Read example.txt" },
    { role: "assistant", content: json.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: json.content[0].id, content: "Read result" }] },
  ] }));
  assert.ok(prompts.at(-1).includes(json.content[0].id));
  assert.match(prompts.at(-1), /Tool result \(read_file, id .*?\):\nRead result/);
  const plainCount = await (await post(toolBody({ tools: [] }), "messages/count_tokens")).json();
  const toolCount = await (await post(toolBody(), "messages/count_tokens")).json();
  assert.ok(toolCount.input_tokens > plainCount.input_tokens);
});

test("無效工具信封：串流回 error 事件，非串流回原生 error JSON，不回 tool_use", async (t) => {
  const post = await withBridge(t, async (_provider, prompt) => ({
    answer: envelope(prompt, [{ name: "unknown_tool", arguments: {} }]), notes: [],
  }));
  const stream = await post(toolBody({ stream: true }));
  const sse = await stream.text();
  assert.match(sse, /event: error\ndata: \{"type":"error","error":\{"type":"api_error"/);
  assert.ok(!sse.includes("content_block_start") && !sse.includes("message_stop"));
  const response = await post(toolBody());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).type, "error");
});

test("無工具橋接：純文字提示與原生文字 JSON 保持不變", async (t) => {
  const post = await withBridge(t, async (_provider, prompt) => {
    assert.equal(prompt, "Hello");
    return { answer: "Hi", notes: [] };
  });
  const response = await post({ model: "webchat/claude", messages: [{ role: "user", content: "Hello" }] });
  const json = await response.json();
  assert.deepEqual(json.content, [{ type: "text", text: "Hi" }]);
  assert.equal(json.stop_reason, "end_turn");
  assert.deepEqual(json.usage, { input_tokens: 2, output_tokens: 1 });
});

const MODELS = [
  { id: "webchat/chatgpt", name: "ChatGPT (WEB)" },
  { id: "webchat/claude", name: "Claude (WEB)" },
];

test("settings.json：保留使用者的 env 與 modelPicker、冪等、還原後與原檔相同", () => {
  const original = { env: { FOO: "1" }, modelPicker: { options: [{ model: "opus", label: "Mine" }] }, hooks: { a: [1] } };
  const a = applySettings(original, "http://127.0.0.1:8321/claude", MODELS);
  assert.equal(a.settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8321/claude");
  assert.deepEqual(a.settings.modelPicker.options.map((o) => o.model), ["opus", "webchat/chatgpt", "webchat/claude"]);
  assert.deepEqual(a.settings.hooks, original.hooks);
  assert.equal(isInstalled(a.settings), true);
  assert.deepEqual(original.env, { FOO: "1" }, "不可修改傳入的物件");

  const again = applySettings(a.settings, "http://127.0.0.1:8321/claude", MODELS, a.state);
  assert.deepEqual(again.settings, a.settings, "重複安裝不應改變設定（模型列不累積）");
  assert.deepEqual(revertSettings(again.settings, again.state), original);
});

test("settings.json：原本沒有 env／modelPicker 時還原會整個移除；原本有的 ANTHROPIC_BASE_URL 被記下並還原", () => {
  const empty = applySettings({}, "http://x/claude", MODELS);
  assert.deepEqual(revertSettings(empty.settings, empty.state), {});

  const foreign = { env: { ANTHROPIC_BASE_URL: "https://gw.example" } };
  const b = applySettings(foreign, "http://x/claude", MODELS);
  assert.equal(b.state.originalBaseUrl, "https://gw.example");
  const updated = applySettings(b.settings, "http://y/claude", MODELS, b.state);
  assert.equal(updated.state.originalBaseUrl, "https://gw.example", "更新網址時不能把自己的設定當成外來設定");
  assert.deepEqual(revertSettings(updated.settings, updated.state).env, foreign.env);

  assert.throws(() => applySettings({ env: "oops" }, "u", MODELS), /env 不是物件/);
  assert.throws(() => applySettings({ modelPicker: [] }, "u", MODELS), /modelPicker 不是物件/);
});

test("序列化沿用原本縮排並以換行結尾", () => {
  assert.equal(serialize({ a: 1 }, '{\n    "a": 0\n}\n'), '{\n    "a": 1\n}\n');
  assert.equal(serialize({ a: 1 }, ""), '{\n  "a": 1\n}\n');
});

test("找出 Claude：CLI、node 啟動的 npm 版與桌面 App；不誤抓名稱相近的程式；從 Claude 裡執行時回報 blockedBy", () => {
  const rows = [
    { pid: 1, ppid: 0, args: "/sbin/launchd" },
    { pid: 10, ppid: 1, args: "/Applications/Claude.app/Contents/MacOS/Claude" },
    { pid: 11, ppid: 10, args: "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer" },
    { pid: 20, ppid: 1, args: "claude -p hi --model x" },
    { pid: 21, ppid: 1, args: "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js" },
    { pid: 22, ppid: 1, args: "/Users/me/.local/share/claude/versions/2.1.289 --resume" },
    { pid: 30, ppid: 1, args: "/usr/local/bin/claude-mem worker" },
    { pid: 31, ppid: 1, args: "/usr/bin/vim claude-notes.txt" },
    { pid: 32, ppid: 1, args: "bash /repo/plugins/claude/install.sh" },
    { pid: 33, ppid: 32, args: "node /repo/plugins/claude/claude-plugin.mjs install" },
  ];
  const { list, blockedBy } = selectClaude(rows, 33);
  assert.deepEqual(list.map((t) => t.pid).sort((a, b) => a - b), [10, 20, 21]);
  assert.deepEqual(blockedBy, []);

  const inside = [
    { pid: 50, ppid: 1, args: "claude" },
    { pid: 51, ppid: 50, args: "bash /repo/plugins/claude/install.sh" },
    { pid: 52, ppid: 51, args: "node claude-plugin.mjs install" },
  ];
  const r = selectClaude(inside, 52);
  assert.deepEqual(r.blockedBy.map((t) => t.pid), [50]);
  assert.deepEqual(r.list, []);
});
