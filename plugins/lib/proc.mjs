/**
 * 外掛安裝／反安裝腳本共用：關閉某個程式的所有實例（先請它結束、不行才強制），關不掉就回報失敗。
 * 各外掛提供 select(rows, selfPid, onlyUnder) 決定哪些行程算「它的實例」。
 */

import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

/** 目前的行程列表：[{ pid, ppid, args }] */
export function listProcesses() {
  if (process.platform === "win32") {
    const ps =
      "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, ($(if ($_.CommandLine) { $_.CommandLine } else { $_.Name })) }";
    const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out
      .split(/\r?\n/)
      .map((l) => l.split("|"))
      .filter((p) => p.length >= 3)
      .map((p) => ({ pid: Number(p[0]), ppid: Number(p[1]), args: p.slice(2).join("|") }));
  }
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
}

/** 可執行檔路徑（args 第一段；路徑含空白時以「後面接 - 或 / 的空白」切開）。 */
export const exeOf = (row) => row.args.split(/\s+(?=-|\/|[a-z]:\\)/i)[0].trim();

/** 自己與所有祖先行程的 pid（從目標程式裡面執行腳本時，不能把它們關掉）。 */
export function ancestorsOf(rows, selfPid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out = new Set();
  for (let p = byPid.get(selfPid); p; p = byPid.get(p.ppid)) {
    out.add(p.pid);
    if (p.ppid === p.pid) break;
  }
  return out;
}

async function waitGone(pids, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pids.every((p) => !alive(p))) return true;
    await sleep(250);
  }
  return pids.every((p) => !alive(p));
}

function signal(pid, force) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore" });
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    // 已經結束
  }
}

/**
 * 關閉所有實例。成功回 true；失敗（關不掉，或腳本本身在目標程式裡面）印出說明並回 false。
 * @param {{ select: Function, name: string, appBundleId?: string, onlyUnder?: string|null, listFn?: Function, say: (m: string) => void }} o
 */
export async function closeProcesses({ select, name, appBundleId, onlyUnder = null, listFn = listProcesses, say }) {
  const { list, blockedBy } = select(listFn(), process.pid, onlyUnder);
  if (blockedBy.length > 0) {
    say(`這支腳本是從 ${name} 裡面啟動的，關閉 ${name} 會連腳本一起關掉。`);
    say(`請改在 ${name} 之外的終端機執行。`);
    return false;
  }
  if (list.length === 0) {
    say(`沒有執行中的 ${name}。`);
    return true;
  }
  say(`正在關閉 ${list.length} 個 ${name} 行程…`);
  const pids = list.map((t) => t.pid);
  if (process.platform === "darwin" && appBundleId && !onlyUnder && list.some((t) => t.kind === "app")) {
    spawnSync("osascript", ["-e", `tell application id "${appBundleId}" to quit`], { stdio: "ignore", timeout: 8000 });
  }
  for (const t of list) signal(t.pid, false);
  if (!(await waitGone(pids, 10_000))) {
    say("部分行程沒有回應，強制結束…");
    for (const p of pids.filter(alive)) signal(p, true);
    await waitGone(pids, 4_000);
  }
  const left = list.filter((t) => alive(t.pid));
  if (left.length > 0) {
    say(`無法自動關閉下列 ${name} 行程，請手動關閉後重新執行：`);
    for (const t of left) say(`  pid ${t.pid}  ${t.args.slice(0, 120)}`);
    return false;
  }
  say(`已關閉所有 ${name}。`);
  return true;
}
