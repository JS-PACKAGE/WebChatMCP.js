/** Hermes 的具名免金鑰 endpoint 安裝／反安裝；不修改目前選用的模型。 */
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const MARK = ".webchatmcp-installed";
const ROOT = dirname(fileURLToPath(import.meta.url));
const BEGIN = "# webchatmcp-hermes:begin";
const END = "# webchatmcp-hermes:end";
const DEFAULT_URL = "http://127.0.0.1:8321/hermes/v1";

export function hermesHome(env = process.env) {
  return env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
}

// Only remove the legacy installer's marked block, never user-authored key lines.
export function revertEnv(text) {
  return text.replace(new RegExp(`^${BEGIN}\\r?\\n[\\s\\S]*?^${END}(?:\\r?\\n|$)`, "m"), "");
}

function legacyOurs(dest) {
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink()) return resolve(dirname(dest), readlinkSync(dest)) === resolve(ROOT, "webchat");
    return existsSync(join(dest, MARK));
  } catch {
    return false;
  }
}

function removeLegacy(home, force = false) {
  const dest = join(home, "plugins", "model-providers", "webchat");
  if (legacyOurs(dest) || force) rmSync(dest, { recursive: true, force: true });
  const envFile = join(home, ".env");
  if (existsSync(envFile)) {
    const before = readFileSync(envFile, "utf8");
    const after = revertEnv(before);
    if (after !== before) writeFileSync(envFile, after);
  }
}

function editConfig(home, action, { python, force = false, url, models } = {}) {
  // Use Hermes's existing YAML dependency; no package installation or Hermes launcher side effects.
  const candidates = python ? [python] : [
    join(home, "hermes-agent", "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    join(homedir(), ".hermes", "hermes-agent", "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    "python3", "python",
  ];
  for (const executable of candidates) {
    const check = spawnSync(executable, ["-c", "import ruamel.yaml"], { stdio: "ignore" });
    if (check.status !== 0) continue;
    const result = spawnSync(executable, [join(ROOT, "hermes-config.py")], {
      input: JSON.stringify({ home, action, owner: ROOT, force, url, models }), encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr?.trim() || "無法更新 Hermes config.yaml");
    return JSON.parse(result.stdout);
  }
  throw new Error("找不到 Hermes 的 Python（需要既有的 ruamel.yaml）；請用 --python 指定 Hermes Python 執行檔");
}

async function getJson(url, { method = "GET", timeout = 4000 } = {}) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`WebChatMCP 橋接回報 HTTP ${res.status}`);
  return res.json();
}

export async function installPlugin({ home, force = false, python, url = process.env.WEBCHAT_BASE_URL || DEFAULT_URL, refreshModels = false }) {
  const legacy = join(home, "plugins", "model-providers", "webchat");
  let legacyExists = false;
  try { lstatSync(legacy); legacyExists = true; } catch (err) { if (err.code !== "ENOENT") throw err; }
  if (legacyExists && !legacyOurs(legacy) && !force) {
    throw new Error(`${legacy} 已存在而且不是本腳本安裝的；確認後加 --force 取代`);
  }
  url = url.replace(/\/+$/, "");
  const health = await getJson(`${url}/webchat/health`);
  if (health.ok !== true) throw new Error("WebChatMCP 伺服器不支援 Hermes 橋接；沒有修改設定");
  let catalog = await getJson(`${url}/models`);
  if (refreshModels || !catalog.data?.length) {
    say("正在擷取網頁模型清單…");
    const refreshed = await getJson(`${url}/webchat/refresh`, { method: "POST", timeout: 300_000 });
    catalog = await getJson(`${url}/models`);
    if (refreshed.failed?.length) say(`略過 ${refreshed.failed.length} 個無法讀取的服務；請確認該服務的登入狀態。`);
  }
  const models = [...new Set((catalog.data ?? []).map((m) => m.id).filter((id) => typeof id === "string" && id.includes("/")))];
  if (!models.length) throw new Error("沒有可用的網頁模型；請先確認 WebChatMCP 的登入／訪客狀態，再重跑安裝。沒有修改設定");
  const result = editConfig(home, "install", { python, force, url, models });
  removeLegacy(home, force);
  return { ...result, count: models.length };
}

export function uninstallPlugin({ home, python, purge = false }) {
  const result = editConfig(home, "uninstall", { python });
  removeLegacy(home);
  if (purge) {
    const cache = process.env.WEBCHATMCP_HERMES_MODELS || join(homedir(), ".webchatmcp", "hermes-models.json");
    rmSync(cache === "~" || cache.startsWith("~/") ? join(homedir(), cache.slice(1)) : cache, { force: true });
  }
  return result;
}

function say(msg) {
  process.stderr.write(`[hermes-webchat] ${msg}\n`);
}

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--url", "--python"].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${arg} 缺少值`);
      opts[arg.slice(2)] = args[++i];
    } else if (arg === "--force" || arg === "-Force") opts.force = true;
    else if (arg === "--purge" || arg === "-Purge") opts.purge = true;
    else if (arg === "--refresh-models") opts.refreshModels = true;
    else throw new Error(`未知參數：${arg}`);
  }
  return opts;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "install" || cmd === "uninstall") {
  try {
    const opts = { home: hermesHome(), ...parseArgs(args) };
    if (cmd === "install") {
      const { configFile, count } = await installPlugin(opts);
      say(`已安裝免金鑰提供商 webchat：${configFile}（${count} 個模型）`);
      say("請重啟 Hermes，在 /model 或 hermes model 選 WebChat (WebChatMCP)，不需要輸入 API_KEY。");
      say("沒有改目前的 model.provider；也可用 hermes --provider webchat -m '<服務>/<模型標籤>'。");
    } else {
      const { removed } = uninstallPlugin(opts);
      say(removed ? "已移除本腳本安裝的 webchat 提供商。" : "沒有本腳本安裝的提供商；使用者設定保留不動。");
    }
  } catch (err) {
    say(`錯誤：${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
