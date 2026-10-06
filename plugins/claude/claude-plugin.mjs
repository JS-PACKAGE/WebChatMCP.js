#!/usr/bin/env node
/**
 * WebChatMCP × Claude Code 外掛的安裝／反安裝核心（install.sh／install.ps1 等四支腳本都只是呼叫它）。
 *
 *   node claude-plugin.mjs install   [--url URL] [--claude-home DIR] [--no-close] [--refresh-models] [--force]
 *   node claude-plugin.mjs uninstall [--claude-home DIR] [--no-close] [--purge]
 *
 * install：確認 WebChatMCP 伺服器的橋接可用 → 關閉所有 Claude → 在 settings.json 寫入
 *          env.ANTHROPIC_BASE_URL（指向橋接）與 modelPicker（名稱結尾 (WEB) 的網頁模型）。
 * uninstall：關閉所有 Claude → 把 settings.json 還原。
 * 關不掉 Claude 時不動設定，提示使用者手動關閉後重跑。不讀、不寫任何憑證。
 */

import { copyFileSync, chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ancestorsOf, closeProcesses, exeOf } from "../lib/proc.mjs";

const STATE_FILE = "webchatmcp-claude.json";
const BACKUP_FILE = "settings.json.webchatmcp.bak";
const OWN_PREFIX = "webchat/";
const DEFAULT_URL = `http://127.0.0.1:${process.env.WEBCHATMCP_PORT ?? 8321}/claude`;
const DESCRIPTION = "經由 WebChatMCP 的網頁聊天（無痕）；工具由 Claude Code 在本機執行";

const say = (m) => console.log(`[claude-webchat] ${m}`);

// ───────────────────────── settings.json 編輯（純函式，供測試） ─────────────────────────

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 寫入橋接設定。models: [{ id, name }]。
 * state 記下原本的值（originalBaseUrl、createdEnv、createdModelPicker），反安裝時還原。
 * 回傳新的 { settings, state }（不修改傳入的物件）。
 */
export function applySettings(settings, url, models, previous = null) {
  const next = structuredClone(settings);
  const state = previous ? structuredClone(previous) : { originalBaseUrl: null, createdEnv: false, createdModelPicker: false };

  if (!isObject(next.env)) {
    if (next.env !== undefined) throw new Error("settings.json 的 env 不是物件，無法安全修改");
    next.env = {};
    state.createdEnv = true;
  }
  const current = next.env.ANTHROPIC_BASE_URL;
  if (!previous && typeof current === "string" && current !== "") state.originalBaseUrl = current;
  next.env.ANTHROPIC_BASE_URL = url;

  if (!isObject(next.modelPicker)) {
    if (next.modelPicker !== undefined) throw new Error("settings.json 的 modelPicker 不是物件，無法安全修改");
    next.modelPicker = { options: [] };
    if (!previous) state.createdModelPicker = true;
  }
  const options = Array.isArray(next.modelPicker.options) ? next.modelPicker.options : [];
  const foreign = options.filter((o) => !(isObject(o) && typeof o.model === "string" && o.model.startsWith(OWN_PREFIX)));
  next.modelPicker.options = [
    ...foreign,
    ...models.map((m) => ({ model: m.id, label: m.name, description: DESCRIPTION })),
  ];
  return { settings: next, state };
}

export function revertSettings(settings, state) {
  const next = structuredClone(settings);
  if (isObject(next.env)) {
    if (state.originalBaseUrl) next.env.ANTHROPIC_BASE_URL = state.originalBaseUrl;
    else delete next.env.ANTHROPIC_BASE_URL;
    if (state.createdEnv && Object.keys(next.env).length === 0) delete next.env;
  }
  if (isObject(next.modelPicker) && Array.isArray(next.modelPicker.options)) {
    next.modelPicker.options = next.modelPicker.options.filter(
      (o) => !(isObject(o) && typeof o.model === "string" && o.model.startsWith(OWN_PREFIX)),
    );
    if (state.createdModelPicker && next.modelPicker.options.length === 0 && Object.keys(next.modelPicker).length === 1) {
      delete next.modelPicker;
    }
  }
  return next;
}

export function isInstalled(settings, url = null) {
  const base = settings?.env?.ANTHROPIC_BASE_URL;
  return typeof base === "string" && (url ? base === url : /\/claude\/?$/.test(base));
}

