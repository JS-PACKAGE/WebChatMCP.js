# Hermes Agent 外掛：`webchat` 模型提供商

讓 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 把 WebChatMCP 當成模型提供商，名稱是 `webchat`。
安裝時擷取模型清單，再選 `chatgpt/<模型標籤>`、`claude/<模型標籤>`、`grok/<模型標籤>`、`gemini/<模型標籤>`（如 `gemini/3.5 Flash-Lite`），提示就會送進該服務的無痕聊天。沒有模型標籤的服務名稱不會進清單。

> 這是 Hermes 的具名本機 endpoint 整合，不再使用 `api_key` model-provider profile。和 `plugins/*.json`（新增聊天服務的資料外掛）無關。

## 免金鑰

安裝器在 `HERMES_HOME/config.yaml` 的 `providers.webchat` 寫入橋接 URL 與實際模型清單，**不寫 `api_key`、`key_env` 或 `api_key_env`**。Hermes 直接使用本機免金鑰 endpoint；它的 SDK 佔位字串不是 API 金鑰，橋接不讀取、不記錄、不轉送憑證標頭。

重新安裝會移除本外掛舊版的 `plugins/model-providers/webchat`（只限本倉庫連結或有安裝標記的目錄）與 `.env` 中有標記的假金鑰區塊。使用者自建的金鑰、其他提供商與目前選用的模型不動。

## 安裝

需要 Node.js 22+、支援具名 `providers:` endpoint 的 Hermes，以及 Hermes Python 既有的 `ruamel.yaml`。不需要 root。**WebChatMCP 伺服器必須先啟動**；預設更新 `${HERMES_HOME:-~/.hermes}/config.yaml`，**不改**目前的 `model.provider`。安裝標記另存於 `.webchatmcp-hermes-installed`。

```bash
plugins/hermes/install.sh
plugins/hermes/uninstall.sh            # 反安裝；--purge 另刪模型快取
```

```powershell
powershell -ExecutionPolicy Bypass -File plugins\hermes\install.ps1
powershell -ExecutionPolicy Bypass -File plugins\hermes\uninstall.ps1      # -Purge 另刪模型快取
```

裝完請重啟 Hermes，在 `/model` 或 `hermes model` 選 **WebChat (WebChatMCP)**，不需要輸入 API_KEY。也可以直接指定模型：

```bash
hermes --provider webchat -m "gemini/3.5 Flash-Lite"
```

安裝會先讀 `GET /hermes/v1/models`，空清單自動 `POST /hermes/v1/webchat/refresh`。部分服務讀取失敗時，只列可用的實際模型；全部失敗則不改 Hermes 設定，不填假的模型名稱。

安裝選項（PowerShell 對應參數）：

- `--url URL`（`-Url URL`）：橋接位址，預設 `http://127.0.0.1:8321/hermes/v1`。安裝時可用 `WEBCHAT_BASE_URL`；之後改位址須重跑安裝。
- `--python PATH`（`-Python PATH`）：Hermes 的 Python 執行檔；自動尋找不到時使用。反安裝也支援。
- `--refresh-models`（`-RefreshModels`）：強制重新擷取模型；一般重跑安裝會同步目前橋接清單。
- `--force`（`-Force`）：明確取代非本腳本安裝的同名設定，預設拒絕覆蓋。

反安裝只移除帶本腳本安裝標記、且橋接 URL 未被替換的 `providers.webchat` 與舊版自建的 profile／假金鑰區塊。預設保留模型快取、使用者設定與登入 profile；`--purge`／`-Purge` 另刪模型快取，登入 profile 不動。

## 限制

- **支援本機工具往返**：Hermes 將問題、系統規則與可用工具送到網頁模型；模型提出工具要求，橋接驗證 JSON 信封後轉成 Hermes 原生工具呼叫。Hermes 依自己的權限與確認機制執行，再把結果送回模型，直到完成；一般文字不會被當成指令執行。
- **每輪都是全新的無痕聊天**：重送任務、系統提示、完整對話、先前工具呼叫與結果，不裁切內容。
- **工具資料會送到所選網頁聊天平台**：包含工具讀出的檔案內容與指令結果；不要提供不願交給該平台的機密。
- 沒有圖片、沒有逐字串流（整段回覆一次到齊後才發送文字或工具事件）。可回傳多個要求，但不保證平行執行；網站可靠度、登入狀態與格式遵循能力會影響工具往返。無效信封回報錯誤，不執行。
- WebChatMCP 伺服器要先在跑。Claude、Grok 必須已登入。
