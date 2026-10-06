/**
 * Hermes Agent 外掛安裝／反安裝。
 *
 * Hermes 把 api_key 且沒有 env_vars 的 profile 直接略過（之後就是 Unknown provider）。
 * 有 env_vars 但沒有可用金鑰時，明確指定的 provider 不會改走別家，也不會用 fallback_models
 * （那只是 /models 抓失敗時的選單後備）。所以這裡寫一組假的 WEBCHAT_API_KEY，橋接不驗證它。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DUMMY_KEY = "webchat-local";
export const MARK = ".webchatmcp-installed";
const BEGIN = "# webchatmcp-hermes:begin";
const END = "# webchatmcp-hermes:end";

export function pluginSrc(from = import.meta.url) {
  return join(dirname(fileURLToPath(from)), "webchat");
}

export function hermesHome(env = process.env) {
  return env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
}

export function applyEnv(text, key = DUMMY_KEY) {
  const block = `${BEGIN}\nWEBCHAT_API_KEY=${key}\n${END}\n`;
  const src = text ?? "";
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`);
  if (re.test(src)) return src.replace(re, block);
  const sep = src.length === 0 || src.endsWith("\n") ? "" : "\n";
  return `${src}${sep}${block}`;
}

export function revertEnv(text) {
  const stripped = (text ?? "").replace(new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`), "\n");
  return stripped.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
}

function ours(dest, src) {
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink()) return resolve(dirname(dest), readlinkSync(dest)) === resolve(src);
    return existsSync(join(dest, MARK));
  } catch {
    return false;
  }
}

export function installPlugin({ home, src = pluginSrc(), mode = "link", force = false }) {
  const dest = join(home, "plugins", "model-providers", "webchat");
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) || existsSync(join(dirname(dest), "webchat"))) {
    if (!ours(dest, src) && !force) {
      throw new Error(`${dest} 已存在而且不是本腳本安裝的；確認後加 --force 取代`);
    }
    rmSync(dest, { recursive: true, force: true });
  }
  if (mode === "link") symlinkSync(src, dest);
  else {
    mkdirSync(dest, { recursive: true });
    for (const name of ["__init__.py", "plugin.yaml"]) writeFileSync(join(dest, name), readFileSync(join(src, name)));
    writeFileSync(join(dest, MARK), "");
  }
  const envFile = join(home, ".env");
  const prev = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  writeFileSync(envFile, applyEnv(prev));
  return { dest, envFile };
}

export function uninstallPlugin({ home, src = pluginSrc(), purge = false }) {
  const dest = join(home, "plugins", "model-providers", "webchat");
  let removed = false;
  if (ours(dest, src)) {
    rmSync(dest, { recursive: true, force: true });
    removed = true;
  }
  const envFile = join(home, ".env");
  if (existsSync(envFile)) writeFileSync(envFile, revertEnv(readFileSync(envFile, "utf8")));
  if (purge) {
    const cache = process.env.WEBCHATMCP_HERMES_MODELS || join(homedir(), ".webchatmcp", "hermes-models.json");
    rmSync(cache.startsWith("~") ? join(homedir(), cache.slice(1)) : cache, { force: true });
  }
  return { dest, removed };
}

function say(msg) {
  process.stderr.write(`[hermes-webchat] ${msg}\n`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "install" || cmd === "uninstall") {
  const force = args.includes("--force") || args.includes("-Force");
  const copy = args.includes("--copy") || args.includes("-Copy");
  const purge = args.includes("--purge") || args.includes("-Purge");
  try {
    if (cmd === "install") {
      const { dest } = installPlugin({ home: hermesHome(), mode: copy ? "copy" : "link", force });
      say(`已安裝（${copy ? "複製" : "連結"}）：${dest}`);
      say(`已寫入假的 WEBCHAT_API_KEY（橋接不驗證）。請重啟 Hermes，先 POST /hermes/webchat/refresh，再用 hermes --provider webchat -m <服務>/<模型標籤>`);
      say("沒有改 model.provider；要當預設提供商再自己改 ~/.hermes/config.yaml。");
    } else {
      const { dest, removed } = uninstallPlugin({ home: hermesHome(), purge });
      say(removed ? `已移除：${dest}` : `${dest} 不是本腳本裝的，或本來就沒裝；假金鑰區塊已清掉`);
    }
  } catch (err) {
    say(`錯誤：${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
