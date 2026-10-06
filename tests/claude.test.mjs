import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerEvents,
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

test("模型列：每個服務一筆「目前選用」＋擷取到的標籤；名稱以 (WEB) 結尾", () => {
  const rows = modelRows(entriesFrom({ chatgpt: ["GPT-5.5", "GPT-5.5"], gemini: ["3.1 Pro"] }));
  assert.deepEqual(
    rows.map((r) => r.id),
    ["webchat/chatgpt", "webchat/chatgpt/GPT-5.5", "webchat/claude", "webchat/grok", "webchat/gemini", "webchat/gemini/3.1 Pro"],
  );
  assert.ok(rows.every((r) => r.name.endsWith("(WEB)")));
  assert.equal(rows[1].name, "ChatGPT · GPT-5.5 (WEB)");
});

test("輸入攤平：略過 system 角色、system-reminder 區塊、工具與思考；單一提問送原文", () => {
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
        { type: "tool_use", id: "t", name: "Bash", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
    { role: "user", content: "再加 1？" },
  ]);
  assert.match(multi, /User:\n1\+1\?\n\nAssistant:\n2\n\nUser:\n再加 1？\n\nAssistant:$/);
  assert.ok(!multi.includes("內部思考") && !multi.includes("CLAUDE.md") && !multi.includes("Bash"));
  assert.equal(flattenMessages([{ role: "user", content: [reminder] }]), "");
});

test("Messages SSE：事件順序符合 Anthropic 串流格式；錯誤以 error 事件回報", () => {
  const events = [...startEvents("msg_1", "webchat/claude", 5), ...answerEvents("答案")];
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "content_block_start", "ping", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
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
