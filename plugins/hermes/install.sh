#!/usr/bin/env bash
#
# Hermes Agent 外掛（模型提供商 webchat）— Linux / macOS 安裝腳本
#
# 用法：plugins/hermes/install.sh [--copy] [--force]
#   預設以符號連結安裝到 ${HERMES_HOME:-~/.hermes}/plugins/model-providers/webchat。
#   另外在 HERMES_HOME/.env 寫入假的 WEBCHAT_API_KEY（橋接不驗證；Hermes 沒有金鑰就不會註冊這個提供商）。
#   不改 config.yaml 的 model.provider。目標已存在且不是本腳本裝的，預設拒絕覆蓋。
# 不需要 root。裝完請重啟 Hermes。反安裝：plugins/hermes/uninstall.sh
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
