import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  answerEvents,
  cachedEntries,
  createBridge,
  createdEvents,
  encodeSse,
  failedEvents,
  flattenInput,
  mergeModels,
  newIds,
  parseSlug,
  recordModels,
  refreshModels,
  slugOf,
  toolExchange,
} from "../plugins/codex/bridge.js";
import { decodeBody } from "../plugins/lib/bridgekit.js";
import { applyConfig, closeCodex, isInstalled, revertConfig, selectCodex } from "../plugins/codex/codex-plugin.mjs";
import * as zlib from "node:zlib";

const TMP = mkdtempSync(join(tmpdir(), "wcm-codex-"));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

test("模型 slug：服務與含斜線／空白的標籤可往返；非網頁模型回 null", () => {
  assert.deepEqual(parseSlug("webchat/chatgpt"), { provider: "chatgpt" });
  assert.deepEqual(parseSlug("webchat/gemini/3.5 Flash-Lite"), { provider: "gemini", label: "3.5 Flash-Lite" });
  assert.deepEqual(parseSlug("webchat/claude/a/b"), { provider: "claude", label: "a/b" });
  assert.equal(parseSlug("webchat/nope"), null, "不認得的服務不能被當成網頁模型");
  assert.equal(parseSlug("gpt-6.1-sol"), null);
  assert.equal(parseSlug(undefined), null);
  assert.equal(slugOf("grok", "快速"), "webchat/grok/快速");
});

test("模型清單：顯示名稱以 (WEB) 結尾、官方模型原樣保留、重複併入不會累積", () => {
  const official = { models: [{ slug: "gpt-x", display_name: "GPT X", visibility: "list", priority: 1, extra_field: 7 }], etag: "e" };
  const entries = [{ provider: "chatgpt" }, { provider: "chatgpt", label: "GPT-5.5" }];
  const once = mergeModels(official, entries);
  const twice = mergeModels(once, entries);
  assert.equal(twice.models.length, 3);
  assert.deepEqual(twice.models[0], official.models[0]);
  const web = twice.models.slice(1);
  assert.deepEqual(web.map((m) => m.display_name), ["ChatGPT (WEB)", "ChatGPT · GPT-5.5 (WEB)"]);
  assert.ok(web.every((m) => m.display_name.endsWith("(WEB)") && m.visibility === "list" && m.priority >= 1000));
  assert.equal(web[0].extra_field, 7, "欄位形狀沿用官方模型，新版 Codex 新增的必填欄位才不會缺");
  assert.ok(web.every((m) => m.supports_parallel_tool_calls));
  assert.equal(twice.etag, "e");
});

test("官方清單不是預期形狀時，只回網頁模型並使用內建最小描述", () => {
  const merged = mergeModels(null, [{ provider: "claude" }]);
  assert.equal(merged.models.length, 1);
  assert.equal(merged.models[0].slug, "webchat/claude");
  assert.deepEqual(merged.models[0].input_modalities, ["text"]);
});

test("模型快取：沒有標籤的服務名稱不進清單；標籤依服務取代、去重", () => {
  const file = join(TMP, "models.json");
  assert.deepEqual(cachedEntries(file), []);
  recordModels("gemini", ["3.6 Flash", "3.1 Pro", "3.6 Flash"], file);
  recordModels("gemini", ["3.1 Pro"], file);
  assert.deepEqual(cachedEntries(file), [{ provider: "gemini", label: "3.1 Pro" }]);
});

test("思考深度：兩段以上才宣告成 Codex 的 reasoning 選項（值為網頁標籤原樣）；其餘維持單一 medium；重新擷取會取代舊的", () => {
  const file = join(TMP, "thinking-models.json");
  recordModels("chatgpt", ["GPT-X", "GPT-Y"], file, {
    "GPT-X": { levels: ["Low", "Medium", "High"], default: "High" },
    "GPT-Y": { levels: ["Extended thinking"], default: "Extended thinking" },
  });
  const entries = cachedEntries(file);
  assert.deepEqual(entries[0].thinking, { levels: ["Low", "Medium", "High"], default: "High" });
  assert.equal(entries[1].thinking, undefined);
  const [x, y] = mergeModels(null, entries).models;
  assert.deepEqual(x.supported_reasoning_levels.map((l) => l.effort), ["Low", "Medium", "High"]);
  assert.equal(x.default_reasoning_level, "High");
  assert.deepEqual(y.supported_reasoning_levels.map((l) => l.effort), ["medium"]);
  assert.equal(y.default_reasoning_level, "medium");
  recordModels("chatgpt", ["GPT-X"], file);
  assert.equal(cachedEntries(file)[0].thinking, undefined, "重新擷取沒有深度時不能留著舊的");
});

