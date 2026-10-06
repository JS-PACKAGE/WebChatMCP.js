#!/usr/bin/env bash
#
# WebChatMCP.js — Linux / macOS 反安裝：先停掉執行中的服務，再移除背景服務註冊。
#
# 用法：script/uninstall.sh [--purge] [--purge-profile]
#   （無參數）        只移除服務註冊；程式碼、登入 profile 與設定檔保留
#   --purge           另外刪除 Node.js、日誌與設定檔
#   --purge-profile   另外刪除瀏覽器 profile（所有登入狀態，無法復原）
#
# 與 WEBCHATMCP_HOME／WEBCHATMCP_SERVICE_NAME 的用法同 install.sh；實作在 install.sh 的 uninstall 動作。
set -eu
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/install.sh" uninstall "$@"