/** 沿用檔案原本的縮排（預設 2 空白），結尾一律換行。 */
export function serialize(settings, originalText) {
  const m = originalText?.match(/^([ \t]+)"/m);
  return `${JSON.stringify(settings, null, m ? m[1] : 2)}\n`;
}

// ───────────────────────── 關閉 Claude ─────────────────────────

/**
 * 從行程列表挑出 Claude：可執行檔名為 claude（Claude Code CLI）、經 node 啟動的 @anthropic-ai/claude-code，
 * 以及桌面 App（Claude Helper 輔助行程的父行程）。排除自己與祖先（從 Claude 裡面執行腳本會把自己關掉）。
 */
export function selectClaude(rows, selfPid, onlyUnder = null) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const inScope = (r) => !onlyUnder || exeOf(r).startsWith(onlyUnder);
  const targets = new Map();
  for (const r of rows) {
    if (!inScope(r)) continue;
    const exe = exeOf(r);
    const isCli = /(^|[\\/])claude(\.exe)?(\s|$)/.test(exe) || /[\\/]@anthropic-ai[\\/]claude-code[\\/]/.test(r.args);
    const isHelper = /Claude Helper( \((Renderer|GPU|Plugin)\))?/.test(exe);
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

export const closeClaude = ({ onlyUnder = null, listFn } = {}) =>
  closeProcesses({ select: selectClaude, name: "Claude", appBundleId: "com.anthropic.claudefordesktop", onlyUnder, listFn, say });

// ───────────────────────── 指令 ─────────────────────────

function parseArgs(argv) {
  const opts = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (["--url", "--claude-home", "--only-under"].includes(a)) opts.values[a.slice(2)] = argv[++i];
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

const homeOf = (opts) => opts.values["claude-home"] ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

function readState(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
}

function readSettings(file) {
  if (!existsSync(file)) return { text: "", settings: {} };
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return { text, settings: {} };
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} 不是合法的 JSON（${err.message}）；請先修好再安裝，沒有修改任何設定`);
  }
  if (!isObject(settings)) throw new Error(`${file} 的內容不是物件，沒有修改任何設定`);
  return { text, settings };
}

async function health(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/webchat/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}（伺服器版本太舊，不支援 Claude 橋接？請先更新 WebChatMCP）` };
    const body = await res.json();
    return body?.ok === true ? { ok: true, version: body.version, models: body.models ?? [] } : { ok: false, reason: "回應格式不符" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function install(opts) {
  const home = homeOf(opts);
  const url = (opts.values.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const file = join(home, "settings.json");

  const h = await health(url);
  if (!h.ok) {
    say(`連不上 WebChatMCP 的 Claude 橋接（${url}）：${h.reason}`);
    say("Claude Code 的 ANTHROPIC_BASE_URL 會指向它，伺服器沒開 Claude 就連不上；所以沒有修改任何設定。");
    say("請先安裝並啟動：curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash（更新：加 -s -- update）");
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

  const { text, settings } = readSettings(file);
  const previous = readState(home);
  const existing = settings?.env?.ANTHROPIC_BASE_URL;
  if (typeof existing === "string" && existing !== "" && !isInstalled(settings) && !opts.flags.has("force")) {
    say(`settings.json 已設定 ANTHROPIC_BASE_URL = ${existing}（不是本外掛設的）。`);
    say("官方模型的請求會改走 WebChatMCP 並轉送到 api.anthropic.com，原本的閘道就不會被使用。確認後加 --force 取代（反安裝會還原）。");
    return 1;
  }
  if (process.env.ANTHROPIC_BASE_URL) say("注意：目前的環境變數 ANTHROPIC_BASE_URL 已設定，它的優先序高於 settings.json，Claude 會繼續使用它。");

  if (!opts.flags.has("no-close") && !(await closeClaude({ onlyUnder: opts.values["only-under"] ?? null }))) {
    say("沒有修改任何設定。");
    return 1;
  }

  const applied = applySettings(settings, url, models, previous);
  if (existsSync(file) && !existsSync(join(home, BACKUP_FILE))) copyFileSync(file, join(home, BACKUP_FILE));
  writeAtomic(file, serialize(applied.settings, text));
  writeAtomic(join(home, STATE_FILE), `${JSON.stringify({ ...applied.state, url, installedAt: new Date().toISOString() }, null, 2)}\n`);
  say(`已寫入 ${file}：env.ANTHROPIC_BASE_URL = ${url}，modelPicker 加入 ${models.length} 個模型。`);
  if (applied.state.originalBaseUrl) say(`原本的 ANTHROPIC_BASE_URL（${applied.state.originalBaseUrl}）已記下，反安裝時還原。`);
  say("完成。請開啟 Claude Code，用 /model 找結尾為 (WEB) 的模型。");
  return 0;
}

export async function uninstall(opts) {
  const home = homeOf(opts);
  const file = join(home, "settings.json");

  if (!opts.flags.has("no-close") && !(await closeClaude({ onlyUnder: opts.values["only-under"] ?? null }))) {
    say("沒有修改任何設定。");
    return 1;
  }
  const { text, settings } = readSettings(file);
  const state = readState(home);
  if (state && isInstalled(settings)) {
    writeAtomic(file, serialize(revertSettings(settings, state), text));
    say(`已還原 ${file}。`);
  } else if (isInstalled(settings)) {
    say("找不到安裝紀錄，為避免誤改你的設定，沒有動 settings.json；請手動移除 env.ANTHROPIC_BASE_URL 與 modelPicker 裡 webchat/ 開頭的項目。");
    return 1;
  } else {
    say("settings.json 裡沒有橋接設定（沒有安裝，或已移除）。");
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

if (process.argv[1]?.endsWith("claude-plugin.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const opts = parseArgs(rest);
    if (command === "install") process.exit(await install(opts));
    if (command === "uninstall") process.exit(await uninstall(opts));
    console.error("用法：claude-plugin.mjs install|uninstall [選項]");
    process.exit(2);
  } catch (err) {
    console.error(`[claude-webchat] 錯誤：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
