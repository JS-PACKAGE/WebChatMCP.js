#!/usr/bin/env bash
#
# WebChatMCP.js — Linux / macOS 安裝、背景執行與更新腳本
#
# 用法（在倉庫內執行）：
#   script/install.sh [install]      安裝：補齊 Node.js、相依套件、內建瀏覽器，建置並註冊背景服務後啟動
#   script/install.sh update [--force]  更新：先關掉執行中的服務，拉取最新程式、重新建置，再把服務啟動回來
#   script/install.sh start|stop|restart|status|logs
#   script/install.sh uninstall [--purge] [--purge-profile]
#
# 背景服務：macOS＝launchd LaunchAgent；Linux＝systemd --user（不可用時退回 nohup）。
# 服務以 HTTP 提供 MCP（預設 http://127.0.0.1:8321/mcp）；環境變數寫在 ~/.webchatmcp/<服務名>.env。
# 不需要 root；Node.js 不夠新時只下載到 ~/.webchatmcp/node（驗證 SHA-256），不動系統。
#
# 可用環境變數：WEBCHATMCP_HOME（資料目錄，預設 ~/.webchatmcp）、WEBCHATMCP_SERVICE_NAME（服務名，預設 webchatmcp）。

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
NAME="${WEBCHATMCP_SERVICE_NAME:-webchatmcp}"
DATA="${WEBCHATMCP_HOME:-$HOME/.webchatmcp}"
LOG_DIR="$DATA/logs"
LOG_FILE="$LOG_DIR/$NAME.log"
ENV_FILE="$DATA/$NAME.env"
LAUNCHER="$DATA/$NAME-run.sh"
NODE_HOME="$DATA/node"
PID_FILE="$DATA/$NAME.pid"
MIN_NODE_MAJOR=22
OS="$(uname -s)"
USER_ID="$(id -u)"
LABEL="com.$NAME"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="$HOME/.config/systemd/user/$NAME.service"
FORCE=0
PURGE=0
PURGE_PROFILE=0
NODE_BIN=""

say() { printf '[%s] %s\n' "$NAME" "$*"; }
warn() { printf '[%s] 注意：%s\n' "$NAME" "$*" >&2; }
die() { printf '[%s] 錯誤：%s\n' "$NAME" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# 單引號跳脫，供產生 shell 腳本時安全嵌入路徑。
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# ───────────────────────── Node.js ─────────────────────────

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

find_node() {
  if [ -x "$NODE_HOME/bin/node" ] && [ "$(node_major "$NODE_HOME/bin/node")" -ge "$MIN_NODE_MAJOR" ]; then
    NODE_BIN="$NODE_HOME/bin/node"
    return 0
  fi
  if have node && [ "$(node_major "$(command -v node)")" -ge "$MIN_NODE_MAJOR" ]; then
    NODE_BIN="$(command -v node)"
    return 0
  fi
  return 1
}

fetch() {
  if have curl; then curl -fsSL "$1"; elif have wget; then wget -qO- "$1"; else die "需要 curl 或 wget"; fi
}

fetch_to() {
  if have curl; then curl -fsSL -o "$2" "$1"; elif have wget; then wget -qO "$2" "$1"; else die "需要 curl 或 wget"; fi
}

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

install_node_locally() {
  local platform arch base sums line want file tmp got
  case "$OS" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *) die "不支援的系統：${OS}（Windows 請用 script/install.ps1）" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) die "不支援的 CPU 架構：$(uname -m)" ;;
  esac
  base="https://nodejs.org/dist/latest-v$MIN_NODE_MAJOR.x"
  say "找不到 Node.js ≥ ${MIN_NODE_MAJOR}，下載官方版本到 ${NODE_HOME}"
  sums="$(fetch "$base/SHASUMS256.txt")"
  line="$(printf '%s\n' "$sums" | grep -E "  node-v[0-9.]+-$platform-$arch\.tar\.gz$" | head -n1 || true)"
  [ -n "$line" ] || die "SHASUMS256.txt 找不到 $platform-$arch 的套件"
  want="${line%% *}"
  file="${line##* }"
  tmp="$(mktemp -d)"
  fetch_to "$base/$file" "$tmp/$file"
  got="$(sha256_of "$tmp/$file")"
  if [ "$got" != "$want" ]; then
    rm -rf "$tmp"
    die "Node.js 套件 SHA-256 不符（預期 ${want}，實際 ${got}）"
  fi
  rm -rf "$NODE_HOME"
  mkdir -p "$NODE_HOME"
  tar -xzf "$tmp/$file" -C "$NODE_HOME" --strip-components=1
  rm -rf "$tmp"
}

