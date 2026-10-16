'use strict';

/**
 * timers/promises 子路径入口。
 *
 * 与 Node 的差异（都写进了 BUILTINS.json）：
 *   - setInterval 用「每次 await 一个 setTimeout」实现，而不是原生 interval，
 *     所以延迟会随迭代次数累积漂移；好处是取消语义直白、与 Node 的可迭代行为一致。
 *   - signal 只按结构检查（aborted / addEventListener），因为没有 AbortController。
 */

import type { AbortSignalLike, TimerOptions } from '../lib/timers-types';

function abortFailure(): Error {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    (error as Error & { code?: string }).code = 'ABORT_ERR';
    return error;
}

function alreadyAborted(signal?: AbortSignalLike): boolean {
    return signal !== undefined && signal.aborted === true;
}

/** 到点后用 value 决议；signal 中止则用 AbortError 拒绝。 */
function waitFor(delayMs: number, value: unknown, options?: TimerOptions): Promise<unknown> {
    return new Promise(function (resolve, reject): void {
        const signal = options === undefined ? undefined : options.signal;
        if (alreadyAborted(signal)) {
            reject(abortFailure());
            return;
        }
        let settled = false;
        const handle = setTimeout(function (): void {
            settled = true;
            detach();
            resolve(value);
        }, delayMs);
        const onAbort = function (): void {
            if (settled) {
                return;
            }
            settled = true;
            detach();
            clearTimeout(handle);
            reject(abortFailure());
        };
        function detach(): void {
            if (signal !== undefined && typeof signal.removeEventListener === 'function') {
                signal.removeEventListener('abort', onAbort);
            }
        }
        if (signal !== undefined && typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', onAbort);
        }
    });
}

async function* interval(delayMs: number, value: unknown, options?: TimerOptions): AsyncGenerator<unknown> {
    for (;;) {
        await waitFor(delayMs, undefined, options);
        yield value;
    }
}

const scheduler = {
    wait: function (delayMs?: number, options?: TimerOptions): Promise<void> {
        return waitFor(delayMs === undefined ? 1 : delayMs, undefined, options) as Promise<void>;
    },
    yield: function (): Promise<void> {
        return new Promise(function (resolve): void {
            queueMicrotask(function (): void {
                resolve();
            });
        });
    }
};

const api = {
    setTimeout: function (delayMs?: number, value?: unknown, options?: TimerOptions): Promise<unknown> {
        return waitFor(delayMs === undefined ? 1 : delayMs, value, options);
    },
    setImmediate: function (value?: unknown, options?: TimerOptions): Promise<unknown> {
        return waitFor(0, value, options);
    },
    setInterval: function (delayMs: number, value?: unknown, options?: TimerOptions): AsyncGenerator<unknown> {
        return interval(delayMs, value, options);
    },
    scheduler: scheduler
};

export = api;
