import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

test("CDP 共用既有分頁，斷線保留瀏覽器，關閉及重啟不回報舊端點", async () => {
  const profileDir = await mkdtemp(join(tmpdir(), "webchatmcp-cdp-"));
  const previousProfile = process.env.WEBCHATMCP_PROFILE_DIR;
  const previousCdp = process.env.WEBCHATMCP_CDP;
  let session;
  let attached;
  try {
    process.env.WEBCHATMCP_PROFILE_DIR = profileDir;
    process.env.WEBCHATMCP_CDP = "1";
    const { WebChatSession } = await import("../dist/session.js");
    session = new WebChatSession();
    assert.deepEqual((await session.statusAsync()).cdp, { enabled: true, endpoint: null });

    await session.launch({ headless: true });
    const endpoint = (await session.statusAsync()).cdp.endpoint;
    assert.equal(new URL(endpoint).hostname, "127.0.0.1");
    attached = await chromium.connectOverCDP(endpoint);
    const page = attached.contexts()[0].pages()[0];
    await page.setContent("<title>Shared CDP page</title><p>Local debug session</p>");
    assert.equal(await session.page.title(), "Shared CDP page", "CDP 必須連到既有瀏覽器，而不是另一個實例");

    await attached.close();
    attached = null;
    assert.equal(session.browserRunning, true);
    assert.equal(await session.page.title(), "Shared CDP page", "除錯用戶端斷線不得關閉主瀏覽器");

    await session.close();
    assert.deepEqual((await session.statusAsync()).cdp, { enabled: true, endpoint: null });
    await assert.rejects(chromium.connectOverCDP(endpoint, { timeout: 1_000 }));

    await session.launch({ headless: true });
    const relaunchedEndpoint = session.status().cdp.endpoint;
    assert.notEqual(relaunchedEndpoint, endpoint, "重啟後不可回報 DevToolsActivePort 的舊端點");
    attached = await chromium.connectOverCDP(relaunchedEndpoint);
    const relaunchedPage = attached.contexts()[0].pages()[0];
    await relaunchedPage.setContent("<title>Relaunched CDP page</title>");
    assert.equal(await session.page.title(), "Relaunched CDP page");
    await attached.close();
    attached = null;

    await session.context.close();
    assert.equal(session.browserRunning, false);
    assert.equal(session.status().cdp.endpoint, null, "使用者關閉瀏覽器也必須清空 CDP 端點");
  } finally {
    if (previousProfile === undefined) delete process.env.WEBCHATMCP_PROFILE_DIR;
    else process.env.WEBCHATMCP_PROFILE_DIR = previousProfile;
    if (previousCdp === undefined) delete process.env.WEBCHATMCP_CDP;
    else process.env.WEBCHATMCP_CDP = previousCdp;
    if (attached) await attached.close();
    if (session) await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});