ensure_node() {
  find_node || { install_node_locally; find_node || die "Node.js 安裝失敗"; }
  PATH="$(dirname "$NODE_BIN"):$PATH"
  export PATH
  say "使用 Node.js $("$NODE_BIN" -v)（${NODE_BIN}）"
}

# ───────────────────────── 建置 ─────────────────────────

browser_works() {
  (cd "$ROOT" && "$NODE_BIN" --input-type=module -e \
    "import { chromium } from 'playwright'; const b = await chromium.launch(); await b.close();" >/dev/null 2>&1)
}

build_app() {
  cd "$ROOT"
  say "安裝相依套件（npm ci；依 package-lock.json 安裝，不會改動它）"
  npm ci --no-fund --no-audit
  say "安裝內建瀏覽器（Playwright Chromium）"
  npx playwright install chromium
  say "建置（npm run build）"
  npm run build
  if ! browser_works; then
    if [ "$OS" = Linux ] && [ "$USER_ID" = 0 ]; then
      say "瀏覽器缺系統函式庫，安裝中（playwright install-deps）"
      npx playwright install-deps chromium
    fi
    browser_works || warn "內建瀏覽器無法啟動。Linux 請以 root 執行：npx playwright install-deps chromium（在 ${ROOT}）"
  fi
}

# ───────────────────────── 設定與服務檔 ─────────────────────────

service_port() {
  local port=""
  if [ -f "$ENV_FILE" ]; then
    port="$(grep -E '^WEBCHATMCP_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d "\"' " || true)"
  fi
  printf '%s' "${port:-${WEBCHATMCP_PORT:-8321}}"
}

write_env_template() {
  [ -f "$ENV_FILE" ] && return 0
  mkdir -p "$DATA"
  cat >"$ENV_FILE" <<'EOF'
# WebChatMCP.js 背景服務的環境變數（KEY=VALUE，每行一個；改完執行 script/install.sh restart）
# WEBCHATMCP_PORT=8321
# WEBCHATMCP_HOST=127.0.0.1        # 0.0.0.0 會開放區網，HTTP 無認證，慎用
# WEBCHATMCP_PROFILE_DIR=~/.webchatmcp/profile
# WEBCHATMCP_CHANNEL=chromium      # chromium / chrome / msedge
# WEBCHATMCP_HEADLESS=1            # 設 0 一律顯示瀏覽器視窗
# WEBCHATMCP_ANSWER_TIMEOUT_MS=120000
EOF
}

write_launcher() {
  mkdir -p "$DATA" "$LOG_DIR"
  {
    printf '#!/bin/sh\n'
    printf '# 由 script/install.sh 產生；重新安裝或更新時會覆寫。\n'
    printf 'cd %s || exit 1\n' "$(sq "$ROOT")"
    printf 'set -a\n'
    printf '[ -f %s ] && . %s\n' "$(sq "$ENV_FILE")" "$(sq "$ENV_FILE")"
    printf 'set +a\n'
    printf 'PATH=%s:"$PATH"\nexport PATH\n' "$(sq "$(dirname "$NODE_BIN")")"
    printf 'exec %s %s\n' "$(sq "$NODE_BIN")" "$(sq "$ROOT/dist/WebChatMCP.js")"
  } >"$LAUNCHER"
  chmod 755 "$LAUNCHER"
}

backend() {
  if [ "$OS" = Darwin ]; then
    echo launchd
  elif have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    echo systemd
  else
    echo nohup
  fi
}

write_service() {
  write_env_template
  write_launcher
  case "$(backend)" in
    launchd)
      mkdir -p "$(dirname "$PLIST")"
      cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml "$LABEL")</string>
  <key>ProgramArguments</key>
  <array><string>$(xml "$LAUNCHER")</string></array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$LOG_FILE")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG_FILE")</string>
