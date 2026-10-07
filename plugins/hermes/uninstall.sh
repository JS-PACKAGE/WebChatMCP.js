#!/usr/bin/env bash
#
# Hermes Agent 外掛 — Linux / macOS 反安裝腳本
#
# 用法：plugins/hermes/uninstall.sh [--python PATH] [--purge]
#   只移除本腳本安裝的 providers.webchat 與舊 profile／假金鑰區塊，其餘設定不動。
#   --purge 另外刪除模型快取。預設保留模型快取與登入 profile。
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { [ -x "$HOME/.webchatmcp/node/bin/node" ] && NODE="$HOME/.webchatmcp/node/bin/node"; } || true
if [ -z "$NODE" ]; then
  printf '[hermes-webchat] 錯誤：找不到 Node.js\n' >&2
  exit 1
fi
case "${1:-}" in -h | --help) sed -n '3,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
exec "$NODE" "$DIR/hermes-plugin.mjs" uninstall "$@"
