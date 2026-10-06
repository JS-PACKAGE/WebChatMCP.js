import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      <div role="menuitemradio" aria-checked="true" onclick="window.__log.push('model')">GPT-A</div>
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
