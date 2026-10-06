#!/usr/bin/env bash
#
# Oh My Pi 外掛（webchat 模型提供商）— Linux / macOS 安裝腳本
#
# 用法：plugins/omp/install.sh [--copy] [--force]
#   預設以符號連結安裝到 omp 的使用者擴充目錄（之後 git pull 就會跟著更新）；--copy 改為複製（Windows 風格、或倉庫會被移動時用）。
#   目標已存在且不是本腳本裝的，預設拒絕覆蓋；--force 才會取代。
#
# 目標：${OMP_EXTENSIONS_DIR:-${PI_CODING_AGENT_DIR:-~/.omp/agent}/extensions}/webchat
# 不需要 root。裝完請重啟 omp。反安裝：plugins/omp/uninstall.sh
set -eu

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/webchat" && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
EXT_DIR="${OMP_EXTENSIONS_DIR:-$AGENT_DIR/extensions}"
DEST="$EXT_DIR/webchat"
MARK=".webchatmcp-installed"
MODE=link
FORCE=0

say() { printf '[omp-webchat] %s\n' "$*"; }
die() { printf '[omp-webchat] 錯誤：%s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --copy) MODE=copy ;;
    --force) FORCE=1 ;;
    -h | --help) sed -n '3,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知參數：$arg" ;;
  esac
done

[ -f "$SRC/index.js" ] || die "找不到外掛原始檔：$SRC"

ours() {
  if [ -L "$DEST" ]; then
    [ "$(cd "$DEST" 2>/dev/null && pwd -P)" = "$SRC" ]
  else
    [ -f "$DEST/$MARK" ]
  fi
}

mkdir -p "$EXT_DIR"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  if ours || [ "$FORCE" = 1 ]; then
    rm -rf "$DEST"
  else
    die "$DEST 已存在而且不是本腳本安裝的；確認後加 --force 取代"
  fi
fi

if [ "$MODE" = link ]; then
  ln -s "$SRC" "$DEST"
else
  mkdir -p "$DEST"
  cp -R "$SRC/." "$DEST/"
  : >"$DEST/$MARK"
fi
say "已安裝（${MODE}）：$DEST"

command -v omp >/dev/null 2>&1 || say "注意：PATH 裡找不到 omp；外掛已就位，安裝 omp 後即可使用"
url="${WEBCHATMCP_URL:-http://127.0.0.1:8321/mcp}"
if command -v curl >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$url" 2>/dev/null || true)"
  if [ -z "$code" ] || [ "$code" = 000 ]; then
    say "注意：連不上 WebChatMCP 伺服器（${url}）。請先安裝並啟動：curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash"
  fi
fi
say "請重啟 omp，然後用 /webchat-login（省略＝四個服務都檢查）與 /webchat-refresh，再選 webchat/<服務>/<模型標籤>"