</dict>
</plist>
EOF
      ;;
    systemd)
      mkdir -p "$(dirname "$UNIT")"
      cat >"$UNIT" <<EOF
[Unit]
Description=WebChatMCP.js (MCP server with a built-in browser)
After=network-online.target

[Service]
Type=simple
ExecStart="$LAUNCHER"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable "$NAME.service" >/dev/null 2>&1 || warn "systemctl --user enable 失敗，開機自動啟動可能無效"
      loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "無法啟用 linger：登出後服務會停止（可執行 sudo loginctl enable-linger ${USER}）"
      ;;
    nohup)
      warn "沒有可用的 launchd／systemd --user，改用 nohup：不會開機自動啟動，也不會自動重啟。"
      ;;
  esac
}

service_installed() {
  case "$(backend)" in
    launchd) [ -f "$PLIST" ] ;;
    systemd) [ -f "$UNIT" ] ;;
    nohup) [ -f "$LAUNCHER" ] ;;
  esac
}

# ───────────────────────── 啟動／停止 ─────────────────────────

nohup_pid() { [ -f "$PID_FILE" ] && cat "$PID_FILE" || true; }

service_running() {
  case "$(backend)" in
    launchd) launchctl print "gui/$USER_ID/$LABEL" 2>/dev/null | grep -q 'state = running' ;;
    systemd) systemctl --user is-active --quiet "$NAME.service" ;;
    nohup)
      local pid
      pid="$(nohup_pid)"
      [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
      ;;
  esac
}

service_start() {
  service_installed || die "尚未安裝服務，請先執行 script/install.sh install"
  if service_running; then
    say "服務已在執行"
    return 0
  fi
  mkdir -p "$LOG_DIR"
  case "$(backend)" in
    launchd)
      launchctl bootout "gui/$USER_ID/$LABEL" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$USER_ID" "$PLIST"
      launchctl kickstart "gui/$USER_ID/$LABEL" >/dev/null 2>&1 || true
      ;;
    systemd) systemctl --user start "$NAME.service" ;;
    nohup)
      if have setsid; then
        setsid nohup "$LAUNCHER" >>"$LOG_FILE" 2>&1 </dev/null &
      else
        nohup "$LAUNCHER" >>"$LOG_FILE" 2>&1 </dev/null &
      fi
      echo $! >"$PID_FILE"
      ;;
  esac
  say "服務已啟動（HTTP http://127.0.0.1:$(service_port)/mcp）"
}

# 停掉由背景服務管理的行程。
service_stop_managed() {
  service_installed || return 0
  case "$(backend)" in
    launchd) launchctl bootout "gui/$USER_ID/$LABEL" >/dev/null 2>&1 || true ;;
    systemd) systemctl --user stop "$NAME.service" >/dev/null 2>&1 || true ;;
    nohup)
      local pid
      pid="$(nohup_pid)"
      [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
      rm -f "$PID_FILE"
      ;;
  esac
}

# 結束殘留的 WebChatMCP.js 行程（含 MCP 用戶端以 stdio 啟動的實例），先 TERM、逾時再 KILL。
kill_strays() {
  local pids i
  pids="$(pgrep -f "$ROOT/dist/WebChatMCP.js" 2>/dev/null || true)"
  [ -n "$pids" ] || return 0
  say "結束執行中的 WebChatMCP.js 行程：$(echo $pids)"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for i in $(seq 1 20); do
    pids="$(pgrep -f "$ROOT/dist/WebChatMCP.js" 2>/dev/null || true)"
    [ -n "$pids" ] || return 0
    sleep 0.5
  done
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}

stop_all() {
  service_stop_managed
  kill_strays
}

# ───────────────────────── 指令 ─────────────────────────

# 等 HTTP 端點開始回應（任何 HTTP 狀態碼都代表服務已起來），最多約 20 秒。
wait_http() {
  have curl || return 0
  local i code
  for i in $(seq 1 40); do
    code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$(service_port)/mcp" 2>/dev/null || true)"
    [ -n "$code" ] && [ "$code" != 000 ] && return 0
    sleep 0.5
  done
  warn "等不到 HTTP 端點回應，請查看日誌：$0 logs"
}

