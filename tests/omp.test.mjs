import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildModels,
  buildPrompt,
  createStreamSimple,
  createModelWatcher,
  describeToolError,
  loginTargets,
  McpHttpClient,
  modelId,
  parseModelId,
  parseRpcBody,
  stripServerNote,
} from "../plugins/omp/webchat/core.js";

/** 收集事件的假 stream（形狀同 AssistantMessageEventStream 的 push 介面）。 */
function fakeStream() {
  const events = [];
  return { events, push: (event) => events.push(event) };
}

const model = { id: "claude/Haiku 4.5", provider: "webchat", api: "webchatmcp" };

test("模型 id：服務代號與含斜線的模型標籤可互轉", () => {
  assert.deepEqual(parseModelId("chatgpt"), { service: "chatgpt", label: undefined });
  assert.deepEqual(parseModelId("gemini/3.5 Flash-Lite"), { service: "gemini", label: "3.5 Flash-Lite" });
  assert.deepEqual(parseModelId("x/a/b"), { service: "x", label: "a/b" });
  assert.equal(modelId("grok", "快速"), "grok/快速");
  assert.equal(modelId("grok"), "grok");
});

test("模型清單：只列有標籤的模型，去重，且丟掉已不存在的服務與沒有模型的服務名稱", () => {
  const models = buildModels(
    ["chatgpt", "claude"],
    [
      { service: "chatgpt", label: "GPT-5.5" },
      { service: "chatgpt", label: "GPT-5.5" },
      { service: "gone", label: "X" },
      { service: "claude", label: "" },
    ],
  );
  assert.deepEqual(models.map((m) => m.id), ["chatgpt/GPT-5.5"]);
  assert.equal(models[0].name, "ChatGPT · GPT-5.5");
  assert.ok(models.every((m) => m.input.length === 1 && m.input[0] === "text" && m.reasoning === false));
});

test("登入目標：沒給服務就四個都查，給了就只查那些", () => {
  assert.deepEqual(loginTargets(""), ["chatgpt", "claude", "grok", "gemini"]);
  assert.deepEqual(loginTargets("  "), ["chatgpt", "claude", "grok", "gemini"]);
  assert.deepEqual(loginTargets("claude"), ["claude"]);
  assert.deepEqual(loginTargets("claude gemini"), ["claude", "gemini"]);
  assert.deepEqual(loginTargets({}), ["chatgpt", "claude", "grok", "gemini"]);
});

