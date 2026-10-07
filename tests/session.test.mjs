import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolExchange, ToolProtocolError } from "../plugins/lib/tool-protocol.js";

const profileDir = await mkdtemp(join(tmpdir(), "webchatmcp-browser-"));
const previousProfile = process.env.WEBCHATMCP_PROFILE_DIR;
process.env.WEBCHATMCP_PROFILE_DIR = profileDir;
const { WebChatSession } = await import("../dist/session.js");
const { PROVIDERS } = await import("../dist/config.js");
if (previousProfile === undefined) delete process.env.WEBCHATMCP_PROFILE_DIR;
else process.env.WEBCHATMCP_PROFILE_DIR = previousProfile;

const session = new WebChatSession();
const composer = '<div id="prompt-textarea" contenteditable="true"></div>';
const alternateComposer = '<div contenteditable="true" role="textbox" style="white-space: pre-wrap"></div>';
const guestLogin = '<button>登入</button>';
const modelButton = '<button aria-label="選取 ChatGPT 模型">Models</button>';

try {
  await session.launch({ headless: true });
  const context = session.context;
  let html = `<title>ChatGPT</title>${composer}`;
  await context.route("https://chatgpt.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  const initialPage = session.page;

  await test("登入完成於新分頁後，狀態及模型清單讀取新 ChatGPT 頁面", async () => {
    html = `<title>ChatGPT</title>${alternateComposer}
      <button aria-label="關閉暫存對話"></button>${modelButton}
      <div role="menuitemradio" aria-checked="true">Available model<br>Description</div>`;
    await session.probeLogin("chatgpt");
    await initialPage.goto("https://chatgpt.com/auth/login");
    await initialPage.setContent('<button data-testid="login-button">Log in</button>');
    const loginPage = await context.newPage();
    await loginPage.goto(PROVIDERS.chatgpt.baseUrl);
    const result = await session.waitForLogin("chatgpt", 500);
    assert.equal(result.loggedIn, true);
    const status = await session.statusAsync("chatgpt");
    assert.equal(status.loggedIn, true);
    assert.equal(status.temporaryChat, true);
    assert.equal(status.provider, "chatgpt");
    assert.equal(status.currentUrl, loginPage.url());
    assert.deepEqual(await session.listModels("chatgpt"), {
      models: [{ label: "Available model", current: true }],
      thinking: [],
    });
    await initialPage.close();
    assert.equal((await session.statusAsync("chatgpt")).loggedIn, true);
  });

  await test("模型清單只取 menuitemradio，不把思考強度等一般 menuitem 當成模型", async () => {
    html = `<title>ChatGPT</title>${alternateComposer}${modelButton}
      <div role="menuitem">Medium</div>
      <div role="menuitem"></div>
      <div role="menuitemradio" aria-checked="true">GPT-A</div>
      <div role="menuitemradio" aria-checked="false">GPT-B<br>Leaving soon</div>`;
    const { models } = await session.listModels("chatgpt");
    assert.deepEqual(models, [
      { label: "GPT-A", current: true },
      { label: "GPT-B", current: false },
    ]);
  });

  await test("訪客輸入框不會蓋過可見的登入按鈕，未知頁面不猜測登入", async () => {
    const page = context.pages().at(-1);
    await page.setContent(`${composer}<button data-testid="login-button">Log in</button>`);
    assert.equal(await session.isLoggedIn("chatgpt"), false);
    await page.setContent(`${composer}${guestLogin}`);
    assert.equal(await session.isLoggedIn("chatgpt"), false);
    await page.setContent("<title>ChatGPT</title><p>Loading</p>");
    assert.equal(await session.isLoggedIn("chatgpt"), "unknown");
    await page.setContent(`<div hidden>${composer}</div>`);
    assert.equal(await session.isLoggedIn("chatgpt"), "unknown");
    await page.setContent(alternateComposer);
    assert.equal(await session.isLoggedIn("chatgpt"), true);
  });

  await test("頁面延遲載入且同步產生快速回覆時，仍擷取最新助理文字", async () => {
    html = `<title>ChatGPT</title><span>Temporary chat</span>
      <div data-message-author-role="assistant"><div class="markdown">Old answer</div></div>
      <script>
        setTimeout(() => {
          document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(`${alternateComposer}<button data-testid="send-button">Send</button>`)});
          document.querySelector('button').onclick = () => {
            const prompt = document.querySelector('[contenteditable]').innerText;
            const assistant = document.createElement('div');
            assistant.setAttribute('data-message-author-role', 'assistant');
            assistant.innerHTML = '<div class="markdown" style="white-space: pre-wrap"></div><button>Copy</button>';
            assistant.querySelector('.markdown').textContent = 'Answer: ' + prompt;
            document.body.append(assistant);
          };
        }, 1800);
      </script>`;
    const result = await session.ask("chatgpt", "first line\nsecond line", { timeoutMs: 12000 });
    assert.equal(result.answer, "Answer: first line\nsecond line");
    assert.equal(result.temporaryChat, true);
    assert.equal(result.completed, true);
    assert.equal(session.page.url(), PROVIDERS.chatgpt.askUrl);
  });

  await test("送出按鈕同步產生回覆時不會誤判 no_response", async () => {
    html = `<title>ChatGPT</title>${alternateComposer}<button>Save chat</button>
      <button data-testid="send-button" onclick="
        const message = document.createElement('div');
        message.setAttribute('data-markdown-text-style', 'assistant-message');
        message.textContent = 'Immediate answer';
        document.body.append(message);
      ">Send</button>`;
    const result = await session.ask("chatgpt", "quick reply", { timeoutMs: 9000 });
    assert.equal(result.answer, "Immediate answer");
    assert.equal(result.completed, true);
    assert.equal(result.temporaryChat, true);
  });

  await test("JSON 程式碼回覆排除語言標籤與複製按鈕，保留完整信封；前言不當成工具要求", async () => {
    const exchange = createToolExchange({
      turns: [{ role: "user", text: "read main.ts" }],
      tools: [{ name: "read", parameters: { required: ["path"] } }],
    });
    const answer = JSON.stringify({
      webchat: exchange.nonce,
      tool_calls: [{ name: "read", arguments: { path: "main.ts" } }],
    });
    const response = (prose) => `<title>ChatGPT</title>${alternateComposer}
      <button data-testid="send-button">Send</button><script>
        document.querySelector('button').onclick = () => {
          const message = document.createElement('div');
          message.setAttribute('data-message-author-role', 'assistant');
          message.innerHTML = ${JSON.stringify(`<div class="markdown">${prose}<pre><div>json<button>Copy</button></div><code></code></pre></div>`)};
          message.querySelector('code').textContent = ${JSON.stringify(answer)};
          document.body.append(message);
        };
      </script>`;
    html = response("");
    const result = await session.ask("chatgpt", "read main.ts", { timeoutMs: 9000 });
    assert.equal(result.answer, answer);
    assert.deepEqual(exchange.parse(result.answer).calls[0].arguments, { path: "main.ts" });
    html = response("<p>This is only an example:</p>");
    const withProse = await session.ask("chatgpt", "example", { timeoutMs: 9000 });
    assert.match(withProse.answer, /^This is only an example:/);
    assert.throws(() => exchange.parse(withProse.answer), ToolProtocolError);
  });

  await test("回覆有多個 Markdown 區塊及巢狀選擇器命中時，完整擷取而不重複", async () => {
    html = `<title>ChatGPT</title>${alternateComposer}
      <button data-testid="send-button" onclick="
        const message = document.createElement('div');
        message.setAttribute('data-message-author-role', 'assistant');
        message.innerHTML = '<div class=&quot;prose&quot;><div class=&quot;markdown&quot;>First paragraph</div></div><div class=&quot;markdown&quot; data-assistant-markdown>Second paragraph</div>';
        document.body.append(message);
      ">Send</button>`;
    const result = await session.ask("chatgpt", "full answer", { timeoutMs: 9000 });
    assert.equal(result.answer, "First paragraph\n\nSecond paragraph");
  });

  await test("巢狀程式碼與 Markdown 擷取保留換行、排除隱藏內容及複製控制", async () => {
    const content = '<div class="prose"><div class="markdown">' +
      '<p>Before <span style="display:none">display secret</span><span style="visibility:hidden">visibility secret</span><span>inline</span></p>' +
      '<section><div><pre><div>javascript<button>Copy</button></div><code>let x = 1;\nlet y = 2;</code></pre></div></section>' +
      '<div style="display:none"><pre><code>hidden code</code></pre></div><p>After</p>' +
      '</div></div><div class="markdown" data-assistant-markdown>Second block</div>';
    html = `<title>ChatGPT</title>${alternateComposer}
      <button data-testid="send-button">Send</button><script>
        document.querySelector('button').onclick = () => {
          const message = document.createElement('div');
          message.setAttribute('data-message-author-role', 'assistant');
          message.innerHTML = ${JSON.stringify(content)};
          document.body.append(message);
        };
      </script>`;
    const result = await session.ask("chatgpt", "code and prose", { timeoutMs: 9000 });
    assert.equal(result.answer.replace(/\n+/g, "\n"), "Before inline\nlet x = 1;\nlet y = 2;\nAfter\nSecond block");
    assert.equal(result.completed, true);
  });

  await test("先匹配隱藏停止鈕仍須等待後面的可見停止鈕消失，不提前完成", async () => {
    html = `<title>ChatGPT</title>${alternateComposer}
      <button data-testid="send-button">Send</button>
      <button data-testid="stop-button" style="display:none">Hidden stop</button><script>
        document.querySelector('[data-testid="send-button"]').onclick = () => {
          const message = document.createElement('div');
          message.setAttribute('data-message-author-role', 'assistant');
          message.textContent = 'Partial';
          const stop = document.createElement('button');
          stop.setAttribute('data-testid', 'stop-button');
          stop.textContent = 'Stop';
          document.body.append(message, stop);
          setTimeout(() => {
            message.textContent = 'Complete';
            stop.remove();
          }, 1600);
        };
      </script>`;
    const result = await session.ask("chatgpt", "wait for stop", { timeoutMs: 9000 });
    assert.equal(result.answer, "Complete");
    assert.equal(result.completed, true);
  });

  await test("未見停止鈕且串流短暫停頓時，不提前回傳半截 JSON", async () => {
    const answer = '{"webchat":"test","tool_calls":[]}';
    html = `<title>ChatGPT</title>${alternateComposer}
      <button data-testid="send-button">Send</button><script>
        document.querySelector('button').onclick = () => {
          const message = document.createElement('div');
          message.setAttribute('data-message-author-role', 'assistant');
          message.textContent = '{"webchat":"test",';
          document.body.append(message);
          setTimeout(() => message.textContent = ${JSON.stringify(answer)}, 500);
        };
      </script>`;
    const result = await session.ask("chatgpt", "streamed answer", { timeoutMs: 9000 });
    assert.equal(result.answer, answer);
    assert.equal(result.completed, true);
  });

  await test("預先載入：回覆後先載好下一個無痕聊天頁，下一題不再導航；頁面被動過則丟棄改現載", async () => {
    html = `<title>ChatGPT</title><span>Temporary chat</span>${alternateComposer}
      <button data-testid="send-button" onclick="
        const message = document.createElement('div');
        message.setAttribute('data-markdown-text-style', 'assistant-message');
        message.textContent = 'Warm answer';
        document.body.append(message);
      ">Send</button>`;
    let navigations = 0;
    const count = (request) => {
      if (request.isNavigationRequest() && request.url() === PROVIDERS.chatgpt.askUrl) navigations += 1;
    };
    context.on("request", count);
    try {
      await session.prewarm("chatgpt");
      assert.equal(navigations, 1);
      const warmed = await session.ask("chatgpt", "hi", { timeoutMs: 9000 });
      assert.equal(warmed.answer, "Warm answer");
      assert.equal(warmed.temporaryChat, true);
      assert.equal(navigations, 1, "預先載好的頁面應直接使用，不再導航");

      const cold = await session.ask("chatgpt", "hi again", { timeoutMs: 9000 });
      assert.equal(cold.answer, "Warm answer");
      assert.equal(navigations, 2, "預先載入的頁面用過就失效，下一題要現載");

      await session.prewarm("chatgpt");
      await session.page.goto(PROVIDERS.chatgpt.baseUrl);
      const before = navigations;
      await session.ask("chatgpt", "after touch", { timeoutMs: 9000 });
      assert.equal(navigations, before + 1, "頁面被導航離開後，預先載入的結果不可沿用");
    } finally {
      context.off("request", count);
    }
  });

  await test("預載導航尚未完成時可取消，保留原分頁且下一題仍能提問", { timeout: 12000 }, async () => {
    const original = session.page;
    const arrived = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const hold = async (route) => {
      arrived.resolve();
      await finish.promise;
      await route.fulfill({ contentType: "text/html", body: "<title>ChatGPT</title>" }).catch(() => {});
    };
    await context.route(PROVIDERS.chatgpt.askUrl, hold);
    const controller = new AbortController();
    try {
      const warming = session.prewarm("chatgpt", { signal: controller.signal });
      await arrived.promise;
      controller.abort();
      assert.equal(await warming, false);
      assert.equal(session.page, original);
      assert.equal(original.isClosed(), false);
      assert.deepEqual(context.pages(), [original], "取消後不得留下半完成分頁");
    } finally {
      finish.resolve();
      await context.unroute(PROVIDERS.chatgpt.askUrl, hold);
    }
    html = `<title>ChatGPT</title>${alternateComposer}
      <button data-testid="send-button" onclick="
        document.body.insertAdjacentHTML('beforeend', '<div data-message-author-role=&quot;assistant&quot;>After cancellation</div>');
      ">Send</button>`;
    const result = await session.ask("chatgpt", "after abort", { timeoutMs: 9000 });
    assert.equal(result.answer, "After cancellation");
  });

  await test("訪客（未登入）也能送出提示並取得回覆", async () => {
    html = `<title>ChatGPT</title>${guestLogin}${alternateComposer}
      <button data-testid="send-button" onclick="
        const message = document.createElement('li');
        message.setAttribute('data-message-role', 'assistant');
        message.innerHTML = '<div data-assistant-markdown><p>Guest answer</p></div>';
        document.body.append(message);
      ">Send</button>`;
    const result = await session.ask("chatgpt", "hi", { timeoutMs: 9000 });
    assert.equal(result.answer, "Guest answer");
    assert.equal(result.loggedIn, false);
  });

  await test("Grok 訪客送出後沒有回覆（被登入牆擋住）回 logged_out", async () => {
    await context.route("https://grok.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<title>Grok</title><a href="/sign-in">登入</a>${alternateComposer}
          <button data-testid="chat-submit">提交</button>`,
      }),
    );
    await assert.rejects(session.ask("grok", "hi", { timeoutMs: 5000 }), { code: "logged_out" });
  });

  await test("必須登入的服務（Claude）未登入時回 logged_out", async () => {
    await context.route("https://claude.ai/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<title>Sign in - Claude</title><button data-testid="continue">使用電子郵件繼續</button>',
      }),
    );
    await assert.rejects(session.ask("claude", "hi", { timeoutMs: 9000 }), { code: "logged_out" });
  });

  await test("Gemini 載入後點擊「臨時對話」按鈕進入無痕，並確認無痕狀態", async () => {
    await context.route("https://gemini.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<title>Gemini</title>
          <button aria-label="臨時對話" onclick="document.body.insertAdjacentHTML('beforeend','<div class=&quot;temporary-chat-card&quot;>card</div>')"></button>
          <rich-textarea><div role="textbox" contenteditable="true"></div></rich-textarea>
          <button aria-label="傳送訊息" onclick="
            const r = document.createElement('model-response');
            r.innerHTML = '<message-content>Gemini answer</message-content>';
            document.body.append(r);
          "></button>`,
      }),
    );
    const result = await session.ask("gemini", "hi", { timeoutMs: 9000 });
    assert.equal(result.answer, "Gemini answer");
    assert.equal(result.temporaryChat, true);
  });

  await test("ChatGPT 思考強度滑桿：依標籤移到目標段、比對不中回 thinking_not_found 且不改動設定", async () => {
    html = `<title>ChatGPT</title>${alternateComposer}${modelButton}
      <div role="menu"><div id="slider" role="slider" tabindex="0"></div><span id="level">Medium, 2 of 3.</span></div>
      <script>
        window.__index = 2;
        const names = ['Low', 'Medium', 'High'];
        document.getElementById('slider').addEventListener('keydown', (e) => {
          const next = window.__index + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
          if (next < 1 || next > 3) return;
          window.__index = next;
          document.getElementById('level').textContent = names[next - 1] + ', ' + next + ' of 3.';
        });
      </script>`;
    await session.listModels("chatgpt");
    const index = () => session.requirePage("chatgpt").evaluate(() => window.__index);
    assert.deepEqual(await session.selectThinking("chatgpt", "high"), { selected: true, label: "High" });
    assert.equal(await index(), 3);
    await assert.rejects(session.selectThinking("chatgpt", "ultra"), { code: "thinking_not_found" });
    assert.equal(await index(), 3);
    assert.deepEqual(await session.selectThinking("chatgpt", "low"), { selected: true, label: "Low" });
    assert.equal(await index(), 1);
  });

  await test("ask 同時指定 model 與 thinking：先選模型，再調思考深度", async () => {
    html = `<title>ChatGPT</title>${alternateComposer}<button>Save chat</button>${modelButton}
      <div role="menu"><div id="slider" role="slider" tabindex="0"></div><span id="level">Medium, 2 of 3.</span></div>
      <div role="menuitemradio" aria-checked="false" onclick="window.__log.push('model')">GPT-A</div>
      <div role="menuitemradio" aria-checked="true">GPT-B</div>
      <button data-testid="send-button" onclick="
        const message = document.createElement('div');
        message.setAttribute('data-markdown-text-style', 'assistant-message');
        message.textContent = 'Done';
        document.body.append(message);
      ">Send</button>
      <script>
        window.__log = [];
        window.__index = 2;
        const names = ['Low', 'Medium', 'High'];
        document.getElementById('slider').addEventListener('keydown', (e) => {
          const next = window.__index + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
          if (next < 1 || next > 3) return;
          window.__index = next;
          window.__log.push('key');
          document.getElementById('level').textContent = names[next - 1] + ', ' + next + ' of 3.';
        });
      </script>`;
    const result = await session.ask("chatgpt", "hi", { model: "GPT-A", thinking: "High", timeoutMs: 9000 });
    assert.equal(result.answer, "Done");
    const { log, index } = await session
      .requirePage("chatgpt")
      .evaluate(() => ({ log: window.__log, index: window.__index }));
    assert.equal(index, 3);
    assert.ok(log.includes("model") && log.includes("key"));
    assert.ok(log.lastIndexOf("model") < log.indexOf("key"), `model must be chosen before thinking: ${log.join(",")}`);
  });

  const modelPage = (extra = "") => `<title>ChatGPT</title><span>Temporary chat</span>${alternateComposer}${modelButton}
      <div role="menuitemradio" aria-checked="false" onclick="window.__log.push('model')">GPT-A</div>
      <div role="menuitemradio" aria-checked="true" onclick="window.__log.push('current')">GPT-B</div>
      <button data-testid="send-button" onclick="
        const message = document.createElement('div');
        message.setAttribute('data-markdown-text-style', 'assistant-message');
        message.textContent = 'Done';
        document.body.append(message);
      ">Send</button>
      <script>window.__log = [];${extra}</script>`;

  await test("指定的模型已是目前選中的就不再點它", async () => {
    html = modelPage();
    await session.ask("chatgpt", "hi", { model: "GPT-B", timeoutMs: 9000 });
    const log = await session.requirePage("chatgpt").evaluate(() => window.__log);
    assert.deepEqual(log, []);
  });

  await test("預先載入連模型一起設好：同模型的下一題不再切換也不再導航；沒指定模型的下一題不沿用", async () => {
    html = modelPage();
    let navigations = 0;
    const count = (request) => {
      if (request.isNavigationRequest() && request.url() === PROVIDERS.chatgpt.askUrl) navigations += 1;
    };
    context.on("request", count);
    try {
      await session.prewarm("chatgpt", { model: "GPT-A" });
      assert.equal(navigations, 1);
      assert.deepEqual(await session.requirePage("chatgpt").evaluate(() => window.__log), ["model"]);
      await session.ask("chatgpt", "hi", { model: "GPT-A", timeoutMs: 9000 });
      assert.equal(navigations, 1, "預先載入的頁面應直接使用");
      assert.deepEqual(await session.requirePage("chatgpt").evaluate(() => window.__log), ["model"], "同一個模型不該再切一次");

      await session.prewarm("chatgpt", { model: "GPT-A" });
      await session.ask("chatgpt", "no model given", { timeoutMs: 9000 });
      assert.equal(navigations, 3, "沒指定模型就不能沿用預先設好的模型，要重新載入");
    } finally {
      context.off("request", count);
    }
  });

  await test("Claude 的努力程度子選單：點選對應 radio，比對不中回 thinking_not_found", async () => {
    await context.route("https://claude.ai/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<title>Claude</title>${alternateComposer}
          <button data-testid="model-selector-dropdown">Model</button>
          <div role="menu">
            <div role="menuitemradio" aria-checked="true">Sonnet</div>
            <div role="menuitem" id="effortItem">努力程度</div>
          </div>
          <script>
            // 真實的子選單只在 hover 時存在，Escape 收起；假頁面照做，否則重開選單時簽章不會變
            document.getElementById('effortItem').addEventListener('mouseenter', () => {
              if (document.getElementById('effort')) return;
              const menu = document.createElement('div');
              menu.setAttribute('role', 'menu');
              menu.id = 'effort';
              for (const [label, checked] of [['Low', 'true'], ['High', 'false']]) {
                const item = document.createElement('div');
                item.setAttribute('role', 'menuitemradio');
                item.setAttribute('aria-checked', checked);
                item.textContent = label;
                item.addEventListener('click', () => { window.__effort = label; });
                menu.append(item);
              }
              document.body.append(menu);
            });
            document.addEventListener('keydown', (e) => {
              if (e.key === 'Escape') document.getElementById('effort')?.remove();
            });
          </script>`,
      }),
    );
    await session.listModels("claude");
    assert.deepEqual(await session.selectThinking("claude", "high"), { selected: true, label: "High" });
    assert.equal(await session.requirePage("claude").evaluate(() => window.__effort), "High");
    await assert.rejects(session.selectThinking("claude", "ultra"), { code: "thinking_not_found" });
  });

  await test("Gemini 的思考開關：指定即開啟，已開啟時不會再點而關掉", async () => {
    await context.route("https://gemini.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<title>Gemini</title>
          <rich-textarea><div role="textbox" contenteditable="true"></div></rich-textarea>
          <button data-test-id="bard-mode-menu-button">Mode</button>
          <gem-menu role="menu">
            <div role="menuitem" data-test-id="bard-mode-option-fast">Fast</div>
            <div role="menuitem" aria-checked="false" onclick="
              this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
              window.__clicks = (window.__clicks || 0) + 1;
            ">延伸思考</div>
          </gem-menu>`,
      }),
    );
    await session.listModels("gemini");
    const clicks = () => session.requirePage("gemini").evaluate(() => window.__clicks ?? 0);
    assert.deepEqual(await session.selectThinking("gemini", "延伸思考"), { selected: true, label: "延伸思考" });
    assert.equal(await clicks(), 1);
    await session.selectThinking("gemini", "延伸思考");
    assert.equal(await clicks(), 1);
    await assert.rejects(session.selectThinking("gemini", "不存在"), { code: "thinking_not_found" });
  });

  await test("逐模型讀思考深度：每個模型各自的清單，最後切回原本的模型", async () => {
    html = `<title>ChatGPT</title>${alternateComposer}${modelButton}
      <div role="menu"><div id="slider" role="slider" tabindex="0"></div><span id="level"></span></div>
      <div id="a" role="menuitemradio" aria-checked="true">GPT-A</div>
      <div id="b" role="menuitemradio" aria-checked="false">GPT-B</div>
      <script>
        const levelsByModel = { 'GPT-A': ['Low', 'High'], 'GPT-B': ['Low', 'Medium', 'High'] };
        window.__model = 'GPT-A';
        let index = 1;
        const render = () => {
          const names = levelsByModel[window.__model];
          document.getElementById('level').textContent = names[index - 1] + ', ' + index + ' of ' + names.length + '.';
        };
        render();
        document.getElementById('slider').addEventListener('keydown', (e) => {
          const next = index + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
          if (next < 1 || next > levelsByModel[window.__model].length) return;
          index = next;
          render();
        });
        for (const id of ['a', 'b']) {
          document.getElementById(id).addEventListener('click', () => {
            window.__model = document.getElementById(id).textContent;
            index = 1;
            for (const other of ['a', 'b']) {
              document.getElementById(other).setAttribute('aria-checked', String(other === id));
            }
            render();
          });
        }
      </script>`;
    const detailed = await session.listModelsDetailed("chatgpt");
    assert.deepEqual(
      detailed.map((m) => [m.label, m.current, m.thinking.map((t) => t.label)]),
      [
        ["GPT-A", true, ["Low", "High"]],
        ["GPT-B", false, ["Low", "Medium", "High"]],
      ],
    );
    assert.equal(await session.requirePage("chatgpt").evaluate(() => window.__model), "GPT-A");
  });

  await test("登出只清除該服務網域的 cookie", async () => {
    await context.addCookies([
      { name: "t", value: "x", domain: "chatgpt.com", path: "/" },
      { name: "t", value: "x", domain: ".openai.com", path: "/" },
      { name: "t", value: "x", domain: "example.org", path: "/" },
    ]);
    html = `<title>ChatGPT</title>${guestLogin}${alternateComposer}`;
    const result = await session.logout("chatgpt");
    assert.deepEqual(result.domains, PROVIDERS.chatgpt.domains);
    assert.equal(result.loggedIn, false);
    const domains = (await context.cookies()).map((c) => c.domain);
    assert.ok(!domains.some((d) => d.endsWith("chatgpt.com") || d.endsWith("openai.com")));
    assert.ok(domains.includes("example.org"));
  });
} finally {
  await session.close();
  await rm(profileDir, { recursive: true, force: true });
}
