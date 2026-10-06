import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerChunks,
  completionJson,
  encodeSse,
  entriesFrom,
  flattenMessages,
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

test("模型列：每個服務一筆「目前選用」＋標籤；名稱以 (WEB) 結尾", () => {
  const rows = modelRows(entriesFrom({ gemini: ["3.1 Pro", "3.1 Pro"] }));
  assert.deepEqual(rows.map((r) => r.id), ["webchat/chatgpt", "webchat/claude", "webchat/grok", "webchat/gemini", "webchat/gemini/3.1 Pro"]);
  assert.ok(rows.every((r) => r.name.endsWith("(WEB)")));
});

test("輸入攤平：拆掉 <user_query>、略過 user_info／system-reminder／system／tool；多輪要求接續", () => {
  const info = { role: "user", content: "<user_info>\nOS Version: macos\n</user_info>" };
  const reminder = { role: "user", content: "<system-reminder>\nskills…\n</system-reminder>" };
  const query = (t) => ({ role: "user", content: `<user_query>\n${t}\n</user_query>` });
  const system = { role: "system", content: "You are Grok released by xAI." };
  assert.equal(flattenMessages([system, info, reminder, query("你好")]), "你好");

  const multi = flattenMessages([
    system,
    info,
    query("1+1?"),
    { role: "assistant", content: "2", tool_calls: [{ id: "t", type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t", content: "ok" },
    query("再加 1？"),
  ]);
  assert.match(multi, /User:\n1\+1\?\n\nAssistant:\n2\n\nUser:\n再加 1？\n\nAssistant:$/);
  assert.ok(!multi.includes("xAI") && !multi.includes("user_info") && !multi.includes("bash") && !multi.includes("<user_query>"));
  assert.equal(flattenMessages([system, info]), "");
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
