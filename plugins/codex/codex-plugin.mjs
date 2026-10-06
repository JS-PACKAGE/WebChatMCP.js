#!/usr/bin/env node
/**
 * WebChatMCP × Codex 外掛的安裝／反安裝核心（install.sh／install.ps1 等四支腳本都只是呼叫它）。
 *
 *   node codex-plugin.mjs install   [--url URL] [--codex-home DIR] [--no-close] [--refresh-models]
 *   node codex-plugin.mjs uninstall [--codex-home DIR] [--no-close] [--purge]
 *
 * install：確認 WebChatMCP 伺服器的橋接可用 → 關閉所有 Codex → 把 openai_base_url 指向橋接。
 * uninstall：關閉所有 Codex → 還原 config.toml。
 * 關不掉 Codex 時不動 config.toml，提示使用者手動關閉後重跑。不讀、不寫任何憑證。
 */

import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ancestorsOf, closeProcesses, exeOf } from "../lib/proc.mjs";

const BEGIN = "# >>> webchatmcp-codex (managed by plugins/codex; remove with its uninstall script) >>>";
const END = "# <<< webchatmcp-codex <<<";
const STATE_FILE = "webchatmcp-codex.json";
const BACKUP_FILE = "config.toml.webchatmcp.bak";
const DEFAULT_URL = `http://127.0.0.1:${process.env.WEBCHATMCP_PORT ?? 8321}/v1`;

const say = (m) => console.log(`[codex-webchat] ${m}`);

// ───────────────────────── config.toml 編輯（純函式，供測試） ─────────────────────────

const TABLE_HEADER = /^\s*\[/;
const BASE_URL_LINE = /^\s*openai_base_url\s*=/;

/** 回傳 { text, original }：移除舊的橋接區塊與外來的 openai_base_url（original 記下被取代的那一行），並插入新區塊。 */
export function applyConfig(text, url, previousOriginal = null) {
  const stripped = removeBlock(text);
  const lines = stripped.split("\n");
  const firstTable = lines.findIndex((l) => TABLE_HEADER.test(l));
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  let original = previousOriginal;
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i < topEnd && BASE_URL_LINE.test(lines[i])) {
      original ??= lines[i];
      continue;
    }
    kept.push(lines[i]);
  }
  const insertAt = kept.findIndex((l) => TABLE_HEADER.test(l));
  const at = insertAt < 0 ? kept.length : insertAt;
  const block = [BEGIN, `openai_base_url = ${JSON.stringify(url)}`, END, ""];
  // 在第一個表格之前，與前面的內容隔一行。
  const head = kept.slice(0, at);
  while (head.length > 0 && head[head.length - 1].trim() === "") head.pop();
  const rest = kept.slice(at);
  const out = [...head, ...(head.length > 0 ? [""] : []), ...block, ...(rest.length > 0 ? rest : [])];
  return { text: out.join("\n").replace(/\n*$/, "\n"), original };
}

export function removeBlock(text) {
  const lines = text.split("\n");
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === BEGIN) inside = true;
    else if (inside && line.trim() === END) inside = false;
    else if (!inside) out.push(line);
  }
  return out.join("\n");
}

/** 還原：移除區塊；若記下了原本的 openai_base_url 就放回頂層。 */
export function revertConfig(text, original) {
  let out = removeBlock(text);
  if (original) {
    const lines = out.split("\n");
    const firstTable = lines.findIndex((l) => TABLE_HEADER.test(l));
    const at = firstTable < 0 ? lines.length : firstTable;
    const head = lines.slice(0, at);
    while (head.length > 0 && head[head.length - 1].trim() === "") head.pop();
    out = [...head, original, "", ...lines.slice(at)].join("\n");
  }
  return out.replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
}

export function isInstalled(text) {
  return text.split("\n").some((l) => l.trim() === BEGIN);
}

// ───────────────────────── 關閉 Codex ─────────────────────────

/**
 * 從行程列表挑出 Codex：可執行檔名為 codex（CLI、app-server、exec-server），
 * 經 node 啟動的 @openai/codex，以及 macOS 桌面 App（Codex 的 Renderer／Service 輔助行程的父行程）。
 * 排除自己與祖先（回報 blockedBy：從 Codex 裡面執行腳本會把自己關掉）。
 */
