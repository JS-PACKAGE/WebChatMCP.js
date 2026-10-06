#!/usr/bin/env bash
#
# Codex 外掛（模型名稱結尾為 (WEB) 的網頁模型）— Linux / macOS 反安裝腳本
#
# 用法：plugins/codex/uninstall.sh [--purge] [--no-close]
#   會先關閉所有執行中的 Codex（CLI 與桌面 App；先請它們結束、不行才強制）；關不掉就不動設定並提示你手動關閉。
#   不需要 root。核心邏輯在 codex-plugin.mjs，需要 Node.js（PATH 裡的 node，或 WebChatMCP 腳本裝的 ~/.webchatmcp/node）。
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { [ -x "$HOME/.webchatmcp/node/bin/node" ] && NODE="$HOME/.webchatmcp/node/bin/node"; } || true
if [ -z "$NODE" ]; then
  printf '[codex-webchat] 錯誤：找不到 Node.js；請先安裝 WebChatMCP（script/install.sh）或 Node.js 22+\n' >&2
  exit 1
fi
case "${1:-}" in -h | --help) sed -n '3,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
exec "$NODE" "$DIR/codex-plugin.mjs" uninstall "$@"