test("提示組裝：單一使用者送原文；多輪保留工具要求與結果，略過思考", () => {
  assert.equal(buildPrompt({ messages: [{ role: "user", content: "你好" }] }), "你好");

  const multi = buildPrompt({
    systemPrompt: ["不該出現的系統提示"],
    messages: [
      { role: "user", content: [{ type: "text", text: "1+1?" }, { type: "image", data: "x", mimeType: "image/png" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "內部思考" },
          { type: "text", text: "2" },
          { type: "toolCall", id: "t", name: "bash", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "再加 1？" },
    ],
  });
  assert.match(multi, /User:\n1\+1\?\n\[圖片已省略/);
  assert.match(multi, /Assistant:\n\{"webchat":/);
  assert.match(multi, /"text":"2","tool_calls":\[\{"id":"t","name":"bash","arguments":\{\}\}\]/);
  assert.match(multi, /Tool result \(bash, id t\):\nok/);
  assert.match(multi, /Assistant:$/);
  assert.ok(!multi.includes("內部思考") && !multi.includes("不該出現"));

  const withSystem = buildPrompt({ systemPrompt: ["規則"], messages: [{ role: "user", content: "hi" }] }, { includeSystem: true });
  assert.match(withSystem, /^以下是目前為止的對話[\s\S]*System:\n規則[\s\S]*User:\nhi/);
});

test("伺服器附加的註記不算模型回覆；工具錯誤 JSON 轉成一行", () => {
  assert.equal(stripServerNote("答案\n\n[WebChatMCP.js] 以訪客（未登入）身分送出"), "答案");
  assert.equal(stripServerNote("含 [WebChatMCP.js] 字樣的答案"), "含 [WebChatMCP.js] 字樣的答案");
  assert.equal(describeToolError('{"error":"logged_out","message":"請先登入"}'), "logged_out: 請先登入");
  assert.equal(describeToolError("not json"), "not json");
});

test("MCP 回應：SSE 與 JSON 都能取出對應 id", () => {
  const sse = 'event: message\ndata: {"result":{"a":1},"jsonrpc":"2.0","id":2}\n\n';
  assert.deepEqual(parseRpcBody(sse, "text/event-stream", 2).result, { a: 1 });
  assert.throws(() => parseRpcBody(sse, "text/event-stream", 9), /沒有對應的結果/);
  assert.deepEqual(parseRpcBody('{"id":1,"result":{}}', "application/json", 1).result, {});
});

test("MCP SSE：多行 data、混合換行、通知、無尾端分隔與提早取得結果", () => {
  const prefix = ': keepalive\r\n\r\nevent: message\ndata: {"jsonrpc":"2.0","method":"notice"}\n\n';
  const result = 'event: message\r\ndata: {"id":7,\r\ndata:   "result":{"text":"answer"}}';
  assert.deepEqual(parseRpcBody(prefix + result, "text/event-stream", 7).result, { text: "answer" });
  assert.deepEqual(parseRpcBody(prefix + result + "\r\n\r\ndata: invalid", "text/event-stream", 7).result, { text: "answer" });
  assert.throws(() => parseRpcBody(prefix + result, "text/event-stream", 8), /沒有對應的結果/);
});

test("MCP 用戶端：握手一次、帶 session id、回報工具錯誤、session 失效時自動重連", async () => {
  const calls = [];
  let sessions = 0;
  let invalidate = false;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, sid: init.headers["mcp-session-id"] });
    if (body.method === "initialize") {
      sessions += 1;
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n\n`, {
        headers: { "content-type": "text/event-stream", "mcp-session-id": `s${sessions}` },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (invalidate) {
      invalidate = false;
      return new Response("{}", { status: 404 });
    }
    const args = body.params.arguments;
    const result = args.fail
      ? { isError: true, content: [{ type: "text", text: '{"error":"logged_out","message":"請先登入"}' }] }
      : { content: [{ type: "text", text: `echo:${args.prompt}` }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      headers: { "content-type": "application/json" },
    });
  };
  const client = new McpHttpClient("http://x/mcp", fetchImpl);

  assert.equal(await client.callTool("webchat_ask", { prompt: "a" }), "echo:a");
  assert.equal(await client.callTool("webchat_ask", { prompt: "b" }), "echo:b");
  assert.equal(sessions, 1, "第二次呼叫不應重新握手");
  assert.equal(calls.at(-1).sid, "s1");

  await assert.rejects(client.callTool("webchat_ask", { fail: true }), /logged_out: 請先登入/);

  invalidate = true;
  assert.equal(await client.callTool("webchat_ask", { prompt: "c" }), "echo:c");
  assert.equal(sessions, 2, "session 失效後應重新握手並重試一次");
});

test("連不上伺服器時，錯誤訊息指出安裝方式", async () => {
  const client = new McpHttpClient("http://x/mcp", async () => {
    throw new Error("ECONNREFUSED");
  });
  await assert.rejects(client.callTool("webchat_ask", {}), /連不上 WebChatMCP 伺服器[\s\S]*install\.sh/);
});

test("streamSimple：解析模型 id 後呼叫 webchat_ask，依序推送 start→text→done", async () => {
  const asked = [];
  const client = {
    callTool: async (name, args) => {
      asked.push({ name, args });
      return "回覆內容\n\n[WebChatMCP.js] 以訪客（未登入）身分送出";
    },
  };
  const stream = fakeStream();
  const streamSimple = createStreamSimple(client, () => stream, { timeoutSeconds: 120 });
  const returned = streamSimple(model, { messages: [{ role: "user", content: "哈囉" }] }, {});
  assert.equal(returned, stream);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(asked, [
    { name: "webchat_ask", args: { provider: "claude", prompt: "哈囉", timeout_seconds: 120, model: "Haiku 4.5" } },
  ]);
  assert.deepEqual(
    stream.events.map((e) => e.type),
    ["start", "text_start", "text_delta", "text_end", "done"],
  );
  const done = stream.events.at(-1);
  assert.equal(done.reason, "stop");
  assert.deepEqual(done.message.content, [{ type: "text", text: "回覆內容" }]);
  assert.equal(done.message.model, "claude/Haiku 4.5");
  assert.equal(done.message.provider, "webchat");
});

test("streamSimple：服務目前選用的模型不帶 model；失敗與中止以 error 事件結束", async () => {
  const asked = [];
  const failing = {
    callTool: async (_name, args) => {
      asked.push(args);
      throw new Error("logged_out: 請先登入");
    },
  };
  const stream = fakeStream();
  createStreamSimple(failing, () => stream)({ ...model, id: "grok" }, { messages: [{ role: "user", content: "x" }] }, {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!("model" in asked[0]));
  const error = stream.events.at(-1);
  assert.equal(error.type, "error");
  assert.equal(error.reason, "error");
  assert.match(error.error.errorMessage, /logged_out/);

  const controller = new AbortController();
  const aborted = fakeStream();
  const slow = {
    callTool: async () => {
      controller.abort();
      return "晚到的回覆";
    },
  };
  createStreamSimple(slow, () => aborted)(model, { messages: [{ role: "user", content: "x" }] }, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborted.events.at(-1).reason, "aborted");
  assert.ok(!aborted.events.some((e) => e.type === "text_delta"), "已中止就不該再送出文字");
});

const readTool = {
  name: "read_file",
  description: "Read a local file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

test("streamSimple：原生工具事件與工具結果往返，下一回合保留完整上下文", async () => {
  const asked = [];
  const client = {
    callTool: async (name, args) => {
      assert.equal(name, "webchat_ask");
      asked.push(args.prompt);
      if (asked.length > 1) return "檔案內容已讀取";
      const nonce = args.prompt.match(/"webchat":"([a-f0-9]+)"/)[1];
      return JSON.stringify({
        webchat: nonce,
        text: "先讀檔案",
        tool_calls: [
          { name: "read_file", arguments: { path: "a.txt" } },
          { name: "read_file", arguments: { path: "b.txt" } },
        ],
      }) + "\n\n[WebChatMCP.js] 以訪客（未登入）身分送出";
    },
  };
  const streams = [];
  const streamSimple = createStreamSimple(client, () => {
    const stream = fakeStream();
    streams.push(stream);
    return stream;
  });
  const context = { systemPrompt: ["本機規則"], tools: [readTool], messages: [{ role: "user", content: "讀取 a.txt 與 b.txt" }] };
  streamSimple(model, context, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(asked[0], /本機規則/);
  assert.match(asked[0], /Read a local file/);
  assert.match(asked[0], /"required":\["path"\]/);
  const events = streams[0].events;
  assert.deepEqual(events.map((event) => event.type), [
    "start", "text_start", "text_delta", "text_end",
    "toolcall_start", "toolcall_delta", "toolcall_end",
    "toolcall_start", "toolcall_delta", "toolcall_end", "done",
  ]);
  const done = events.at(-1);
  assert.equal(done.reason, "toolUse");
  assert.equal(done.message.stopReason, "toolUse");
  const calls = done.message.content.filter((part) => part.type === "toolCall");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.name, "read_file");
    assert.deepEqual(call.arguments, { path: index ? "b.txt" : "a.txt" });
    const end = events.filter((event) => event.type === "toolcall_end")[index];
    assert.deepEqual(end.toolCall, call);
    assert.equal(end.contentIndex, index + 1);
    assert.ok(end.partial.content.includes(call));
    const delta = events.filter((event) => event.type === "toolcall_delta")[index];
    assert.deepEqual(JSON.parse(delta.delta), call.arguments);
  }
  context.messages.push(done.message, ...calls.map((call, index) => ({
    role: "toolResult", toolCallId: call.id, toolName: call.name,
    content: [{ type: "text", text: index ? "permission denied" : "file contents: hello" }], isError: Boolean(index),
  })));
  streamSimple(model, context, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(asked[1], /讀取 a.txt 與 b.txt/);
  assert.match(asked[1], /"tool_calls":\[/);
  assert.ok(asked[1].includes(`"id":"${calls[0].id}"`));
  assert.ok(asked[1].includes(`id ${calls[0].id}`));
  assert.match(asked[1], /file contents: hello/);
  assert.match(asked[1], /, error\):\npermission denied/);
  assert.equal(streams[1].events.at(-1).reason, "stop");
});

test("streamSimple：非法工具信封回原生錯誤；純文字不會變成工具呼叫", async () => {
  for (const invalid of ["unknown", "missing", "malformed"]) {
    const stream = fakeStream();
    const client = { callTool: async (_name, { prompt }) => {
      const webchat = prompt.match(/"webchat":"([a-f0-9]+)"/)[1];
      if (invalid === "malformed") return `{"webchat":"${webchat}","tool_calls":[`;
      return JSON.stringify({ webchat, tool_calls: [{ name: invalid === "unknown" ? "bash" : "read_file", arguments: {} }] });
    } };
    createStreamSimple(client, () => stream)(model, { tools: [readTool], messages: [{ role: "user", content: "讀檔" }] }, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stream.events.at(-1).type, "error");
    assert.equal(stream.events.at(-1).reason, "error");
    assert.ok(!stream.events.some((event) => event.type === "toolcall_end"));
  }
  const stream = fakeStream();
  createStreamSimple({ callTool: async () => "請執行 read_file({path:'a.txt'})" }, () => stream)(
    model, { tools: [readTool], messages: [{ role: "user", content: "你好" }] }, {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stream.events.at(-1).reason, "stop");
  assert.ok(!stream.events.some((event) => event.type === "toolcall_end"));
});

test("模型監看：切到 webchat 才預先載入（帶模型標籤）、換模型或服務再載入、切離開才釋放、結束時釋放，重複狀態不重複呼叫", () => {
  const calls = [];
  const client = {
    callTool: async (name, args) => {
      calls.push([name, args.provider ?? null, args.model ?? null]);
      return "{}";
    },
  };
  const watcher = createModelWatcher(client);
  watcher.sync({ provider: "anthropic", id: "claude-x" });
  watcher.sync({ provider: "webchat", id: "chatgpt/GPT-5.5" });
  watcher.sync({ provider: "webchat", id: "chatgpt/GPT-5.4" });
  watcher.sync({ provider: "webchat", id: "claude/Haiku 4.5" });
  watcher.sync({ provider: "anthropic", id: "claude-x" });
  watcher.sync(undefined);
  watcher.sync({ provider: "webchat", id: "grok/Grok 4" });
  watcher.stop();
  watcher.stop();
  assert.deepEqual(calls, [
    ["webchat_warmup", "chatgpt", "GPT-5.5"],
    ["webchat_warmup", "chatgpt", "GPT-5.4"],
    ["webchat_warmup", "claude", "Haiku 4.5"],
    ["webchat_release", null, null],
    ["webchat_warmup", "grok", "Grok 4"],
    ["webchat_release", null, null],
  ]);
});

test("模型監看：伺服器呼叫失敗只交給 onError，不影響宿主", async () => {
  const errors = [];
  const watcher = createModelWatcher(
    { callTool: async () => Promise.reject(new Error("down")) },
    (err) => errors.push(err.message),
  );
  watcher.sync({ provider: "webchat", id: "chatgpt/GPT-5.5" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ["down"]);
});
