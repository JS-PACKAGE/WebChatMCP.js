import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";

const profileDir = await mkdtemp(join(tmpdir(), "webchatmcp-scheduler-"));
const previousProfile = process.env.WEBCHATMCP_PROFILE_DIR;
process.env.WEBCHATMCP_PROFILE_DIR = profileDir;
const { WebChatSession } = await import("../dist/session.js");
const { createScheduler } = await import("../dist/scheduler.js");
if (previousProfile === undefined) delete process.env.WEBCHATMCP_PROFILE_DIR;
else process.env.WEBCHATMCP_PROFILE_DIR = previousProfile;

const session = new WebChatSession();
const logs = [];
const { withBrowserLock, runAsk } = createScheduler(session, (message) => logs.push(message));
const options = { timeoutMs: 6000 };
const deferred = () => Promise.withResolvers();
const html = `<title>ChatGPT</title><span>Temporary chat</span>
  <div contenteditable="true" role="textbox" style="white-space:pre-wrap"></div>
  <button data-testid="send-button">Send</button>
  <button aria-label="選取 ChatGPT 模型" onclick="document.querySelector('[role=menu]').hidden=false">Models</button>
  <div role="menu" hidden>
    <button role="menuitemradio" aria-checked="true" onclick="this.parentElement.hidden=true">Model A</button>
    <button role="menuitemradio" aria-checked="false" onclick="this.parentElement.hidden=true">Model B</button>
  </div>
  <script>
    document.querySelector('[data-testid="send-button"]').onclick = () => {
      const prompt = document.querySelector('[contenteditable]').innerText;
      const message = document.createElement('div');
      message.setAttribute('data-message-author-role', 'assistant');
      message.innerHTML = '<div class="markdown"></div>';
      message.firstChild.textContent = 'Answer: ' + prompt;
      document.body.append(message);
      if (prompt === 'keep generating') {
        const stop = document.createElement('button');
        stop.setAttribute('data-testid', 'stop-button');
        stop.textContent = 'Stop';
        stop.onclick = () => { document.body.dataset.stopped = 'true'; stop.remove(); };
        document.body.append(stop);
        setInterval(() => message.firstChild.textContent += '.', 100);
      }
    };
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.querySelector('[role=menu]').hidden = true;
    });
  </script>`;

try {
  await session.launch({ headless: true });
  const context = session.context;
  let navigations = 0;
  let slowNext = null;
  context.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document" && request.url().startsWith("https://chatgpt.com/")) {
      navigations += 1;
    }
  });
  await context.route("https://chatgpt.com/**", async (route) => {
    const slow = slowNext;
    slowNext = null;
    if (slow) {
      slow.resolve();
      await delay(800);
    }
    await route.fulfill({ contentType: "text/html; charset=utf-8", body: html }).catch(() => {});
  });

  async function reset() {
    await withBrowserLock(async () => { await session.page.goto("about:blank"); });
  }

  await test("相容的提問沿用仍在載入的全新無痕頁，不重複導航", { timeout: 9000 }, async () => {
    async function pair(overlap) {
      await reset();
      const before = navigations;
      await runAsk("chatgpt", "first", options);
      const firstPage = session.page;
      const prewarmClosed = firstPage.waitForEvent("close");
      const loading = deferred();
      slowNext = loading;
      await loading.promise;
      if (!overlap) {
        await prewarmClosed;
        await nextTurn();
      }
      const beforeSecond = navigations;
      const result = await runAsk("chatgpt", "second", options);
      assert.equal(result.answer, "Answer: second");
      assert.equal(navigations, beforeSecond, "第二題本身不可再導航");
      await withBrowserLock(async () => {});
      await prewarmClosed;
      return navigations - before;
    }
    const baseline = await pair(false);
    const overlapping = await pair(true);
    assert.equal(baseline, 2);
    assert.equal(overlapping, baseline);
  });

  await test("不同模型的提問取消載入中的預載並繼續，不卡住互斥鎖", { timeout: 5000 }, async () => {
    await reset();
    await runAsk("chatgpt", "model A", { ...options, model: "Model A" });
    const loading = deferred();
    slowNext = loading;
    await loading.promise;
    const before = navigations;
    const result = await runAsk("chatgpt", "model B", { ...options, model: "Model B" });
    assert.equal(result.answer, "Answer: model B");
    assert.equal(navigations, before + 1);
    await withBrowserLock(async () => {});
  });

  await test("取消正在生成的提問迅速釋放鎖，下一題不用等原本生成結束", { timeout: 4000 }, async () => {
    await reset();
    const abort = new AbortController();
    const asking = runAsk("chatgpt", "keep generating", { ...options, signal: abort.signal });
    const rejected = assert.rejects(asking, { name: "AbortError" });
    await session.page.waitForSelector('[data-testid="stop-button"]');
    const generatingPage = session.page;
    const start = performance.now();
    abort.abort();
    await rejected;
    assert.ok(performance.now() - start < 1500, "取消不應等到回答逾時");
    assert.equal(await generatingPage.locator("body").getAttribute("data-stopped"), "true");
    assert.equal((await runAsk("chatgpt", "after cancellation", options)).answer, "Answer: after cancellation");
    await withBrowserLock(async () => {});
    assert.ok(logs.some((message) => message.includes("ask cancelled")));
  });

  await test("在佇列內取消的提問不會呼叫 session.ask", { timeout: 2000 }, async () => {
    await reset();
    const entered = deferred();
    const release = deferred();
    const held = withBrowserLock(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const originalAsk = session.ask;
    let calls = 0;
    session.ask = function (...args) { calls += 1; return originalAsk.apply(this, args); };
    try {
      const abort = new AbortController();
      const asking = runAsk("chatgpt", "must not send", { ...options, signal: abort.signal });
      const rejected = assert.rejects(asking, { name: "AbortError" });
      abort.abort();
      release.resolve();
      await held;
      await rejected;
      assert.equal(calls, 0);
    } finally {
      release.resolve();
      session.ask = originalAsk;
    }
  });
} finally {
  await withBrowserLock(() => session.close());
  await rm(profileDir, { recursive: true, force: true });
}
