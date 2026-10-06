/**
 * WebChatMCP.js — Streamable HTTP transport。
 *
 * 在設定的 port 開啟 MCP endpoint（預設 http://127.0.0.1:8321/mcp），
 * 讓 MCP 客戶端以一般 HTTP 直接連線，不必透過 stdio 啟動程序。
 * 每個 MCP session 有自己的 McpServer 實例，共用同一個 ChatGPTSession。
 *
 * 安全：預設只綁 loopback 且無任何認證——對外開放（0.0.0.0）等同讓
 * 同網路任何人操作你的 ChatGPT 會話，須自行承擔。
 */
import { type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export type BridgeHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
/** 外掛橋接（plugins/codex、plugins/claude）：path 是路徑前綴，底下的請求都交給 handle。 */
export interface Bridge {
    path: string;
    handle: BridgeHandler;
}
export interface HttpServerInfo {
    enabled: boolean;
    host: string;
    port: number;
    path: string;
    url: string | null;
}
export declare function startHttpServer(buildServer: () => McpServer, log: (message: string) => void, bridges?: Bridge[]): Promise<{
    info: HttpServerInfo;
    close: () => Promise<void>;
}>;
