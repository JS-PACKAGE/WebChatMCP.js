#!/usr/bin/env bash
#
# Hermes Agent 外掛（模型提供商 webchat）— Linux / macOS 安裝腳本
#
# 用法：plugins/hermes/install.sh [--url URL] [--python PATH] [--force] [--refresh-models]
#   在 ${HERMES_HOME:-~/.hermes}/config.yaml 加入免金鑰的 providers.webchat。
#   WebChatMCP 必須先啟動；清單為空時自動擷取模型。--refresh-models 強制重新擷取。
#   不改目前的 model.provider。非本腳本安裝的同名設定預設拒絕覆蓋。
# 不需要 root。裝完請重啟 Hermes；舊版的本外掛 profile 與假金鑰會自動移除。
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { [ -x "$HOME/.webchatmcp/node/bin/node" ] && NODE="$HOME/.webchatmcp/node/bin/node"; } || true
if [ -z "$NODE" ]; then
  printf '[hermes-webchat] 錯誤：找不到 Node.js；請先安裝 WebChatMCP（script/install.sh）或 Node.js 22+\n' >&2
  exit 1
fi
case "${1:-}" in -h | --help) sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
exec "$NODE" "$DIR/hermes-plugin.mjs" install "$@"
