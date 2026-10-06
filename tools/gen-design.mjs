#!/usr/bin/env node
/**
 * 由 src/config.ts（單一事實來源）自動產生 DESIGN.md。
 * 用法：node tools/gen-design.mjs
 * DESIGN.md 禁止手改；常數變更一律改 src/config.ts 後重新產生。
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let config;
try {
  config = await import(join(root, "src", "config.ts"));
} catch {
  config = await import(join(root, "dist", "config.js"));
}

const { APP, BROWSER, CHATGPT, SERVER, TIMEOUTS } = config;

function table(rows) {
  return rows.map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n");
}

function code(v) {
  return `\`${String(v)}\``;
}

const md = `# ${APP.program} DESIGN — 常數唯一來源

> 本檔由 \`node tools/gen-design.mjs\` 從 \`src/config.ts\` 自動產生，禁止手改。
> 常數衝突以本檔為準（來源即 \`src/config.ts\`）；流程與架構衝突以 \`AGENTS.md\` 為準。

## 1. 應用常數

${table([
  ["name", code(APP.name)],
  ["program", code(APP.program)],
  ["version", code(APP.version)],
  ["website", `[${APP.website}](${APP.website})`],
  ["repository", `[${APP.repository}](${APP.repository})`],
  ["license", code(APP.license)],
])}

## 2. 瀏覽器與持久化設定

${table([
  ["BROWSER.channel", `${code(BROWSER.channel)}（\`chromium\` 內建｜\`chrome\`｜\`msedge\`）`],
  ["BROWSER.headlessDefault", code(BROWSER.headlessDefault)],
  ["BROWSER.profileDir", `${code(BROWSER.profileDir)}（登入狀態持久化目錄）`],
  ["BROWSER.viewport", code(`${BROWSER.viewport.width}×${BROWSER.viewport.height}`)],
])}

### 2.1 環境變數

${table([
  [BROWSER.env.profileDir, `覆蓋 profile 目錄（預設 ${code(BROWSER.profileDir)}）`],
  [BROWSER.env.channel, `覆蓋瀏覽器通道（預設 ${code(BROWSER.channel)}）`],
  [BROWSER.env.headless, `設為 \`1\` 時無頭啟動（登入仍需可視，建議不設）`],
  [BROWSER.env.answerTimeout, `覆蓋等待回覆上限（預設 ${code(TIMEOUTS.answerMs)} ms）`],
])}

## 3. ChatGPT 介面契約

${table([
  ["CHATGPT.baseUrl", code(CHATGPT.baseUrl)],
  ["CHATGPT.temporaryChatUrl", code(CHATGPT.temporaryChatUrl)],
])}

### 3.1 DOM 選擇器（UI 變動時只改 src/config.ts）

${table([
  ["selectors.composer", code(CHATGPT.selectors.composer)],
  ["selectors.composerAlt", code(CHATGPT.selectors.composerAlt)],
  ["selectors.sendButton", code(CHATGPT.selectors.sendButton)],
  ["selectors.sendButtonAlt", code(CHATGPT.selectors.sendButtonAlt)],
  ["selectors.stopButton", code(CHATGPT.selectors.stopButton)],
  ["selectors.assistantMessage", code(CHATGPT.selectors.assistantMessage)],
  ["selectors.userMessage", code(CHATGPT.selectors.userMessage)],
  ["selectors.loginButton", code(CHATGPT.selectors.loginButton)],
])}

### 3.2 畫面指標字

${table([
  ["temporaryChatIndicators", CHATGPT.temporaryChatIndicators.map(code).join("、")],
  ["loggedOutIndicators", CHATGPT.loggedOutIndicators.map(code).join("、")],
])}

## 4. 連線設定（stdio ＋ Streamable HTTP 同時啟用）

${table([
  ["SERVER.httpPort", `${code(SERVER.httpPort)}（設 \`0\` 停用 HTTP）`],
  ["SERVER.httpHost", `${code(SERVER.httpHost)}（\`127.0.0.1\` 僅本機；\`0.0.0.0\` 開放區網，無認證慎用）`],
  ["SERVER.httpPath", code(SERVER.httpPath)],
  ["endpoint", `[http://127.0.0.1:${SERVER.httpPort}${SERVER.httpPath}](http://127.0.0.1:${SERVER.httpPort}${SERVER.httpPath})`],
])}

### 4.1 環境變數（連線）

${table([
  [SERVER.env.port, `覆蓋 HTTP port（預設 ${code(SERVER.httpPort)}）`],
  [SERVER.env.host, `覆蓋監聽位址（預設 ${code(SERVER.httpHost)}）`],
])}

## 5. 時間參數

${table([
  ["TIMEOUTS.navigationMs", code(TIMEOUTS.navigationMs)],
  ["TIMEOUTS.loginWaitMs", code(TIMEOUTS.loginWaitMs)],
  ["TIMEOUTS.answerMs", code(TIMEOUTS.answerMs)],
  ["TIMEOUTS.stableChecks", `回覆文字連續 ${code(TIMEOUTS.stableChecks)} 次取樣不變且無停止按鈕即判定完成`],
  ["TIMEOUTS.stableIntervalMs", code(TIMEOUTS.stableIntervalMs)],
  ["TIMEOUTS.loginPollMs", code(TIMEOUTS.loginPollMs)],
])}
`;

writeFileSync(join(root, "DESIGN.md"), md, "utf8");
console.log("DESIGN.md 已由 src/config.ts 自動產生。");
