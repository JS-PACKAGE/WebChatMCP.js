/**
 * WebChatMCP.js — 各服務的模型選單與思考深度擷取。
 *
 * 四個服務的選單結構各異（ChatGPT 的兩層視圖、Claude 的子選單、Gemini 的 gem-menu），
 * 這裡集中處理差異；網址與選擇器仍全部來自 config.ts。
 */
import type { ElementHandle, Page } from "playwright";
import { type ProviderId } from "./config.js";
export interface MenuEntry {
    label: string;
    current: boolean;
}
export interface MenuContents {
    models: MenuEntry[];
    /** 思考深度（沒有此概念的服務為空陣列） */
    thinking: MenuEntry[];
}
/** 找不到模型選單按鈕等 UI 變動徵兆 */
export declare class MenuError extends Error {
}
/** 開啟模型選單（找不到開關即回報 UI 變動徵兆）；回傳選單項目的取得函式。 */
export declare function openModelMenu(page: Page, provider: ProviderId): Promise<() => Promise<ElementHandle[]>>;
/** 開啟選單並讀取模型與思考深度，最後關閉選單。 */
export declare function readMenu(page: Page, provider: ProviderId): Promise<MenuContents>;
/** 開啟選單並點選標籤相符（完全相同或包含）的模型；比對不中回 null。 */
export declare function selectModelItem(page: Page, provider: ProviderId, wanted: string): Promise<string | null>;