test("refresh：有逐模型讀取就記下各模型的思考深度與目前值；沒有就只記標籤", async () => {
  const file = join(TMP, "refresh-thinking.json");
  const log = () => {};
  const detailed = {
    log,
    listLabels: async () => assert.fail("有 listModelsDetailed 時不該再讀一次標籤"),
    listModelsDetailed: async (provider) =>
      provider === "chatgpt"
        ? [
            { label: "GPT-X", thinking: [{ label: "Low", current: false }, { label: "High", current: true }] },
            { label: "GPT-Y", thinking: [] },
          ]
        : [],
  };
  const result = await refreshModels(detailed, file);
  assert.equal(result.providers.chatgpt, 2);
  const entries = cachedEntries(file);
  assert.deepEqual(entries.find((e) => e.label === "GPT-X").thinking, { levels: ["Low", "High"], default: "High" });
  assert.equal(entries.find((e) => e.label === "GPT-Y").thinking, undefined);
  const plain = join(TMP, "refresh-plain.json");
  await refreshModels({ log, listLabels: async (p) => (p === "claude" ? ["Sonnet"] : []) }, plain);
  assert.deepEqual(cachedEntries(plain), [{ provider: "claude", label: "Sonnet" }]);
});

test("無工具輸入：略過 developer 與環境區塊；單一提問送原文；多輪對話接續", () => {
  const dev = { type: "message", role: "developer", content: [{ type: "input_text", text: "巨大的系統提示" }] };
  const env = { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/x</cwd>\n</environment_context>" }] };
  const user = (t) => ({ type: "message", role: "user", content: [{ type: "input_text", text: t }] });
  const assistant = (t) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text: t }] });
  const noise = { type: "function_call", name: "exec", arguments: "{}" };

  assert.equal(flattenInput([dev, env, user("你好")]), "你好");
  const multi = flattenInput([dev, env, user("1+1?"), noise, assistant("2"), user("再加 1？")]);
  assert.match(multi, /^以下是目前為止的對話/);
  assert.match(multi, /User:\n1\+1\?\n\nAssistant:\n2\n\nUser:\n再加 1？\n\nAssistant:$/);
  assert.ok(!multi.includes("巨大") && !multi.includes("environment_context") && !multi.includes("exec"));
  assert.equal(flattenInput([dev, env]), "");
  assert.equal(flattenInput("直接字串"), "直接字串");
});

test("SSE：事件順序、遞增 sequence_number、完成事件含整段文字；失敗事件帶錯誤碼", () => {
  const ids = newIds();
  const created = encodeSse(createdEvents(ids, "webchat/chatgpt"), 0);
  const done = encodeSse(answerEvents(ids, "webchat/chatgpt", "問", "答案"), created.next);
  const events = (created.text + done.text)
    .trim()
    .split("\n\n")
    .map((block) => {
      const [event, data] = block.split("\n");
      return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
    });
  assert.deepEqual(
    events.map((e) => e.event),
    [
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  assert.deepEqual(events.map((e) => e.data.sequence_number), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(events.every((e) => e.data.type === e.event));
  const completed = events.at(-1).data.response;
  assert.equal(completed.status, "completed");
  assert.equal(completed.output[0].content[0].text, "答案");
  assert.equal(completed.id, ids.response);

  const failed = failedEvents(ids, "m", "logged_out", "請先登入")[0];
  assert.equal(failed.event, "response.failed");
  assert.deepEqual(failed.data.response.error, { code: "logged_out", message: "請先登入" });
});

async function withBridge(t, ask) {
  const bridge = createBridge({ ask, listLabels: async () => [], log() {} }, join(TMP, "roundtrip-models.json"));
  const server = createServer((req, res) => bridge(req, res, new URL(req.url, "http://localhost")).catch((err) => res.destroy(err)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "webchat/chatgpt", ...body }),
    });
    return { status: response.status, text: await response.text() };
  };
}

function sseEvents(text) {
  return text.trim().split("\n\n").filter((block) => block.startsWith("event:")).map((block) => JSON.parse(block.split("\n")[1].slice(6)));
}

function envelope(prompt, tool_calls, text = "") {
  const nonce = prompt.match(/"webchat":"([a-f0-9]+)"/)?.[1];
  assert.ok(nonce);
  return JSON.stringify({ webchat: nonce, text, tool_calls });
}

const execTool = { type: "function", name: "exec", description: "Run command under host permissions", parameters: {
  type: "object", properties: { command: { type: "string" } }, required: ["command"],
} };

