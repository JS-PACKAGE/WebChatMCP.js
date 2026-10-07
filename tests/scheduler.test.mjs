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
      if (prompt === 'keep generating' || prompt.startsWith('slow')) {
        const stop = document.createElement('button');
        stop.setAttribute('data-testid', 'stop-button');
        stop.textContent = 'Stop';
        stop.onclick = () => { document.body.dataset.stopped = 'true'; stop.remove(); };
        document.body.append(stop);
        if (prompt.startsWith('slow')) setTimeout(() => stop.remove(), 600);
        else setInterval(() => message.firstChild.textContent += '.', 100);
      }
    };
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.querySelector('[role=menu]').hidden = true;
    });
  </script>`;

async function waitUntil(condition, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    assert.ok(performance.now() < deadline, "等待條件逾時");
    await delay(10);
  }
}

try {
  await session.launch({ headless: true });
  const context = session.context;
  let navigations = 0;
  let held = null;
  await context.route("https://chatgpt.com/**", async (route) => {
    if (route.request().resourceType() !== "document") return route.fulfill({ status: 204 }).catch(() => {});
    navigations += 1;
    const gate = held?.at === navigations ? held : null;
    if (gate) {
      held = null;
      gate.entered.resolve();
      await gate.release.promise;
    }
    await route.fulfill({ contentType: "text/html; charset=utf-8", body: html }).catch(() => {});
  });

  /** 擋住從現在起第 n 次導航，直到 release。 */
  function holdNavigation(n) {
    held = { at: navigations + n, entered: deferred(), release: deferred() };
    return held;
  }

  async function reset() {
    await withBrowserLock(async () => {
      for (const page of context.pages()) if (page !== session.page) await page.close();
      await session.page.goto("about:blank");
    });
  }

  await test("送出後就並行載入下一頁：生成期間完成預載，下一題直接接手、不必導航", { timeout: 9000 }, async () => {
    await reset();
    const before = navigations;
    const firstPage = session.page;
    const firstClosed = firstPage.waitForEvent("close");
    let answered = false;
    const asking = runAsk("chatgpt", "slow first", options).finally(() => { answered = true; });
    await waitUntil(() => navigations === before + 2);
    assert.equal(answered, false, "預載的導航應發生在回覆完成之前");
    assert.equal((await asking).answer, "Answer: slow first");
    await firstClosed;

    // 第二題若需要自己導航，會卡在擋住的下一次導航；能回覆代表直接用了預載頁，被擋的是它自己的並行預載。
    const gate = holdNavigation(1);
    try {
      assert.equal((await runAsk("chatgpt", "second", options)).answer, "Answer: second");
      await gate.entered.promise;
      assert.equal(navigations, before + 3);
    } finally {
      gate.release.resolve();
      await withBrowserLock(async () => {});
    }
  });

  await test("相容的提問接手仍在載入的預載頁，不重複導航", { timeout: 9000 }, async () => {
    await reset();
    const before = navigations;
    const gate = holdNavigation(2);
    try {
      assert.equal((await runAsk("chatgpt", "first", options)).answer, "Answer: first");
      await gate.entered.promise;
      const asking = runAsk("chatgpt", "second", options);
      await nextTurn();
      gate.release.resolve();
      assert.equal((await asking).answer, "Answer: second");
      // 第一題、被擋的預載、第二題送出後自己的預載；第二題本身沒有導航。
      assert.equal(navigations, before + 3);
    } finally {
      gate.release.resolve();
      await withBrowserLock(async () => {});
    }
  });

  await test("不同模型的提問取消載入中的預載並繼續，不卡住互斥鎖", { timeout: 9000 }, async () => {
    await reset();
    const gate = holdNavigation(2);
    try {
      await runAsk("chatgpt", "model A", { ...options, model: "Model A" });
      await gate.entered.promise;
      const before = navigations;
      const result = await runAsk("chatgpt", "model B", { ...options, model: "Model B" });
      assert.equal(result.answer, "Answer: model B");
      // 第二題自己導航一次，送出後再並行預載一次；被取消的預載不留下分頁。
      assert.equal(navigations, before + 2);
    } finally {
      gate.release.resolve();
      await withBrowserLock(async () => {});
    }
  });

  await test("取消正在生成的提問迅速釋放鎖，並中止尚未完成的預載", { timeout: 6000 }, async () => {
    await reset();
    const gate = holdNavigation(2);
    try {
      const abort = new AbortController();
      const asking = runAsk("chatgpt", "keep generating", { ...options, signal: abort.signal });
      const rejected = assert.rejects(asking, { name: "AbortError" });
      await gate.entered.promise;
      const generatingPage = session.page;
      await generatingPage.waitForSelector('[data-testid="stop-button"]');
      const start = performance.now();
      abort.abort();
      await rejected;
      assert.ok(performance.now() - start < 1500, "取消不應等到回答逾時");
      assert.equal(await generatingPage.locator("body").getAttribute("data-stopped"), "true");
      await waitUntil(() => context.pages().length === 1);
      assert.equal(context.pages()[0], generatingPage, "被取消的預載分頁應關閉");
      gate.release.resolve();
      assert.equal((await runAsk("chatgpt", "after cancellation", options)).answer, "Answer: after cancellation");
      await withBrowserLock(async () => {});
      assert.ok(logs.some((message) => message.includes("ask cancelled")));
    } finally {
      gate.release.resolve();
    }
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
