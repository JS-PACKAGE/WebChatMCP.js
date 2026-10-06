# Hermes Agent 外掛：`webchat` 模型提供商

讓 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 把 WebChatMCP 當成模型提供商，名稱是 `webchat`。
選 `chatgpt`、`claude`、`grok`、`gemini`（或 `gemini/3.5 Flash-Lite` 這類快取到的標籤），提示就會送進該服務的無痕聊天。

> 這是 Hermes 的 model-provider 外掛，位於 `plugins/hermes/webchat/`。和 `plugins/*.json`（新增聊天服務的資料外掛）無關。

## 為什麼不靠 fallback_models

Hermes 的 `fallback_models` **不是**金鑰失敗時的備援，只是 `GET /models` 抓不到時，選單要顯示的靜態清單。

另外兩條會讓它看起來像「沒跳 fallback」：

- `auth_type=api_key` 且沒有 `env_vars` 的 profile **根本不會註冊**，之後就是 `Unknown provider`。`fallback_models` 連被讀的機會都沒有。
- 你用 `--provider webchat` 明確指定時，沒有可用金鑰會直接 `No usable credentials`，**不會**改走別的提供商。

橋接本身不需要金鑰。安裝腳本因此在 `HERMES_HOME/.env` 寫一組假的 `WEBCHAT_API_KEY=webchat-local`，只為了通過 Hermes 的註冊與金鑰檢查。

## 安裝

需要 Node.js。不需要 root。預設裝到 `${HERMES_HOME:-~/.hermes}/plugins/model-providers/webchat`，**不改** `config.yaml` 的 `model.provider`。

```bash
plugins/hermes/install.sh
plugins/hermes/uninstall.sh            # 反安裝；--purge 另刪模型快取
```

```powershell
powershell -ExecutionPolicy Bypass -File plugins\hermes\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\hermes\uninstall.ps1
```

裝完請重啟 Hermes，然後：

```bash
hermes --provider webchat -m chatgpt
```

要當預設提供商，自己改 `~/.hermes/config.yaml` 的 `model.provider` 與 `model.default`。伺服器位址可用 `WEBCHAT_BASE_URL`（預設 `http://127.0.0.1:8321/hermes/v1`）。

更新模型標籤：`POST http://127.0.0.1:8321/hermes/webchat/refresh`。

## 限制

只有文字。沒有工具呼叫、沒有圖片、沒有逐字串流（整段回覆一次到齊）。WebChatMCP 伺服器要先在跑。Claude、Grok 必須已登入。
