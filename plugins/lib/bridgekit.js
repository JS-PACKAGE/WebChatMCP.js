/**
 * WebChatMCP.js — 外掛橋接（plugins/codex、plugins/claude）共用的 HTTP 輔助：讀取／解碼請求本文、
 * 原樣轉送到上游並串流回應、JSON 回應、請求中止。
 *
 * 紀律：轉送只搬運標頭與本文，不讀取、不記錄、不儲存任何憑證內容。
 */

                                                                 
import { Readable } from "node:stream";
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);
const zstdDecompress = zlib.zstdDecompress ? promisify(zlib.zstdDecompress) : null;

export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function readRaw(req                 )                  {
  const { promise, resolve, reject } = Promise.withResolvers        ();
  const chunks           = [];
  let size = 0;
  req.on("data", (c        ) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      reject(new Error("request body too large"));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size)));
  req.on("error", reject);
  return promise;
}

                                          

/** 依 Content-Encoding 解開請求本文；不支援的編碼（或 Node 太舊沒有 zstd）回 null。 */
export async function decodeBody(raw        , encoding                    )                {
  const enc = (encoding ?? "identity").trim().toLowerCase();
  if (enc === "" || enc === "identity") return raw;
  if (enc === "gzip") return gunzip(raw);
  if (enc === "deflate") return inflate(raw);
  if (enc === "br") return brotliDecompress(raw);
  if (enc === "zstd") return zstdDecompress ? zstdDecompress(raw) : null;
  return null;
}

export function sendJson(res                , status        , payload         )       {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** 用戶端中斷連線（尚未寫完回應）時中止。 */
export function abortOnClose(req                 , res                )                  {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  req.on("aborted", () => controller.abort());
  return controller;
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "expect",
  "accept-encoding",
]);

/** 原樣轉送到 `${base}${rest}${url.search}`（請求標頭除逐跳標頭外全部帶上）。 */
export async function fetchUpstream(
  req                 ,
  url     ,
  base        ,
  rest        ,
  raw                    ,
  signal             ,
  dropConditional = false,
)                    {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (dropConditional && (name === "if-none-match" || name === "if-modified-since")) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("accept-encoding", "identity");
  const hasBody = raw !== undefined && raw.length > 0 && req.method !== "GET" && req.method !== "HEAD";
  return fetch(`${base}${rest}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? raw : undefined,
    signal,
    redirect: "manual",
  });
}

/** 把上游回應（狀態、標頭、串流本文）交給用戶端；fetch 已解壓，所以不帶 content-encoding／content-length。 */
export async function pipeUpstream(upstream          , res                )                {
  const headers                         = {};
  upstream.headers.forEach((value, name) => {
    if (["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(name)) return;
    headers[name] = value;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  const { promise, resolve } = Promise.withResolvers      ();
  const body = Readable.fromWeb(upstream.body         );
  body.on("error", () => {
    res.destroy();
    resolve();
  });
  res.on("close", () => {
    body.destroy();
    resolve();
  });
  body.on("end", resolve);
  body.pipe(res);
  return promise;
}