test("Responses：函式要求原生 SSE、穩定 call_id、下一輪重送要求及結果", async (t) => {
  const prompts = [];
  const post = await withBridge(t, async (provider, prompt, options) => {
    assert.equal(provider, "chatgpt");
    assert.ok(options.signal instanceof AbortSignal);
    prompts.push(prompt);
    return { answer: prompts.length === 1 ? envelope(prompt, [{ name: "exec", arguments: { command: "pwd" } }], "Checking") : "工作目錄是 /project", notes: [] };
  });
  const input = [
    { role: "developer", content: "Respect host confirmations" },
    { role: "user", content: "<environment_context>private environment</environment_context>" },
    { role: "user", content: "查詢工作目錄" },
  ];
  const events = sseEvents((await post({ input, instructions: "Finish the task", tools: [execTool, { type: "web_search" }], parallel_tool_calls: false })).text);
  assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, i) => i));
  const output = events.at(-1).response.output;
  assert.equal(output[0].type, "message");
  const call = output[1];
  assert.equal(call.type, "function_call");
  assert.equal(call.name, "exec");
  assert.deepEqual(JSON.parse(call.arguments), { command: "pwd" });
  assert.match(call.call_id, /^call_/);
  const added = events.find((e) => e.type === "response.output_item.added" && e.output_index === 1);
  assert.equal(added.item.call_id, call.call_id);
  assert.equal(added.item.arguments, "");
  const delta = events.find((e) => e.type === "response.function_call_arguments.delta");
  assert.equal(delta.item_id, call.id);
  assert.equal(delta.output_index, 1);
  assert.equal(delta.delta, call.arguments);
  assert.equal(events.find((e) => e.type === "response.function_call_arguments.done").arguments, call.arguments);
  const final = await post({ stream: false, input: [...input, ...output, { type: "function_call_output", call_id: call.call_id, output: [{ type: "input_text", text: "/project" }] }], tools: [execTool] });
  assert.equal(JSON.parse(final.text).output[0].content[0].text, "工作目錄是 /project");
  assert.ok(prompts[0].includes("Finish the task") && prompts[0].includes("Respect host confirmations"));
  assert.ok(!prompts[0].includes("private environment") && !prompts[0].includes("web_search"));
  assert.ok(prompts[1].includes(call.call_id) && prompts[1].includes('"command":"pwd"'));
  assert.match(prompts[1], /Tool result \(exec, id call_[^)]+\):\n\/project/);
});

test("Responses：reasoning.effort 只在是該模型網頁思考深度標籤時才轉成 thinking", async (t) => {
  recordModels("chatgpt", ["GPT-X", "GPT-Y"], join(TMP, "roundtrip-models.json"), {
    "GPT-X": { levels: ["Low", "Medium", "High"], default: "Medium" },
    "GPT-Y": { levels: ["Only"] },
  });
  const asked = [];
  const post = await withBridge(t, async (provider, prompt, options) => {
    asked.push({ model: options.model, thinking: options.thinking });
    return { answer: "ok", notes: [] };
  });
  const input = [{ role: "user", content: "hi" }];
  await post({ model: "webchat/chatgpt/GPT-X", input, reasoning: { effort: "High" } });
  await post({ model: "webchat/chatgpt/GPT-X", input, reasoning: { effort: "xhigh" } });
  await post({ model: "webchat/chatgpt/GPT-Y", input, reasoning: { effort: "medium" } });
  await post({ model: "webchat/chatgpt", input, reasoning: { effort: "High" } });
  await post({ model: "webchat/chatgpt/GPT-X", input });
  assert.deepEqual(asked, [
    { model: "GPT-X", thinking: "High" },
    { model: "GPT-X", thinking: undefined },
    { model: "GPT-Y", thinking: undefined },
    { model: undefined, thinking: undefined },
    { model: "GPT-X", thinking: undefined },
  ]);
});

