#!/usr/bin/env bash
#
# Hermes Agent 外掛 — Linux / macOS 反安裝腳本
#
# 用法：plugins/hermes/uninstall.sh [--purge]
#   移除本腳本裝的 provider 目錄，並清掉 .env 裡的假金鑰區塊。不是本腳本裝的一律不動。
#   --purge 另外刪除模型快取（~/.webchatmcp/hermes-models.json）。不改 config.yaml，也不動登入 profile。
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
