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

const { APP, BROWSER, CLAUDE, CODEX, GROK, HERMES, DEFAULT_PROVIDER, PLUGINS, PROVIDER_IDS, PROVIDERS, SERVER, TIMEOUTS } = config;

function table(rows) {
  return rows.map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n");
}

function code(v) {
  return `\`${String(v).replaceAll("|", "\\|")}\``;
}

function list(values) {
  return values.length > 0 ? values.map(code).join("、") : "（無）";
}

function providerSection(id, p, n) {
  return `### 3.${n} ${p.label}（${code(id)}）

${table([
  [`PROVIDERS.${id}.baseUrl`, code(p.baseUrl)],
  [`PROVIDERS.${id}.askUrl`, `${code(p.askUrl)}（進入無痕方式：${code(p.privateMode)}）`],
  [`PROVIDERS.${id}.guest`, `${code(p.guest)}（未登入也能送出提示）`],
  [`PROVIDERS.${id}.domains`, `${list(p.domains)}（webchat_logout 清除 cookie 的網域）`],
  [`PROVIDERS.${id}.loginUrlPattern`, p.loginUrlPattern === null ? "（無）" : code(p.loginUrlPattern)],
  [`PROVIDERS.${id}.thinkingMenuItem`, p.thinkingMenuItem === null ? "（無）" : code(p.thinkingMenuItem)],
  [`PROVIDERS.${id}.moreModelsMenuItem`, p.moreModelsMenuItem === null ? "（無）" : code(p.moreModelsMenuItem)],
  ...Object.entries(p.selectors).map(([k, v]) => [
    `PROVIDERS.${id}.selectors.${k}`,
    v === null ? "（無）" : Array.isArray(v) ? list(v) : code(v),
  ]),
  [`PROVIDERS.${id}.privateIndicators`, list(p.privateIndicators)],
  [`PROVIDERS.${id}.loggedOutIndicators`, list(p.loggedOutIndicators)],
])}`;
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
  [BROWSER.env.headless, `預設無頭（僅人工登入時才顯示瀏覽器）；設為 \`0\` 時一律可視`],
  [BROWSER.env.answerTimeout, `覆蓋等待回覆上限（預設 ${code(TIMEOUTS.answerMs)} ms）`],
])}

## 3. 服務介面契約（${PROVIDER_IDS.join("｜")}）

每個服務各一節；UI 變動時只改 \`src/config.ts\` 的 \`PROVIDERS\`。預設服務：${code(DEFAULT_PROVIDER)}。

${PROVIDER_IDS.map((id, i) => providerSection(id, PROVIDERS[id], i + 1)).join("\n\n")}

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
  ["TIMEOUTS.challengeMs", code(TIMEOUTS.challengeMs)],
  ["TIMEOUTS.modelSwitcherMs", code(TIMEOUTS.modelSwitcherMs)],
  ["TIMEOUTS.loginWaitMs", code(TIMEOUTS.loginWaitMs)],
  ["TIMEOUTS.answerMs", code(TIMEOUTS.answerMs)],
  ["TIMEOUTS.stableChecks", `回覆文字連續 ${code(TIMEOUTS.stableChecks)} 次取樣不變且無停止按鈕即判定完成`],
  ["TIMEOUTS.stableChecksAfterStop", `見過停止按鈕後，連續 ${code(TIMEOUTS.stableChecksAfterStop)} 次取樣不變即判定完成`],
  ["TIMEOUTS.stableIntervalMs", code(TIMEOUTS.stableIntervalMs)],
  ["TIMEOUTS.postNavigationMs", `${code(TIMEOUTS.postNavigationMs)}（上限；composer 或登入鈕先出現就立刻繼續）`],
  ["TIMEOUTS.loginPollMs", code(TIMEOUTS.loginPollMs)],
])}

## 6. 外掛（新增其他聊天服務的 JSON 檔）

${table([
  ["PLUGINS.bundledDir", `${code("plugins/")}（倉庫內建；檔名以 \`_\` 開頭的範本不載入）`],
  ["PLUGINS.userDirs", `${code(PLUGINS.userDirs)}（環境變數 ${code(PLUGINS.env.dirs)} 可改，多個目錄以系統路徑分隔符號分開）`],
  ["PLUGINS.idPattern", code(PLUGINS.idPattern)],
])}

