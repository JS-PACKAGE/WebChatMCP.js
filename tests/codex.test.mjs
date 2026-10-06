import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerEvents,
  cachedEntries,
  createdEvents,
  decodeBody,
  encodeSse,
  failedEvents,
  flattenInput,
  mergeModels,
  newIds,
  parseSlug,
  recordModels,
  slugOf,
} from "../plugins/codex/bridge.js";
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
  assert.equal(twice.etag, "e");
});

test("官方清單不是預期形狀時，只回網頁模型並使用內建最小描述", () => {
  const merged = mergeModels(null, [{ provider: "claude" }]);
  assert.equal(merged.models.length, 1);
  assert.equal(merged.models[0].slug, "webchat/claude");
  assert.deepEqual(merged.models[0].input_modalities, ["text"]);
});

test("模型快取：每個服務都有「目前選用」，標籤依服務取代、去重", () => {
  const file = join(TMP, "models.json");
  assert.deepEqual(cachedEntries(file).filter((e) => e.label), []);
  recordModels("gemini", ["3.6 Flash", "3.1 Pro", "3.6 Flash"], file);
  recordModels("gemini", ["3.1 Pro"], file);
  const entries = cachedEntries(file);
  assert.deepEqual(entries.filter((e) => e.label), [{ provider: "gemini", label: "3.1 Pro" }]);
  assert.equal(entries.filter((e) => !e.label).length, 4);
});

test("輸入攤平：略過 developer 與 Codex 的環境區塊；單一提問送原文；多輪對話要求接續", () => {
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
