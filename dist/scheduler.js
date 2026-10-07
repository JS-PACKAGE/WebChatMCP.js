import { TIMEOUTS } from "./config.js";
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException(String(signal.reason ?? "aborted"), "AbortError");
}
/** 正式操作與預載共用互斥鎖；相容的提問等待預載完成，其餘操作取消預載。 */
export function createScheduler(session, log) {
    let opChain = Promise.resolve();
    let pendingOps = 0;
    let idleTimer = null;
    let prewarmAbort = null;
    let prewarmTarget = null;
    let prewarmTimer = null;
    function armIdleClose() {
        if (TIMEOUTS.idleCloseSeconds <= 0 || !session.browserRunning || !session.isHeadless)
            return;
        idleTimer = setTimeout(() => {
            idleTimer = null;
            void withBrowserLock(async () => {
                if (!session.browserRunning || !session.isHeadless)
                    return;
                await session.close();
                log(`browser closed after ${TIMEOUTS.idleCloseSeconds}s idle`);
            }).catch(() => { });
        }, TIMEOUTS.idleCloseSeconds * 1000);
        idleTimer.unref();
    }
    function settleOp() {
        pendingOps -= 1;
        if (pendingOps === 0)
            armIdleClose();
    }
    function withBrowserLock(fn, reusePrewarm) {
        if (prewarmTimer) {
            clearImmediate(prewarmTimer);
            prewarmTimer = null;
        }
        pendingOps += 1;
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
        if (prewarmAbort && (!prewarmTarget || !reusePrewarm?.(prewarmTarget)))
            prewarmAbort.abort();
        const run = opChain.then(fn, fn);
        opChain = run.then(settleOp, settleOp);
        return run;
    }
    /** 等目前操作釋放鎖後才排預載，避免在鎖內改寫 opChain 而遺失排程。 */
    function schedulePrewarm(target) {
        clearImmediate(prewarmTimer ?? undefined);
        prewarmTimer = setImmediate(() => {
            prewarmTimer = null;
            if (pendingOps > 0)
                return;
            const abort = new AbortController();
            void withBrowserLock(async () => {
                prewarmAbort = abort;
                prewarmTarget = target;
                try {
                    await session.prewarm(target.provider, { model: target.model, thinking: target.thinking, signal: abort.signal });
                }
                finally {
                    prewarmAbort = null;
                    prewarmTarget = null;
                }
            }).catch(() => { });
        });
    }
    /** 重複的暖機接手同設定的背景預載；session 會保留尚未使用且有效的頁面。 */
    function runWarmup(provider, model) {
        return withBrowserLock(async () => {
            if (!session.browserRunning)
                await session.launch();
            return session.prewarm(provider, { model });
        }, (target) => target.provider === provider && target.model === model && target.thinking === undefined);
    }
    /** MCP 與外掛橋接共用，取消後不再送出提示或排下一次預載。 */
    async function runAsk(provider, prompt, options) {
        try {
            return await withBrowserLock(async () => {
                throwIfAborted(options.signal);
                if (!session.browserRunning)
                    await session.launch();
                throwIfAborted(options.signal);
                const result = await session.ask(provider, prompt, options);
                throwIfAborted(options.signal);
                log(`${provider}: ask completed in ${Math.round(result.elapsedMs / 1000)}s ` +
                    `(private=${String(result.temporaryChat)}, loggedIn=${String(result.loggedIn)})`);
                const notes = [];
                if (result.loggedIn === false)
                    notes.push("以訪客（未登入）身分送出");
                if (result.temporaryChat !== true)
                    notes.push(`未能確認無痕模式（temporary_chat=${String(result.temporaryChat)}）`);
                // 沒有正式操作在排隊才預載；相容的下一題可直接等候這個全新無痕頁。
                if (pendingOps === 1)
                    schedulePrewarm({ provider, model: options.model, thinking: options.thinking });
                return {
                    answer: result.answer,
                    prefix: result.completed ? "" : "（注意：等待逾時，以下為目前擷取到的回覆內容）\n\n",
                    notes,
                };
            }, (target) => target.provider === provider &&
                (target.model === undefined || target.model === options.model) &&
                (target.thinking === undefined || target.thinking === options.thinking));
        }
        catch (err) {
            if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
                log(`${provider}: ask cancelled`);
            }
            throw err;
        }
    }
    return { withBrowserLock, runAsk, runWarmup };
}
