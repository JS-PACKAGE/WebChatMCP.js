import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profileDir = await mkdtemp(join(tmpdir(), "webchatmcp-plugin-profile-"));
const pluginDir = await mkdtemp(join(tmpdir(), "webchatmcp-plugins-"));
const previousProfile = process.env.WEBCHATMCP_PROFILE_DIR;
process.env.WEBCHATMCP_PROFILE_DIR = profileDir;
const { PROVIDERS, providerIds } = await import("../dist/config.js");
const { loadPlugins, parsePlugin } = await import("../dist/plugins.js");
const { WebChatSession } = await import("../dist/session.js");
if (previousProfile === undefined) delete process.env.WEBCHATMCP_PROFILE_DIR;
else process.env.WEBCHATMCP_PROFILE_DIR = previousProfile;

const valid = {
  id: "demo",
  label: "Demo Chat",
  baseUrl: "https://chat.demo.test/",
  selectors: {
    composer: 'div[role="textbox"]',
    sendButton: 'button[data-testid="send"]',
    assistantMessage: '[data-role="assistant"]',
    loginButton: 'a[href*="/login"]',
    modelSwitcher: 'button[aria-label*="model" i]',
  },
};

const write = (name, content) =>
  writeFile(join(pluginDir, name), typeof content === "string" ? content : JSON.stringify(content));

try {
  await test("最小外掛會補上預設值", () => {
    const { id, config } = parsePlugin(valid);
    assert.equal(id, "demo");
    assert.equal(config.askUrl, "https://chat.demo.test/");
    assert.equal(config.privateMode, "url");
    assert.equal(config.guest, false);
    assert.deepEqual(config.domains, ["chat.demo.test"]);
    assert.equal(config.menu, "radio");
    assert.equal(config.selectors.dismiss.length, 0);
  });

  await test("格式錯誤的外掛被拒絕並說明原因", () => {
    const bad = (patch, pattern) =>
      assert.throws(() => parsePlugin({ ...valid, ...patch }), pattern);
    bad({ id: "chatgpt" }, /已被內建服務或其他外掛使用/);
    bad({ id: "Bad_Id" }, /格式不符/);
    bad({ baseUrl: "http://chat.demo.test/" }, /https/);
    bad({ typo: 1 }, /不認得的欄位：typo/);
    bad({ domains: ["google.com"] }, /必須是 baseUrl 主機/);
    bad({ domains: ["com"] }, /必須是 baseUrl 主機/);
    bad({ privateMode: "button" }, /privateEnter 必填/);
    bad({ loginUrlPattern: "(" }, /正規表達式/);
    bad({ menu: "gemini" }, /radio/);
    bad({ selectors: { ...valid.selectors, composer: "" } }, /composer/);
    bad({ selectors: { ...valid.selectors, extra: "x" } }, /selectors 內有不認得的欄位/);
  });

  await test("上層網域可作為 domains；載入時略過 _ 開頭範本與壞檔，好的註冊成服務", async () => {
    await write("good.json", { ...valid, domains: ["demo.test"] });
    await write("_template.json", valid);
    await write("broken.json", "{ not json");
    await write("invalid.json", { ...valid, id: "other", baseUrl: "http://x.test/" });
    await write("clash.json", { ...valid, id: "grok" });
    const report = loadPlugins([pluginDir, join(pluginDir, "missing")]);
    assert.deepEqual(report.loaded.map((p) => p.id), ["demo"]);
    assert.deepEqual(
      report.skipped.map((s) => s.file.split("/").at(-1)).sort(),
      ["broken.json", "clash.json", "invalid.json"],
    );
    assert.ok(providerIds().includes("demo"));
    assert.equal(PROVIDERS.demo.label, "Demo Chat");
    assert.notEqual(PROVIDERS.grok.label, "Demo Chat", "內建服務不可被外掛覆蓋");
  });

  const session = new WebChatSession();
  try {
    await session.launch({ headless: true });
    await session.context.route("https://chat.demo.test/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<title>Demo</title><a href="/login">登入</a>
          <div role="textbox" contenteditable="true"></div>
          <button aria-label="Model picker">Models</button>
          <div role="menuitemradio" aria-checked="true">Fast</div>
          <div role="menuitemradio" aria-checked="false">Smart</div>
          <button data-testid="send" onclick="
            const m = document.createElement('div');
            m.setAttribute('data-role', 'assistant');
            m.textContent = 'Demo answer';
            document.body.append(m);
          ">Send</button>`,
      }),
    );

    await test("外掛服務可送提示（訪客）並列出模型", async () => {
      const result = await session.ask("demo", "hi", { timeoutMs: 9000 });
      assert.equal(result.answer, "Demo answer");
      assert.equal(result.loggedIn, false);
      const { models } = await session.listModels("demo");
      assert.deepEqual(models, [
        { label: "Fast", current: true },
        { label: "Smart", current: false },
      ]);
    });

    await test("外掛服務的登出只清除自己網域的 cookie", async () => {
      await session.context.addCookies([
        { name: "t", value: "x", domain: "chat.demo.test", path: "/" },
        { name: "t", value: "x", domain: "other.test", path: "/" },
      ]);
      const result = await session.logout("demo");
      assert.deepEqual(result.domains, ["demo.test"]);
      const domains = (await session.context.cookies()).map((c) => c.domain);
      assert.ok(!domains.some((d) => d.endsWith("demo.test")));
      assert.ok(domains.includes("other.test"));
    });
  } finally {
    await session.close();
  }
} finally {
  await rm(profileDir, { recursive: true, force: true });
  await rm(pluginDir, { recursive: true, force: true });
}
