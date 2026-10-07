import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

const profileDir = await mkdtemp(join(tmpdir(), "webchatmcp-prewarm-"));
const previousProfile = process.env.WEBCHATMCP_PROFILE_DIR;
process.env.WEBCHATMCP_PROFILE_DIR = profileDir;
const { WebChatSession } = await import("../dist/session.js");
const { createScheduler } = await import("../dist/scheduler.js");
if (previousProfile === undefined) delete process.env.WEBCHATMCP_PROFILE_DIR;
else process.env.WEBCHATMCP_PROFILE_DIR = previousProfile;

const html = `<!doctype html><title>Gemini</title><div class="temporary-chat-card">Temporary chat</div>
  <div contenteditable="true" role="textbox"></div>
  <button aria-label="Send message">Send</button>
  <button data-test-id="bard-mode-menu-button" onclick="document.querySelector('gem-menu').hidden=false">Models</button>
  <gem-menu hidden>
    <button data-test-id="bard-mode-option-a" aria-checked="true">A</button>
    <button data-test-id="bard-mode-option-b" aria-checked="false">B</button>
    <button role="menuitem" aria-checked="false">Extended</button>
  </gem-menu>
  <script>
    const menu = document.querySelector('gem-menu');
    const thinking = menu.querySelector('[role=menuitem]');
    window.state = { model: 'A', thinking: false, thinkingClicks: 0 };
    for (const button of menu.querySelectorAll('[data-test-id]')) button.onclick = () => {
      for (const item of menu.querySelectorAll('[data-test-id]')) item.setAttribute('aria-checked', String(item === button));
      state.model = button.textContent;
      state.thinking = false;
      thinking.setAttribute('aria-checked', 'false');
      menu.hidden = true;
    };
    thinking.onclick = () => {
      state.thinking = !state.thinking;
      state.thinkingClicks++;
      thinking.setAttribute('aria-checked', String(state.thinking));
      menu.hidden = true;
    };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') menu.hidden = true; });
    document.querySelector('[aria-label="Send message"]').onclick = () => {
      const message = document.createElement('model-response');
      const content = document.createElement('message-content');
      content.textContent = JSON.stringify({ ...state, prompt: document.querySelector('[contenteditable]').textContent });
      message.append(content);
      document.body.append(message);
    };
  </script>`;

const session = new WebChatSession();
const scheduler = createScheduler(session, () => {});
let navigations = 0;
let hold = null;
const options = { timeoutMs: 15000 };
const ask = async (prompt, settings = {}) => JSON.parse((await session.ask("gemini", prompt, { ...options, ...settings })).answer);
try {
  await session.launch({ headless: true });
  await session.context.route("https://gemini.google.com/**", async (route) => {
    navigations++;
    const gate = hold;
    hold = null;
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    await route.fulfill({ contentType: "text/html; charset=utf-8", body: html }).catch(() => {});
  });

  await test("重複暖機保留未使用的頁面，但每題仍使用全新的聊天", async () => {
    await session.prewarm("gemini");
    const page = session.page;
    const before = navigations;
    assert.equal(await session.prewarm("gemini"), true);
    assert.equal(session.page, page);
    assert.equal(navigations, before);
    assert.deepEqual(await ask("first"), { model: "A", thinking: false, thinkingClicks: 0, prompt: "first" });
    assert.equal(navigations, before);
    assert.deepEqual(await ask("second"), { model: "A", thinking: false, thinkingClicks: 0, prompt: "second" });
    assert.equal(navigations, before + 1);
  });

  await test("只指定思考深度也能預先設定，重複暖機與下一題不切換開關", async () => {
    await session.prewarm("gemini", { thinking: "Extended" });
    const before = navigations;
    await session.prewarm("gemini", { thinking: "Extended" });
    assert.deepEqual(await ask("thinking", { thinking: "Extended" }), {
      model: "A", thinking: true, thinkingClicks: 1, prompt: "thinking",
    });
    assert.equal(navigations, before);
  });

  await test("接手預載後換模型，必須重新套用會被模型切換重設的思考深度", async () => {
    await session.prewarm("gemini", { model: "A", thinking: "Extended" });
    const before = navigations;
    assert.deepEqual(await ask("new model", { model: "B", thinking: "Extended" }), {
      model: "B", thinking: true, thinkingClicks: 2, prompt: "new model",
    });
    assert.equal(navigations, before);
  });

  await test("未指定選項與導航後暖機都不沿用不相容的預載設定", async () => {
    await session.prewarm("gemini", { model: "B", thinking: "Extended" });
    const before = navigations;
    assert.deepEqual(await ask("default"), { model: "A", thinking: false, thinkingClicks: 0, prompt: "default" });
    assert.equal(navigations, before + 1);
    await session.prewarm("gemini");
    const stale = session.page;
    await stale.goto("about:blank");
    assert.equal(await session.prewarm("gemini"), true);
    assert.notEqual(session.page, stale);
    assert.equal(stale.isClosed(), true);
  });

  await test("明確暖機接手送出後並行、仍在載入的預載，不取消後重開分頁", { timeout: 9000 }, async () => {
    // 上一個測試留下可用的預載頁：這一題直接接手，送出後的並行預載就是下一次導航。
    const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
    hold = gate;
    try {
      const asked = await scheduler.runAsk("gemini", "schedule", { ...options, model: "A" });
      assert.equal(JSON.parse(asked.answer).prompt, "schedule");
      await gate.entered.promise;
      const before = navigations;
      const warming = scheduler.runWarmup("gemini", "A");
      await nextTurn();
      gate.release.resolve();
      assert.equal(await warming, true);
      assert.equal(navigations, before);
      const result = await scheduler.runAsk("gemini", "reuse", { ...options, model: "A" });
      assert.equal(JSON.parse(result.answer).prompt, "reuse");
      // 這一題沒有自己導航；唯一一次是它送出後為下一題並行預載。
      assert.equal(navigations, before + 1);
    } finally {
      gate.release.resolve();
      await scheduler.withBrowserLock(async () => {});
    }
  });
} finally {
  await scheduler.withBrowserLock(() => session.close());
  await rm(profileDir, { recursive: true, force: true });
}
