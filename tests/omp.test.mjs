import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildModels,
  buildPrompt,
  createStreamSimple,
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

test("提示組裝：單一使用者訊息送原文；多輪對話攤平並要求接續；工具與思考不送出", () => {
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
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "再加 1？" },
    ],
  });
  assert.match(multi, /User:\n1\+1\?\n\[圖片已省略/);
  assert.match(multi, /Assistant:\n2\n/);
  assert.match(multi, /Tool result \(bash\):\nok/);
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
