import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profileDir = await mkdtemp(join(tmpdir(), "webchatmcp-browser-"));
const previousProfile = process.env.WEBCHATMCP_PROFILE_DIR;
process.env.WEBCHATMCP_PROFILE_DIR = profileDir;
const { ChatGPTSession } = await import("../dist/chatgpt.js");
const { CHATGPT } = await import("../dist/config.js");
if (previousProfile === undefined) delete process.env.WEBCHATMCP_PROFILE_DIR;
else process.env.WEBCHATMCP_PROFILE_DIR = previousProfile;

const session = new ChatGPTSession();
const composer = '<div id="prompt-textarea" contenteditable="true"></div>';
const alternateComposer = '<div contenteditable="true" role="textbox" style="white-space: pre-wrap"></div>';

try {
  await session.launch({ headless: true });
  const context = session.context;
  let html = `<title>ChatGPT</title>${composer}`;
  await context.route("https://chatgpt.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  const initialPage = session.page;

  await test("登入完成於新分頁後，狀態及模型清單讀取新 ChatGPT 頁面", async () => {
    await session.openChatGPT();
    await initialPage.goto("https://chatgpt.com/auth/login");
    await initialPage.setContent('<button data-testid="login-button">Log in</button>');
    const loginPage = await context.newPage();
    await loginPage.goto(CHATGPT.baseUrl);
    await loginPage.setContent(`<title>ChatGPT</title>${alternateComposer}
      <span>Temporary chat</span>
      <button aria-label="選取 ChatGPT 模型">Models</button>
      <div role="menuitemradio" aria-checked="true">Available model<br>Description</div>`);
    const result = await session.waitForLogin(500);
    assert.equal(result.loggedIn, true);
    const status = await session.statusAsync();
    assert.equal(status.loggedIn, true);
    assert.equal(status.temporaryChat, true);
    assert.equal(status.currentUrl, loginPage.url());
    assert.deepEqual(await session.listModels(), [{ label: "Available model", current: true }]);
    await initialPage.close();
    assert.equal((await session.statusAsync()).loggedIn, true);
  });

  await test("訪客輸入框不會蓋過可見的登入按鈕，未知頁面不猜測登入", async () => {
    const page = context.pages().at(-1);
    await page.setContent(`${composer}<button data-testid="login-button">Log in</button>`);
    assert.equal(await session.isLoggedIn(), false);
    await page.setContent("<title>ChatGPT</title><p>Loading</p>");
    assert.equal(await session.isLoggedIn(), "unknown");
    await page.setContent(`<div hidden>${composer}</div>`);
    assert.equal(await session.isLoggedIn(), "unknown");
    await page.setContent(alternateComposer);
    assert.equal(await session.isLoggedIn(), true);
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
    const result = await session.ask("first line\nsecond line", { timeoutMs: 12000 });
    assert.equal(result.answer, "Answer: first line\nsecond line");
    assert.equal(result.temporaryChat, true);
    assert.equal(result.completed, true);
    assert.equal(session.page.url(), CHATGPT.temporaryChatUrl);
  });
  await test("送出按鈕同步產生回覆時不會誤判 no_response", async () => {
    html = `<title>ChatGPT</title>${composer}<span>Temporary chat</span>
      <button data-testid="send-button" onclick="
        const message = document.createElement('div');
        message.setAttribute('data-message-author-role', 'assistant');
        message.textContent = 'Immediate answer';
        document.body.append(message);
      ">Send</button>`;
    const result = await session.ask("quick reply", { timeoutMs: 9000 });
    assert.equal(result.answer, "Immediate answer");
    assert.equal(result.completed, true);
  });
} finally {
  await session.close();
  await rm(profileDir, { recursive: true, force: true });
}