test("Responses：custom apply_patch 的 freeform 要求與結果往返", async (t) => {
  const patch = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
  const tools = [{ type: "custom", name: "apply_patch", description: "Apply patch", format: { type: "text" } }];
  const prompts = [];
  const post = await withBridge(t, async (_, prompt) => {
    prompts.push(prompt);
    return { answer: prompts.length === 1 ? envelope(prompt, [{ name: "apply_patch", input: patch }]) : "完成", notes: [] };
  });
  const input = [{ role: "user", content: "建立 hello.txt" }];
  const events = sseEvents((await post({ input, tools, tool_choice: { type: "custom", name: "apply_patch" } })).text);
  assert.deepEqual(events.map((e) => e.type), [
    "response.created", "response.output_item.added", "response.custom_tool_call_input.delta",
    "response.custom_tool_call_input.done", "response.output_item.done", "response.completed",
  ]);
  const call = events.at(-1).response.output[0];
  assert.equal(call.type, "custom_tool_call");
  assert.equal(call.input, patch);
  assert.equal(events[1].item.call_id, call.call_id);
  assert.equal(events[2].delta, patch);
  assert.equal(events[2].output_index, 0);
  assert.equal(events[3].input, patch);
  const final = JSON.parse((await post({ stream: false, tools, input: [...input, call, { type: "custom_tool_call_output", call_id: call.call_id, output: "Successfully applied patch" }] })).text);
  assert.equal(final.output[0].content[0].text, "完成");
  assert.ok(prompts[1].includes(JSON.stringify(patch)) && prompts[1].includes(call.call_id) && prompts[1].includes("Successfully applied patch"));
});

test("Responses：無效工具信封回 response.failed，普通文字絕不變成工具", async (t) => {
  const post = await withBridge(t, async (_, prompt) => ({ answer: envelope(prompt, [{ name: "unlisted", arguments: {} }]), notes: [] }));
  const body = { input: "執行任務", tools: [execTool] };
  const events = sseEvents((await post(body)).text);
  assert.deepEqual(events.map((e) => e.type), ["response.created", "response.failed"]);
  assert.equal(events[1].response.error.code, "tool_protocol_error");
  const failed = await post({ ...body, stream: false });
  assert.equal(failed.status, 502);
  assert.equal(JSON.parse(failed.text).status, "failed");
  const exchange = toolExchange(body);
  assert.deepEqual(exchange.parse("exec({command:'pwd'})"), { text: "exec({command:'pwd'})", calls: [] });
  assert.throws(() => toolExchange({ ...body, tool_choice: "required" }).parse("No tool"), /必須呼叫工具/);
});

test("Responses：無工具 HTTP 維持原文，none 不產生要求，未知項目安全略過", async (t) => {
  const post = await withBridge(t, async (_, prompt) => {
    assert.equal(prompt, "你好");
    return { answer: "您好", notes: [] };
  });
  const final = JSON.parse((await post({ input: "你好", stream: false })).text);
  assert.equal(final.output[0].content[0].text, "您好");
  assert.equal(toolExchange({ input: [{ type: "reasoning" }, { type: "local_shell_call" }, { type: "future_type" }, { role: "user", content: "你好" }], tools: [execTool], tool_choice: "none" }).prompt, "你好");
  const exchange = toolExchange({ input: "run", tools: [execTool], parallel_tool_calls: false });
  assert.equal(exchange.parse(envelope(exchange.prompt, [{ name: "exec", arguments: { command: "one" } }, { name: "exec", arguments: { command: "two" } }])).calls.length, 1);
});

test("Responses：非串流回傳工具項目，平行要求維持 output_index 順序", async (t) => {
  const post = await withBridge(t, async (_, prompt) => ({
    answer: envelope(prompt, [{ name: "exec", arguments: { command: "one" } }, { name: "exec", arguments: { command: "two" } }]),
    notes: [],
  }));
  const body = { input: "執行兩個要求", tools: [execTool], parallel_tool_calls: true };
  const final = JSON.parse((await post({ ...body, stream: false })).text);
  assert.equal(final.output.length, 2);
  assert.deepEqual(final.output.map((c) => JSON.parse(c.arguments).command), ["one", "two"]);
  assert.notEqual(final.output[0].call_id, final.output[1].call_id);
  const events = sseEvents((await post(body)).text);
  assert.deepEqual(events.filter((e) => e.type === "response.output_item.added").map((e) => e.output_index), [0, 1]);
  assert.deepEqual(events.filter((e) => e.type === "response.function_call_arguments.delta").map((e) => e.output_index), [0, 1]);
});

test("請求本文解碼：identity／gzip／zstd 可還原；不認得的編碼回 null", () => {
  const raw = Buffer.from('{"model":"webchat/chatgpt"}');
  assert.equal(decodeBody(raw, undefined).toString(), raw.toString());
  assert.equal(decodeBody(zlib.gzipSync(raw), "gzip").toString(), raw.toString());
  if (zlib.zstdCompressSync) assert.equal(decodeBody(zlib.zstdCompressSync(raw), "zstd").toString(), raw.toString());
  assert.equal(decodeBody(raw, "compress"), null);
});

