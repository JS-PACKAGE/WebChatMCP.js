import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  answerChunks,
  completionJson,
  encodeSse,
  flattenMessages,
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

test("模型清單：每個服務一筆目前選用，加上快取標籤", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-models-"));
  const file = join(dir, "models.json");
  recordModels("gemini", ["3.1 Pro", "3.1 Pro", ""], file);
  assert.deepEqual(modelIds(file).filter((id) => id.startsWith("gemini")), ["gemini", "gemini/3.1 Pro"]);
  assert.equal(modelsResponse(file).data[0].owned_by, "webchatmcp");
  rmSync(dir, { recursive: true, force: true });
});

test("輸入攤平：略過 system／tool，多輪要求接續", () => {
  assert.equal(flattenMessages([{ role: "system", content: "sys" }, { role: "user", content: "你好" }]), "你好");
  const multi = flattenMessages([
    { role: "user", content: "1+1?" },
    { role: "assistant", content: "2" },
    { role: "user", content: [{ type: "text", text: "再加 1？" }, { type: "image_url", image_url: { url: "x" } }] },
  ]);
  assert.match(multi, /User:\n1\+1\?\n\nAssistant:\n2\n\nUser:\n再加 1？\n\[圖片已省略：網頁聊天無法接收圖片\]\n\nAssistant:$/);
  assert.equal(flattenMessages([{ role: "tool", content: "x" }]), "");
});

test("chat.completion：內容一次到齊，SSE 以 [DONE] 結束", () => {
  const chunks = answerChunks("id", "chatgpt", 1, "hi", "OK");
  assert.equal(chunks[1].choices[0].finish_reason, "stop");
  assert.match(encodeSse(chunks) + SSE_DONE, /\[DONE\]/);
  assert.equal(completionJson("id", "chatgpt", 1, "hi", "OK").choices[0].message.content, "OK");
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
