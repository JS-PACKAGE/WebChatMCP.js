import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  answerChunks,
  completionJson,
  createBridge,
  encodeSse,
  messageExchange,
  modelIds,
  modelsResponse,
  parseModel,
  recordModels,
  SSE_DONE,
} from "../plugins/hermes/bridge.js";
import { applyEnv, DUMMY_KEY, installPlugin, revertEnv, uninstallPlugin } from "../plugins/hermes/hermes-plugin.mjs";

test("模型 id：服務與標籤可解析；未知服務回 null", () => {
  assert.deepEqual(parseModel("chatgpt"), { provider: "chatgpt" });
  assert.deepEqual(parseModel("gemini/3.5 Flash-Lite"), { provider: "gemini", label: "3.5 Flash-Lite" });
  assert.equal(parseModel("grok-4.7"), null);
  assert.equal(parseModel(""), null);
});

test("模型清單：只列快取標籤，沒有模型的服務名稱不進清單", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-models-"));
  const file = join(dir, "models.json");
  recordModels("gemini", ["3.1 Pro", "3.1 Pro", ""], file);
  assert.deepEqual(modelIds(file), ["gemini/3.1 Pro"]);
  assert.equal(modelsResponse(file).data[0].owned_by, "webchatmcp");
  rmSync(dir, { recursive: true, force: true });
});

test("無工具：忽略系統提示，多輪要求接續", () => {
  assert.equal(messageExchange({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "你好" }] }).prompt, "你好");
  const multi = messageExchange({ messages: [
    { role: "user", content: "1+1?" },
    { role: "assistant", content: "2" },
    { role: "user", content: [{ type: "text", text: "再加 1？" }, { type: "image_url", image_url: { url: "x" } }] },
  ] }).prompt;
  assert.match(multi, /User:\n1\+1\?\n\nAssistant:\n2\n\nUser:\n再加 1？\n\[圖片已省略：網頁聊天無法接收圖片\]\n\nAssistant:$/);
  assert.equal(messageExchange({ messages: [] }).prompt, "");
});

test("chat.completion：內容一次到齊，SSE 以 [DONE] 結束", () => {
  const chunks = answerChunks("id", "chatgpt", 1, "hi", "OK");
  assert.equal(chunks[1].choices[0].finish_reason, "stop");
  assert.match(encodeSse(chunks) + SSE_DONE, /\[DONE\]/);
  assert.equal(completionJson("id", "chatgpt", 1, "hi", "OK").choices[0].message.content, "OK");
});

const LOCAL_TOOLS = [{ type: "function", function: { name: "read_file", description: "Read a local file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
const toolRequest = (extra = {}) => ({
  model: "grok", messages: [{ role: "system", content: "local rules" }, { role: "developer", content: "developer rules" }, { role: "user", content: "Read README" }],
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
  await createBridge({ ask: async (provider, prompt) => ({ answer: typeof answer === "function" ? answer(prompt) : answer, notes: [] }), log() {} })(req, res, new URL("http://localhost/hermes/v1/chat/completions"));
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
  const plain = await requestBridge({ model: "grok", messages: [{ role: "user", content: "Hi" }] }, (prompt) => {
    assert.equal(prompt, "Hi");
    return "Hello";
  });
  assert.equal(JSON.parse(plain.data).choices[0].message.content, "Hello");
});

test(".env：假金鑰區塊冪等，還原不碰其他列", () => {
  const once = applyEnv("OTHER=1\n");
  assert.equal(applyEnv(once), once);
  assert.match(once, new RegExp(`WEBCHAT_API_KEY=${DUMMY_KEY}`));
  assert.equal(revertEnv(once), "OTHER=1\n");
  assert.equal(revertEnv("OTHER=1\n"), "OTHER=1\n");
});

test("安裝／反安裝：沙盒 HERMES_HOME，拒絕覆蓋非本腳本的目錄", () => {
  const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  const { dest } = installPlugin({ home, mode: "copy" });
  assert.equal(readFileSync(join(dest, "plugin.yaml"), "utf8").includes("model-provider"), true);
  assert.match(readFileSync(join(home, ".env"), "utf8"), /WEBCHAT_API_KEY=webchat-local/);
  rmSync(mkdtempSync(join(tmpdir(), "hermes-empty-")), { recursive: true, force: true });
  const foreign = mkdtempSync(join(tmpdir(), "hermes-foreign-"));
  const taken = join(foreign, "plugins", "model-providers", "webchat");
  spawnSync("mkdir", ["-p", taken]);
  writeFileSync(join(taken, "keep"), "mine");
  assert.throws(() => installPlugin({ home: foreign, mode: "copy" }), /不是本腳本安裝的/);
  assert.equal(readFileSync(join(taken, "keep"), "utf8"), "mine");
  const { removed } = uninstallPlugin({ home });
  assert.equal(removed, true);
  assert.equal(readFileSync(join(home, ".env"), "utf8").includes("WEBCHAT_API_KEY"), false);
  rmSync(home, { recursive: true, force: true });
  rmSync(foreign, { recursive: true, force: true });
});
