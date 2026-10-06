/**
 * MCP 冒煙測試：以真實 stdio JSON-RPC 對話驗證伺服器可啟動、
 * 工具清單正確、webchat_status 可呼叫。
 * 執行：npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "WebChatMCP.js");

function rpcClient() {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    // 測試不佔預設 port，也不載入使用者自己的外掛（避免 provider 清單隨機器而異）
    env: { ...process.env, WEBCHATMCP_PORT: "0", WEBCHATMCP_PLUGINS_DIR: join(tmpdir(), "webchatmcp-no-plugins") },
  });
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (method, params, id) => {
    if (id !== undefined) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    } else {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    }
  };
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1e9);
      pending.set(id, resolve);
      send(method, params, id);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 15000);
    });
  return { child, request, send };
}

test("MCP handshake、tools/list 與 webchat_status（stdio）", async () => {
  const { child, request, send } = rpcClient();
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "webchatmcp-smoke", version: "0.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "webchatmcp.js");
    send("notifications/initialized", {});

    const list = await request("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "webchat_ask",
      "webchat_close",
      "webchat_login",
      "webchat_logout",
      "webchat_models",
      "webchat_release",
      "webchat_status",
      "webchat_warmup",
    ]);

    const ask = list.result.tools.find((t) => t.name === "webchat_ask");
    assert.ok(ask.inputSchema.properties.prompt, "webchat_ask 需定義 prompt 參數");
    assert.ok(ask.inputSchema.properties.model, "webchat_ask 需定義 model 參數");
    assert.deepEqual(
      ask.inputSchema.properties.provider.enum,
      ["chatgpt", "claude", "grok", "gemini"],
      "webchat_ask 需可選 chatgpt｜claude｜grok｜gemini",
    );

    const status = await request("tools/call", { name: "webchat_status", arguments: {} });
    const payload = JSON.parse(status.result.content[0].text);
    assert.equal(payload.browserRunning, false);
    assert.equal(payload.loggedIn, "unknown");
    assert.ok(payload.profileDir.length > 0);
    assert.equal(payload.provider, null);
    assert.equal(payload.http.enabled, false, "WEBCHATMCP_PORT=0 時 HTTP 應停用");
    assert.equal(status.result.isError, undefined);
  } finally {
    child.kill("SIGTERM");
  }
});

test("package.json 與 DESIGN.md 一致性", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.engines.node, ">=22");
  const design = readFileSync(join(root, "DESIGN.md"), "utf8");
  assert.ok(design.includes(`version\` | \`${pkg.version}\``), "DESIGN.md 版本須與 package.json 一致");
  assert.ok(design.includes("禁止手改"));
});

async function parseRpcResponse(res) {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    return JSON.parse(text);
  }
  // text/event-stream：取第一筆含 id 的 data 行
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    try {
      const msg = JSON.parse(trimmed.slice(5).trim());
      if (msg.id !== undefined) return msg;
    } catch {
      /* 忽略非 JSON 事件 */
    }
  }
  throw new Error(`回應中找不到 JSON-RPC 訊息：${text.slice(0, 200)}`);
}

test("HTTP transport：POST /mcp initialize＋tools/list", async () => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, WEBCHATMCP_PORT: String(port), WEBCHATMCP_PLUGINS_DIR: join(tmpdir(), "webchatmcp-no-plugins") },
  });
  const base = `http://127.0.0.1:${port}/mcp`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  try {
    // 連線探測（server 起來之前會 ECONNREFUSED）
    let initRes = null;
    for (let i = 0; i < 40 && !initRes; i++) {
      try {
        initRes = await fetch(base, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "webchatmcp-smoke-http", version: "0.0.0" },
            },
          }),
        });
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(initRes, "HTTP endpoint 應可連線");
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId, "initialize 應回傳 Mcp-Session-Id");
    const initMsg = await parseRpcResponse(initRes);
    assert.equal(initMsg.result.serverInfo.name, "webchatmcp.js");

    await fetch(base, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const listRes = await fetch(base, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(listRes.status, 200);
    const listMsg = await parseRpcResponse(listRes);
    const names = listMsg.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "webchat_ask",
      "webchat_close",
      "webchat_login",
      "webchat_logout",
      "webchat_models",
      "webchat_release",
      "webchat_status",
      "webchat_warmup",
    ]);
  } finally {
    child.kill("SIGTERM");
  }
});