test("config.toml：寫入頂層區塊、冪等、保留其他內容；外來的 openai_base_url 被記下並於還原時放回", () => {
  const original = 'model = "x"\n\n[tui]\na = 1\n';
  const a = applyConfig(original, "http://127.0.0.1:8321/v1");
  assert.equal(isInstalled(a.text), true);
  assert.ok(a.text.indexOf("openai_base_url") < a.text.indexOf("[tui]"), "頂層鍵必須在第一個表格之前");
  const again = applyConfig(a.text, "http://127.0.0.1:8321/v1", a.original);
  assert.equal(again.text, a.text, "重複安裝不應改變檔案");
  assert.equal(revertConfig(a.text, a.original), original, "沒有外來設定時，還原後與原檔相同");

  const foreign = 'model = "x"\nopenai_base_url = "https://old.example/v1"\n\n[tui]\na = 1\n';
  const b = applyConfig(foreign, "http://127.0.0.1:8321/v1");
  assert.equal(b.original, 'openai_base_url = "https://old.example/v1"');
  assert.equal(b.text.match(/openai_base_url\s*=/g).length, 1, "不可有重複的 TOML 鍵");
  const second = applyConfig(b.text, "http://127.0.0.1:9000/v1", b.original);
  assert.equal(second.original, b.original, "更新網址時不能把自己的設定當成外來設定");
  assert.equal(revertConfig(second.text, second.original), foreign);

  const onlyTables = applyConfig("[tui]\na = 1\n", "http://x/v1");
  assert.ok(onlyTables.text.startsWith("# >>>"));
  const empty = applyConfig("", "http://x/v1");
  assert.match(empty.text, /openai_base_url = "http:\/\/x\/v1"/);
});

test("找出 Codex：CLI、node 啟動的 npm 版與 macOS App；排除自己，從 Codex 裡執行時回報 blockedBy", () => {
  const rows = [
    { pid: 1, ppid: 0, args: "/sbin/launchd" },
    { pid: 10, ppid: 1, args: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
    { pid: 11, ppid: 10, args: "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer" },
    { pid: 12, ppid: 10, args: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server" },
    { pid: 20, ppid: 1, args: "node /usr/lib/node_modules/@openai/codex/bin/codex.js" },
    { pid: 30, ppid: 1, args: "/bin/zsh -l" },
    { pid: 31, ppid: 30, args: "bash /repo/plugins/codex/install.sh" },
    { pid: 32, ppid: 31, args: "node /repo/plugins/codex/codex-plugin.mjs install" },
    { pid: 40, ppid: 1, args: "/usr/bin/vim notes-about-codex.txt" },
  ];
  const { list, blockedBy } = selectCodex(rows, 32);
  assert.deepEqual(list.map((t) => t.pid).sort((a, b) => a - b), [10, 12, 20]);
  assert.deepEqual(blockedBy, []);

  const inside = [...rows, { pid: 50, ppid: 30, args: "/usr/local/bin/codex" }, { pid: 51, ppid: 50, args: "bash /repo/plugins/codex/install.sh" }, { pid: 52, ppid: 51, args: "node codex-plugin.mjs install" }];
  const r = selectCodex(inside, 52);
  assert.deepEqual(r.blockedBy.map((t) => t.pid), [50]);
  assert.ok(!r.list.some((t) => t.pid === 50 || t.pid === 52));
});

function fake(dir, exeName, args) {
  copyFileSync(process.execPath, join(dir, exeName));
  return spawn(join(dir, exeName), args, { stdio: "ignore", detached: true });
}

test("關閉 Codex：先請它結束；不理 SIGTERM 的再強制結束；最後確實沒有殘留", { timeout: 60_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("以 POSIX 訊號驗證");
  const dir = mkdtempSync(join(TMP, "fakebin-"));
  const polite = fake(dir, "codex", ["-e", "setInterval(()=>{},1000)"]);
  await new Promise((r) => setTimeout(r, 500));
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(m);
  try {
    assert.equal(await closeCodex({ onlyUnder: dir }), true);
  } finally {
    console.log = orig;
  }
  assert.throws(() => process.kill(polite.pid, 0), "SIGTERM 之後行程應已結束");
  assert.ok(logs.some((m) => /已關閉所有 Codex/.test(m)));

  const stubborn = fake(dir, "codex", ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
  await new Promise((r) => setTimeout(r, 700));
  console.log = (m) => logs.push(m);
  try {
    assert.equal(await closeCodex({ onlyUnder: dir }), true);
  } finally {
    console.log = orig;
  }
  assert.throws(() => process.kill(stubborn.pid, 0), "不理 SIGTERM 的行程應被強制結束");
  assert.ok(logs.some((m) => /強制結束/.test(m)));
});