cmd_install() {
  ensure_node
  build_app
  write_service
  service_start
  wait_http
  cmd_status
  cat <<EOF

MCP 用戶端請連 HTTP：http://127.0.0.1:$(service_port)/mcp
（背景服務與 stdio 實例共用同一個瀏覽器 profile，建議只用其中一種連線方式。）
登入請呼叫 webchat_login；更新請執行：$SCRIPT_DIR/install.sh update
EOF
}

cmd_update() {
  have git || die "更新需要 git"
  [ -d "$ROOT/.git" ] || die "$ROOT 不是 git 倉庫，無法更新（請用 git clone 取得原始碼）"
  cd "$ROOT"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    die "有未提交的修改，更新會覆蓋它們；請先 commit 或 stash"
  fi
  git fetch --quiet origin
  local upstream before after
  upstream="$(git rev-parse '@{u}' 2>/dev/null)" || die "目前分支沒有追蹤的遠端分支"
  before="$(git rev-parse HEAD)"
  if git merge-base --is-ancestor "$upstream" HEAD && [ "$FORCE" != 1 ]; then
    say "已是最新版本（$(git rev-parse --short HEAD)）；要強制重新建置請加 --force"
    return 0
  fi

  say "有新版本，先關閉執行中的服務"
  stop_all
  git pull --ff-only --quiet || die "git pull --ff-only 失敗（本地與遠端分岔？），服務保持關閉，請手動處理後執行 start"
  after="$(git rev-parse HEAD)"
  ensure_node
  build_app
  if service_installed; then
    write_service
    service_start
  fi
  say "更新完成：$(git rev-parse --short "$before") → $(git rev-parse --short "$after")（$(node -p 'require("./package.json").version')）"
}

cmd_status() {
  local code=""
  say "背景方式：$(backend)；已安裝：$(service_installed && echo 是 || echo 否)；執行中：$(service_running && echo 是 || echo 否)"
  if have curl; then
    code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$(service_port)/mcp" 2>/dev/null || true)"
    say "HTTP http://127.0.0.1:$(service_port)/mcp 回應碼：${code:-無回應}"
  fi
  say "設定檔：${ENV_FILE}；日誌：${LOG_FILE}"
}

cmd_logs() {
  case "$(backend)" in
    systemd) exec journalctl --user -u "$NAME.service" -n 50 -f ;;
    *) [ -f "$LOG_FILE" ] || die "還沒有日誌：$LOG_FILE"; exec tail -n 50 -f "$LOG_FILE" ;;
  esac
}

cmd_uninstall() {
  stop_all
  case "$(backend)" in
    systemd)
      systemctl --user disable "$NAME.service" >/dev/null 2>&1 || true
      rm -f "$UNIT"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      ;;
    launchd) rm -f "$PLIST" ;;
  esac
  rm -f "$PID_FILE" "$LAUNCHER"
  say "已移除背景服務（程式碼、登入 profile 與設定檔保留）"
  if [ "$PURGE" = 1 ]; then
    rm -rf "$NODE_HOME" "$LOG_DIR" "$ENV_FILE"
    say "已刪除 Node.js、日誌與設定檔"
  fi
  if [ "$PURGE_PROFILE" = 1 ]; then
    rm -rf "$DATA/profile"
    say "已刪除瀏覽器 profile（所有登入狀態）"
  fi
}

usage() {
  sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

ACTION="${1:-install}"
[ $# -gt 0 ] && shift
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --purge) PURGE=1 ;;
    --purge-profile) PURGE_PROFILE=1 ;;
    *) usage; die "未知參數：$arg" ;;
  esac
done

case "$ACTION" in
  install) cmd_install ;;
  update) cmd_update ;;
  start) find_node || die "找不到 Node.js，請先執行 install"; service_start ;;
  stop) stop_all; say "已停止" ;;
  restart) stop_all; find_node || die "找不到 Node.js，請先執行 install"; service_start ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  uninstall) cmd_uninstall ;;
  -h | --help | help) usage ;;
  *) usage; die "未知指令：$ACTION" ;;
esac