export function selectCodex(rows, selfPid, onlyUnder = null) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const inScope = (r) => !onlyUnder || exeOf(r).startsWith(onlyUnder);
  const targets = new Map();
  for (const r of rows) {
    if (!inScope(r)) continue;
    const exe = exeOf(r);
    const isCli = /(^|[\\/])codex(\.exe)?(\s|$)/.test(exe) || /[\\/]Codex\.exe(\s|$)/.test(exe) || /[\\/]@openai[\\/]codex[\\/]/.test(r.args);
    const isHelper = /Codex \((Renderer|Service|GPU|Plugin)\)|Codex Helper/.test(exe);
    if (isCli) targets.set(r.pid, { ...r, kind: "cli" });
    if (isHelper) {
      const host = byPid.get(r.ppid);
      if (host && !targets.has(host.pid)) targets.set(host.pid, { ...host, kind: "app" });
    }
  }
  const ancestors = ancestorsOf(rows, selfPid);
  const blockedBy = [...targets.values()].filter((t) => ancestors.has(t.pid));
  const list = [...targets.values()].filter((t) => t.pid !== selfPid && !ancestors.has(t.pid));
  return { list, blockedBy };
}

/** 關閉所有 Codex。成功回 true；失敗印出清單並回 false。 */
export const closeCodex = ({ onlyUnder = null, listFn } = {}) =>
  closeProcesses({ select: selectCodex, name: "Codex", appBundleId: "com.openai.codex", onlyUnder, listFn, say });

// ───────────────────────── 指令 ─────────────────────────

function parseArgs(argv) {
  const opts = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (["--url", "--codex-home", "--only-under"].includes(a)) opts.values[a.slice(2)] = argv[++i];
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

function readState(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
  } catch {
    return {};
  }
}

async function health(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/webchat/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}（伺服器版本太舊，不支援 Codex 橋接？請先更新 WebChatMCP）` };
    const body = await res.json();
    return body?.ok === true ? { ok: true, version: body.version } : { ok: false, reason: "回應格式不符" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function install(opts) {
  const home = opts.values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const url = (opts.values.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const file = join(home, "config.toml");

  const h = await health(url);
  if (!h.ok) {
    say(`連不上 WebChatMCP 的 Codex 橋接（${url}）：${h.reason}`);
    say("Codex 的 openai_base_url 會指向它，伺服器沒開 Codex 就連不上；所以沒有修改任何設定。");
    say("請先安裝並啟動：curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash（更新：加 -s -- update）");
    return 1;
  }
  say(`WebChatMCP ${h.version} 橋接可用。`);

  if (!opts.flags.has("no-close") && !(await closeCodex({ onlyUnder: opts.values["only-under"] ?? null }))) {
    say("沒有修改任何設定。");
    return 1;
  }

  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!existsSync(join(home, BACKUP_FILE)) && existsSync(file)) copyFileSync(file, join(home, BACKUP_FILE));
  const { text: next, original } = applyConfig(text, url, readState(home).original ?? null);
  writeAtomic(file, next);
  writeAtomic(join(home, STATE_FILE), JSON.stringify({ original, url, installedAt: new Date().toISOString() }, null, 2) + "\n");
  say(`已寫入 ${file}：openai_base_url = ${url}`);
  if (original) say(`原本的設定已記下，反安裝時會還原：${original.trim()}`);

  if (opts.flags.has("refresh-models")) {
    say("正在向各服務擷取模型清單（會逐一切換模型讀思考深度，每個服務可能要數分鐘）…");
    try {
      const res = await fetch(`${url}/webchat/refresh`, { method: "POST", signal: AbortSignal.timeout(1_800_000) });
      const body = await res.json();
      say(`已更新模型清單：${body.count} 個；略過 ${body.failed?.length ?? 0} 個服務。`);
    } catch (err) {
      say(`模型清單更新失敗（可稍後重跑 --refresh-models）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  say("完成。請開啟 Codex，在模型選單找結尾為 (WEB) 的模型。");
  return 0;
}

export async function uninstall(opts) {
  const home = opts.values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const file = join(home, "config.toml");

  if (!opts.flags.has("no-close") && !(await closeCodex({ onlyUnder: opts.values["only-under"] ?? null }))) {
    say("沒有修改任何設定。");
    return 1;
  }
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (isInstalled(text)) {
    writeAtomic(file, revertConfig(text, readState(home).original ?? null));
    say(`已還原 ${file}。`);
  } else {
    say("config.toml 裡沒有橋接設定（沒有安裝，或已移除）。");
  }
  rmSync(join(home, STATE_FILE), { force: true });
  if (opts.flags.has("purge")) {
    rmSync(join(home, BACKUP_FILE), { force: true });
    say("已刪除備份檔。");
  } else if (existsSync(join(home, BACKUP_FILE))) {
    say(`保留安裝前的備份：${join(home, BACKUP_FILE)}（加 --purge 才刪除）`);
  }
  say("完成。");
  return 0;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href || process.argv[1]?.endsWith("codex-plugin.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const opts = parseArgs(rest);
    if (command === "install") process.exit(await install(opts));
    if (command === "uninstall") process.exit(await uninstall(opts));
    console.error("用法：codex-plugin.mjs install|uninstall [選項]");
    process.exit(2);
  } catch (err) {
    console.error(`[codex-webchat] 錯誤：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
