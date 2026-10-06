#!/usr/bin/env node
/**
 * WebChatMCP.js — MCP Server 主程式。
 *
 * 連線方式（同時啟用）：
 * - stdio：供 MCP 用戶端以子程序方式啟動（stdout 專供 JSON-RPC）。
 * - Streamable HTTP：開啟設定的 port（預設 http://127.0.0.1:8321/mcp），
 *   供客戶端直接以 HTTP 連線；port 與監聽位址寫在 src/config.ts，可用環境變數覆蓋。
 *
 * 工具（皆可用 provider 參數選擇 chatgpt｜claude｜grok｜gemini，預設 chatgpt）：
 * - webchat_login  ：先查詢是否已登入；未登入才顯示瀏覽器讓使用者人工登入（登入狀態持久化）。
 * - webchat_logout ：清除該服務的登入 cookie（不需畫面）。
 * - webchat_ask    ：把提示文字送進無痕（臨時）聊天視窗，回傳回覆文字；ChatGPT、Gemini 未登入也能用。
 * - webchat_models ：列出帳號可用的模型與思考深度（即時擷取選單）。
 * - webchat_status ：回報瀏覽器、登入與 HTTP 連線狀態。
 * - webchat_close  ：關閉內建瀏覽器。
 *
 * 紀律：stdio 模式下 stdout 專供 JSON-RPC，日誌一律走 stderr；不讀寫任何密碼。
 */
export {};
