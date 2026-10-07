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
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER } from "./config.js";
/**
 * 每個回應都要求關閉連線。Node 內建 fetch（Node 26.7 的 undici 8.9）重用閒置的 keep-alive 連線時，
 * 會把請求延到一個 unref 的 setImmediate 驗證連線；用戶端事件迴圈沒有其他工作時，unref 的 immediate
 * 不會讓 libuv 跳過 poll 等待，要等下一個計時器（多半是 undici 約 0.5 秒一次的低精度計時）才送出。
 * 實測每次延後約 0.1–0.5 秒、偶爾數秒；本機每次重新連線只要約 1–5ms。
 * MCP SDK 的 SSE 回應會在 writeHead 帶 Connection: keep-alive，所以統一在這裡改寫。
 */
function closeAfterResponse(res) {
    res.setHeader("Connection", "close");
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
        const headers = args[args.length - 1];
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
            args[args.length - 1] = Object.fromEntries(Object.entries(headers).filter(([name]) => !/^(connection|keep-alive)$/i.test(name)));
        }
        return writeHead.apply(this, args);
    };
}
export async function startHttpServer(buildServer, log, bridges = []) {
    const port = SERVER.httpPort;
    const host = SERVER.httpHost;
    if (!port) {
        log("HTTP transport disabled (port=0)");
        return {
            info: { enabled: false, host, port: 0, path: SERVER.httpPath, url: null },
            close: async () => { },
        };
    }
    const sessions = new Map();
    const readBody = (req) => new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
            size += c.length;
            chunks.push(c);
        });
        req.on("end", () => {
            if (chunks.length === 0)
                return resolve(undefined);
            try {
                const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
                resolve(JSON.parse(body.toString("utf8")));
            }
            catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
    const handler = async (req, res) => {
        closeAfterResponse(res);
        // CORS：允許瀏覽器型 MCP 用戶端跨來源連線（本機工具，寬鬆無妨）
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version");
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
        const url = new URL(req.url ?? "/", `http://${host}:${port}`);
        const bridge = bridges.find((b) => url.pathname === b.path || url.pathname.startsWith(`${b.path}/`));
        if (bridge) {
            try {
                await bridge.handle(req, res, url);
            }
            catch (err) {
                log(`bridge error: ${err instanceof Error ? err.message : String(err)}`);
                if (!res.headersSent)
                    res.writeHead(500).end(JSON.stringify({ error: "internal error" }));
                else
                    res.destroy();
            }
            return;
        }
        if (url.pathname !== SERVER.httpPath) {
            res.writeHead(404).end("Not Found");
            return;
        }
        if (req.method === "OPTIONS") {
            res.writeHead(204).end();
            return;
        }
        try {
            const sessionIdHeader = req.headers["mcp-session-id"];
            const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
            if (sessionId && sessions.has(sessionId)) {
                const entry = sessions.get(sessionId);
                await entry.transport.handleRequest(req, res, await readBody(req));
                return;
            }
            if (req.method !== "POST" || sessionId) {
                // 已結束／未知的 session
                res.writeHead(404).end(JSON.stringify({ error: "unknown session" }));
                return;
            }
            // 新 session：建立專屬 transport＋server
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                    sessions.set(id, entry);
                    log(`HTTP session opened: ${id.slice(0, 8)}…`);
                },
            });
            const server = buildServer();
            const entry = { transport, server };
            transport.onclose = () => {
                const id = transport.sessionId;
                if (id) {
                    sessions.delete(id);
                    log(`HTTP session closed: ${id.slice(0, 8)}…`);
                }
            };
            await server.connect(transport);
            await transport.handleRequest(req, res, await readBody(req));
        }
        catch (err) {
            log(`HTTP error: ${err instanceof Error ? err.message : String(err)}`);
            if (!res.headersSent) {
                res.writeHead(500).end(JSON.stringify({ error: "internal error" }));
            }
        }
    };
    const httpServer = createServer((req, res) => {
        void handler(req, res);
    });
    // Codex 會先嘗試 WebSocket；一律拒絕，它就改用 HTTPS（SSE）。
    httpServer.on("upgrade", (_req, socket) => {
        socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    await new Promise((resolve) => {
        httpServer.once("error", (err) => {
            // port 被佔用／無權限時不殺掉程序：stdio 繼續服務
            const code = err.code;
            log(`HTTP transport unavailable (${code ?? String(err)}); continuing with stdio only`);
            resolve();
        });
        httpServer.listen(port, host, () => {
            resolve();
        });
    });
    if (!httpServer.listening) {
        return {
            info: { enabled: false, host, port, path: SERVER.httpPath, url: null },
            close: async () => { },
        };
    }
    const info = {
        enabled: true,
        host,
        port,
        path: SERVER.httpPath,
        url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}${SERVER.httpPath}`,
    };
    log(`HTTP transport listening on ${info.url}`);
    return {
        info,
        close: () => new Promise((resolve) => {
            for (const [, entry] of sessions) {
                void entry.transport.close().catch(() => { });
            }
            sessions.clear();
            httpServer.close(() => resolve());
        }),
    };
}
