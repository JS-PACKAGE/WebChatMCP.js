# 外掛（plugins/）

外掛用一個 **JSON 檔**新增其他聊天服務，載入後它會和 ChatGPT／Claude／Grok／Gemini 一樣出現在所有工具的 `provider` 選項裡
（`webchat_login`、`webchat_logout`、`webchat_ask`、`webchat_models`、`webchat_status`）。

外掛**只是資料**（網址與 DOM 選擇器），不含程式碼，不會被執行。

## 放在哪裡

| 位置 | 說明 |
|---|---|
| `plugins/*.json`（本目錄） | 隨倉庫提供；檔名以 `_` 開頭的（如 `_template.json`）是範本，**不會載入** |
| `~/.webchatmcp/plugins/*.json` | 使用者自己的外掛；`WEBCHATMCP_PLUGINS_DIR` 可改（多個目錄以系統路徑分隔符號分開） |

啟動時載入，改完要**重啟 MCP 伺服器**。格式錯誤的外掛只會被略過，原因寫在 stderr 日誌（`plugin skipped: …`），不影響其他服務。

## 欄位

| 欄位 | 必填 | 說明 |
|---|---|---|
| `id` | ✔ | 代號，`^[a-z][a-z0-9-]{1,30}$`；不可與內建服務或其他外掛重複 |
| `label` | ✔ | 顯示名稱 |
| `baseUrl` | ✔ | 登入與探測登入狀態用的首頁，必須是 `https` |
| `askUrl` | | 每次 `webchat_ask` 開啟的網址，能直接進無痕就帶上參數；預設同 `baseUrl` |
| `privateMode` | | `"url"`（預設，`askUrl` 已是無痕）或 `"button"`（載入後點 `selectors.privateEnter`） |
| `guest` | | 未登入也能取得回覆；預設 `false` |
| `domains` | | `webchat_logout` 清除 cookie 的網域；預設只有 `baseUrl` 的主機。每個網域必須是 `baseUrl` 主機本身或其上層網域（至少兩段） |
| `loginUrlPattern` | | 停在此網址即視為未登入（正規表達式字串） |
| `selectors.composer` | ✔ | 輸入框 |
| `selectors.sendButton` | ✔ | 送出按鈕（找不到時改按 Enter） |
| `selectors.assistantMessage` | ✔ | 助理回覆節點（取最後一個；其中 `.markdown`／`.prose` 優先） |
| `selectors.loginButton` | ✔ | 可見時代表未登入（訪客）的登入按鈕或連結 |
| `selectors.modelSwitcher` | ✔ | 開啟模型選單的按鈕；選單中的模型須是 `role="menuitemradio"` |
| `selectors.stopButton` | | 生成中的停止按鈕；有預設值 |
| `selectors.privateEnter` | | 進入無痕的按鈕（`privateMode` 為 `"button"` 時必填） |
| `selectors.privateActive` | | 無痕啟用中的畫面元素 |
| `selectors.dismiss` | | 會擋住畫面的升級／提示對話框的「略過」按鈕（只放「暫時不要」「我知道了」這類，不要放會代使用者同意的按鈕） |
| `selectors.blocking` | | 需要使用者本人處理的對話框（例如年齡確認）；出現時回報錯誤，不代填 |
| `privateIndicators` | | 畫面上出現任一文字即判定為無痕 |
| `loggedOutIndicators` | | 畫面上出現任一文字即判定為未登入 |
| `thinkingMenuItem` | | 模型選單裡「思考深度」子選單項的文字（正規表達式字串） |
| `moreModelsMenuItem` | | 「更多模型」子選單項的文字（正規表達式字串） |

不認得的欄位會被拒絕（避免拼錯欄位名卻沒人發現）。完整範例見 [`_template.json`](_template.json)。

## 寫一個外掛

1. 複製 `_template.json` 成 `plugins/<id>.json`（或放到 `~/.webchatmcp/plugins/`），改掉 `_` 開頭的檔名。
2. 用瀏覽器開發者工具找出各選擇器；可先用 `WEBCHATMCP_HEADLESS=0` 看實際畫面。
3. 重啟伺服器，呼叫 `webchat_login`（`provider` 填你的 `id`）→ `webchat_models` → `webchat_ask` 驗證。

## 其他種類的外掛

外掛統一放在本目錄下。除了上面的 `*.json`（新增聊天服務），還有：

| 位置 | 說明 |
|---|---|
| [`omp/`](omp/README.md) | **Oh My Pi 擴充**：讓 omp 把 WebChatMCP 當成模型提供商 `webchat`；附 `install`／`uninstall` 的 `.sh` 與 `.ps1` |
| [`pi/`](pi/README.md) | **Pi 擴充**：讓 pi 把 WebChatMCP 當成模型提供商 `webchat`；附 `install`／`uninstall` 的 `.sh` 與 `.ps1` |
| [`codex/`](codex/README.md) | **Codex 外掛**：Codex 的模型選單多出名稱結尾為 `(WEB)` 的網頁模型（程式碼外掛：`bridge.js` 由伺服器載入）；附 `install`／`uninstall` 的 `.sh` 與 `.ps1`，會先關閉所有 Codex |
| [`claude/`](claude/README.md) | **Claude 外掛**：Claude Code 的 `/model` 選單多出名稱結尾為 `(WEB)` 的網頁模型（程式碼外掛：`bridge.js` 由伺服器載入）；附 `install`／`uninstall` 的 `.sh` 與 `.ps1`，會先關閉所有 Claude |
| [`grok/`](grok/README.md) | **Grok 外掛**：Grok Build（`grok` CLI）的模型選單多出名稱結尾為 `(WEB)` 的網頁模型（程式碼外掛：`bridge.js` 由伺服器載入）；附 `install`／`uninstall` 的 `.sh` 與 `.ps1`，會先關閉所有 grok |
| [`hermes/`](hermes/README.md) | **Hermes 外掛**：Hermes Agent 的模型提供商 `webchat`（程式碼外掛：`bridge.js` 由伺服器載入）；附 `install`／`uninstall` 的 `.sh` 與 `.ps1`，寫入假的 `WEBCHAT_API_KEY` |
| [`lib/`](lib/) | 程式碼外掛共用的模組（橋接的 HTTP 轉送、關閉行程），不是外掛 |

伺服器只讀本目錄第一層的 `*.json`，子目錄（如 `omp/`）不會被當成聊天服務外掛載入。

## 規範：每個外掛都要有安裝與反安裝腳本

需要裝進其他程式的外掛放在 `plugins/<名稱>/`，必備 `install.sh`、`uninstall.sh`（Linux／macOS）與 `install.ps1`、`uninstall.ps1`（Windows，UTF-8 with BOM）四支，並附 README.md。詳細要求見專案根目錄 `AGENTS.md` §2：

- 不需要 root／系統管理員；安裝可重跑，遇到非本腳本裝的同名目標預設拒絕覆蓋（`--force`／`-Force` 才取代）。
- 以安裝標記辨識「本腳本裝的」，反安裝只移除這些；預設保留使用者資料，`--purge`／`-Purge` 才刪快取與設定。
- 純資料的 `*.json` 外掛由伺服器自動載入，不需要安裝步驟。


## 安全

- 外掛決定瀏覽器會連去哪個網站、點哪些元素，**只安裝你信任的外掛**；外掛不能執行任何腳本。
- `webchat_logout` 只會清除外掛宣告且屬於 `baseUrl` 網域的 cookie。