欄位格式見 \`plugins/README.md\`；外掛只含網址與選擇器，不含程式碼。

## 7. Codex 橋接（Responses 協定）

${table([
  ["CODEX.path", code(CODEX.path)],
  ["CODEX.slugPrefix", `${code(CODEX.slugPrefix)}（模型 slug：\`${CODEX.slugPrefix}/<服務>[/<模型標籤>]\`）`],
  ["CODEX.nameSuffix", `${code(CODEX.nameSuffix)}（顯示名稱尾綴）`],
  ["CODEX.upstream.chatgpt", code(CODEX.upstream.chatgpt)],
  ["CODEX.upstream.api", code(CODEX.upstream.api)],
  ["CODEX.modelsFile", `${code(CODEX.modelsFile)}（環境變數 ${code(CODEX.env.modelsFile)} 可改）`],
  ["CODEX.priority", code(CODEX.priority)],
  ["CODEX.contextWindow", code(CODEX.contextWindow)],
  ["CODEX.keepAliveMs", code(CODEX.keepAliveMs)],
  [CODEX.env.bridge, "設為 `0` 停用橋接"],
  [CODEX.env.upstream, "覆蓋非網頁模型的上游網址"],
])}

安裝與用法見 \`plugins/codex/README.md\`。

## 8. Claude 橋接（Anthropic Messages 協定）

${table([
  ["CLAUDE.path", code(CLAUDE.path)],
  ["CLAUDE.slugPrefix", `${code(CLAUDE.slugPrefix)}（模型 id：\`${CLAUDE.slugPrefix}/<服務>[/<模型標籤>]\`）`],
  ["CLAUDE.nameSuffix", `${code(CLAUDE.nameSuffix)}（顯示名稱尾綴）`],
  ["CLAUDE.upstream", code(CLAUDE.upstream)],
  ["CLAUDE.keepAliveMs", code(CLAUDE.keepAliveMs)],
  [CLAUDE.env.bridge, "設為 `0` 停用橋接"],
  [CLAUDE.env.upstream, "覆蓋非網頁模型的上游網址"],
])}

安裝與用法見 \`plugins/claude/README.md\`。

## 9. Grok 橋接（chat_completions 協定）

${table([
  ["GROK.path", code(GROK.path)],
  ["GROK.slugPrefix", `${code(GROK.slugPrefix)}（模型 id：\`${GROK.slugPrefix}/<服務>[/<模型標籤>]\`）`],
  ["GROK.nameSuffix", `${code(GROK.nameSuffix)}（顯示名稱尾綴）`],
  ["GROK.contextWindow", code(GROK.contextWindow)],
  ["GROK.keepAliveMs", code(GROK.keepAliveMs)],
  [GROK.env.bridge, "設為 `0` 停用橋接"],
])}

安裝與用法見 \`plugins/grok/README.md\`。

## 10. Hermes 橋接（chat_completions 協定）

${table([
  ["HERMES.path", code(HERMES.path)],
  ["HERMES.modelsFile", `${code(HERMES.modelsFile)}（環境變數 ${code(HERMES.env.modelsFile)} 可改）`],
  ["HERMES.contextWindow", code(HERMES.contextWindow)],
  ["HERMES.keepAliveMs", code(HERMES.keepAliveMs)],
  [HERMES.env.bridge, "設為 `0` 停用橋接"],
])}

安裝與用法見 \`plugins/hermes/README.md\`。
`;

writeFileSync(join(root, "DESIGN.md"), md, "utf8");
console.log("DESIGN.md 已由 src/config.ts 自動產生。");
