#!/usr/bin/env node
/**
 * WebChatMCP × Grok Build（xAI 的 grok CLI）外掛的安裝／反安裝核心（install.sh／install.ps1 等四支腳本都只是呼叫它）。
 *
 *   node grok-plugin.mjs install   [--url URL] [--grok-home DIR] [--no-close] [--refresh-models]
 *   node grok-plugin.mjs uninstall [--grok-home DIR] [--no-close] [--purge]
 *
 * install：確認 WebChatMCP 伺服器的橋接可用 → 關閉所有 grok → 在 config.toml 加一段標記區塊，
 *          內含名稱結尾 (WEB) 的自訂模型 [model."webchat/..."]（base_url 指向橋接）。
 * uninstall：關閉所有 grok → 移除那段區塊。
 * 關不掉 grok 時不動設定，提示使用者手動關閉後重跑。不讀、不寫任何憑證。
 */

import { copyFileSync, chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ancestorsOf, closeProcesses, exeOf } from "../lib/proc.mjs";

const BEGIN = "# >>> webchatmcp-grok (managed by plugins/grok; remove with its uninstall script) >>>";
const END = "# <<< webchatmcp-grok <<<";
const BACKUP_FILE = "config.toml.webchatmcp.bak";
const DEFAULT_URL = `http://127.0.0.1:${process.env.WEBCHATMCP_PORT ?? 8321}/grok`;
const DESCRIPTION = "Through WebChatMCP (private web chat; no tool calls)";

const say = (m) => console.log(`[grok-webchat] ${m}`);

// ───────────────────────── config.toml 編輯（純函式，供測試） ─────────────────────────

export function removeBlock(text) {
  const out = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.trim() === BEGIN) inside = true;
    else if (inside && line.trim() === END) inside = false;
    else if (!inside) out.push(line);
  }
  return out.join("\n");
}

export function isInstalled(text) {
  return text.split("\n").some((l) => l.trim() === BEGIN);
}

/** TOML 基本字串（JSON.stringify 的輸出對這些字元是合法的 TOML）。 */
const str = (s) => JSON.stringify(s);

/** 在檔案結尾加上標記區塊。models: [{ id, name }]。若有不是本外掛寫的 webchat/ 模型表格就拒絕（避免重複的 TOML 表格）。 */
export function applyConfig(text, url, models, contextWindow = 128000) {
  const stripped = removeBlock(text);
  if (/^\s*\[model\.\s*["']webchat\//m.test(stripped)) {
    throw new Error('config.toml 已有不是本外掛寫入的 [model."webchat/..."] 表格；請先移除或改名，沒有修改任何設定');
  }
  const tables = models
    .map((m) =>
      [
        `[model.${str(m.id)}]`,
        `model = ${str(m.id)}`,
        `base_url = ${str(url)}`,
        `name = ${str(m.name)}`,
        `description = ${str(DESCRIPTION)}`,
        'api_key = "webchatmcp-local"',
        'api_backend = "chat_completions"',
        `context_window = ${contextWindow}`,
        "",
      ].join("\n"),
    )
    .join("\n");
  const head = stripped.replace(/\s*$/, "");
  return `${head}${head ? "\n\n" : ""}${BEGIN}\n${tables}${END}\n`;
}

/** 還原：移除區塊並整理結尾空行。 */
export function revertConfig(text) {
  const out = removeBlock(text).replace(/\s*$/, "");
  return out ? `${out}\n` : "";
}

// ───────────────────────── 關閉 grok ─────────────────────────

/**
 * 從行程列表挑出 Grok Build：可執行檔名為 grok（TUI、headless、leader 常駐行程）。
 * 不會碰名稱相近的其他程式（例如 Grok Bot.app）。排除自己與祖先（從 grok 裡面執行腳本會把自己關掉）。
 */
export function selectGrok(rows, selfPid, onlyUnder = null) {
  const targets = new Map();
  for (const r of rows) {
    const exe = exeOf(r);
    if (onlyUnder && !exe.startsWith(onlyUnder)) continue;
    if (/(^|[\\/])grok(\.exe)?(\s|$)/.test(exe)) targets.set(r.pid, { ...r, kind: "cli" });
  }
  const ancestors = ancestorsOf(rows, selfPid);
  const blockedBy = [...targets.values()].filter((t) => ancestors.has(t.pid));
  const list = [...targets.values()].filter((t) => t.pid !== selfPid && !ancestors.has(t.pid));
  return { list, blockedBy };
}

export const closeGrok = ({ onlyUnder = null, listFn } = {}) =>
  closeProcesses({ select: selectGrok, name: "grok", onlyUnder, listFn, say });

// ───────────────────────── 指令 ─────────────────────────

function parseArgs(argv) {
  const opts = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (["--url", "--grok-home", "--only-under"].includes(a)) opts.values[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) opts.flags.add(a.slice(2));
    else throw new Error(`未知參數：${a}`);
  }
  return opts;
}

function writeAtomic(file, text) {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // Windows 沒有 POSIX 權限
  }
  renameSync(tmp, file);
}

