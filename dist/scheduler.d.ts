import type { AskResult } from "./session.js";
interface AskOptions {
    model?: string;
    thinking?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}
interface PrewarmTarget {
    provider: string;
    model?: string;
    thinking?: string;
}
interface SchedulerSession {
    readonly browserRunning: boolean;
    readonly isHeadless: boolean;
    launch(): Promise<void>;
    close(): Promise<void>;
    ask(provider: string, prompt: string, options: AskOptions): Promise<AskResult>;
    prewarm(provider: string, options: {
        model?: string;
        thinking?: string;
        signal?: AbortSignal;
    }): Promise<boolean>;
}
/** 正式操作與預載共用互斥鎖；相容的提問等待預載完成，其餘操作取消預載。 */
export declare function createScheduler(session: SchedulerSession, log: (message: string) => void): {
    withBrowserLock: <T>(fn: () => Promise<T>, reusePrewarm?: (target: PrewarmTarget) => boolean) => Promise<T>;
    runAsk: (provider: string, prompt: string, options: AskOptions) => Promise<{
        answer: string;
        prefix: string;
        notes: string[];
    }>;
    runWarmup: (provider: string, model?: string) => Promise<boolean>;
};
export {};
