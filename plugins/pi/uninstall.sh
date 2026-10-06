#!/usr/bin/env bash
#
# Pi 外掛（webchat 模型提供商）— Linux / macOS 反安裝腳本
#
# 用法：plugins/pi/uninstall.sh [--purge]
#   移除 install.sh 裝進 pi 擴充目錄的外掛（符號連結，或帶有安裝標記的複製）；不是本腳本裝的一律不動。
#   --purge 另外刪除 /webchat-refresh 產生的模型快取（~/.pi/agent/webchat-models.json）。
#   不會動 WebChatMCP 伺服器與其登入 profile。移除後請重啟 pi。
set -eu

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/webchat" && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXT_DIR="${PI_EXTENSIONS_DIR:-$AGENT_DIR/extensions}"
DEST="$EXT_DIR/webchat"
MARK=".webchatmcp-installed"
CACHE="${WEBCHATMCP_PI_CACHE:-$AGENT_DIR/webchat-models.json}"
PURGE=0

say() { printf '[pi-webchat] %s\n' "$*"; }
die() { printf '[pi-webchat] 錯誤：%s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h | --help) sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知參數：$arg" ;;
  esac
done

if [ -L "$DEST" ]; then
  if [ "$(cd "$DEST" 2>/dev/null && pwd -P || true)" = "$SRC" ]; then
    rm "$DEST"
    say "已移除連結：$DEST"
  else
    say "$DEST 是指向別處的連結，不是本腳本裝的，未動"
  fi
elif [ -f "$DEST/$MARK" ]; then
  rm -rf "$DEST"
  say "已移除複製的外掛：$DEST"
elif [ -e "$DEST" ]; then
  say "$DEST 不是本腳本裝的，未動"
else
  say "沒有安裝（找不到 ${DEST}）"
fi

if [ "$PURGE" = 1 ] && [ -f "$CACHE" ]; then
  rm -f "$CACHE"
  say "已刪除模型快取：$CACHE"
fi
say "請重啟 pi 讓變更生效"