const homeOf = (opts) => opts.values["grok-home"] ?? process.env.GROK_HOME ?? join(homedir(), ".grok");

async function health(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/webchat/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}（伺服器版本太舊，不支援 Grok 橋接？請先更新 WebChatMCP）` };
    const body = await res.json();
    return body?.ok === true
      ? { ok: true, version: body.version, models: body.models ?? [], contextWindow: body.contextWindow }
      : { ok: false, reason: "回應格式不符" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function install(opts) {
  const home = homeOf(opts);
  const url = (opts.values.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const file = join(home, "config.toml");

  const h = await health(url);
  if (!h.ok) {
    say(`連不上 WebChatMCP 的 Grok 橋接（${url}）：${h.reason}`);
    say("沒有修改任何設定。請先安裝並啟動：curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash（更新：加 -s -- update）");
    return 1;
  }
  say(`WebChatMCP ${h.version} 橋接可用。`);

  let models = h.models;
  if (opts.flags.has("refresh-models")) {
    say("正在向各服務擷取模型清單（每個服務約 10 秒）…");
    try {
      const res = await fetch(`${url}/webchat/refresh`, { method: "POST", signal: AbortSignal.timeout(300_000) });
      const body = await res.json();
      models = body.models;
      say(`已擷取：${body.count} 個模型；略過 ${body.failed?.length ?? 0} 個服務。`);
    } catch (err) {
      say(`模型清單擷取失敗，不會加入沒有模型的服務名稱：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = applyConfig(text, url, models, h.contextWindow ?? 128000);

  if (!opts.flags.has("no-close") && !(await closeGrok({ onlyUnder: opts.values["only-under"] ?? null }))) {
    say("沒有修改任何設定。");
    return 1;
  }
  if (existsSync(file) && !existsSync(join(home, BACKUP_FILE))) copyFileSync(file, join(home, BACKUP_FILE));
  writeAtomic(file, next);
  say(`已寫入 ${file}：加入 ${models.length} 個網頁模型。`);
  say("完成。請開啟 grok，用 /model 或 grok -m 找結尾為 (WEB) 的模型。");
  return 0;
}

export async function uninstall(opts) {
  const home = homeOf(opts);
  const file = join(home, "config.toml");

  if (!opts.flags.has("no-close") && !(await closeGrok({ onlyUnder: opts.values["only-under"] ?? null }))) {
    say("沒有修改任何設定。");
    return 1;
  }
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (isInstalled(text)) {
    writeAtomic(file, revertConfig(text));
    say(`已還原 ${file}。`);
  } else {
    say("config.toml 裡沒有橋接設定（沒有安裝，或已移除）。");
  }
  if (opts.flags.has("purge")) {
    rmSync(join(home, BACKUP_FILE), { force: true });
    say("已刪除備份檔。");
  } else if (existsSync(join(home, BACKUP_FILE))) {
    say(`保留安裝前的備份：${join(home, BACKUP_FILE)}（加 --purge 才刪除）`);
  }
  say("完成。");
  return 0;
}

if (process.argv[1]?.endsWith("grok-plugin.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const opts = parseArgs(rest);
    if (command === "install") process.exit(await install(opts));
    if (command === "uninstall") process.exit(await uninstall(opts));
    console.error("用法：grok-plugin.mjs install|uninstall [選項]");
    process.exit(2);
  } catch (err) {
    console.error(`[grok-webchat] 錯誤：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
