/**
 * WebChatMCP.js — 外掛載入：以 JSON 檔新增其他聊天服務。
 *
 * 外掛只是資料（網址與 DOM 選擇器），不含程式碼，不會被執行；格式與欄位說明見 plugins/README.md。
 * 載入來源：倉庫的 plugins/（檔名以 _ 開頭的範本略過）與使用者目錄 ~/.webchatmcp/plugins
 * （WEBCHATMCP_PLUGINS_DIR 可改）。單一外掛格式錯誤只會被略過並回報原因，不影響其他服務。
 */
import { type ProviderConfig } from "./config.js";
export interface PluginReport {
    loaded: {
        id: string;
        file: string;
    }[];
    skipped: {
        file: string;
        reason: string;
    }[];
}
/** 驗證並轉成 ProviderConfig；格式錯誤丟出 Error（訊息即略過原因）。 */
export declare function parsePlugin(raw: unknown): {
    id: string;
    config: ProviderConfig;
};
/** 外掛目錄清單：倉庫內建目錄＋使用者目錄。 */
export declare function pluginDirs(): string[];
/** 載入所有外掛並註冊到 PROVIDERS；單一外掛失敗只記錄原因，不中斷。 */
export declare function loadPlugins(dirs?: string[]): PluginReport;
