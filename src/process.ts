'use strict';

/**
 * Node process 模块的移植。
 *
 * 这是 `require('process')` 返回的对象。注意 Operit 运行时**没有** `process` 全局，
 * 所以直接引用裸 `process` 的代码需要由 OperitPackageManager 在重写时注入（见 README）。
 *
 * 已知差异：
 *   - process.env 是 Proxy，读走 Operit 的 getEnv；getEnv 对不存在的变量返回空串，
 *     因此空串与未设置都表现为 undefined；且无法枚举（Object.keys(env) 恒为 []）
 *   - process.exit() 会终止整个 Operit 运行时，这里显式抛错而不是静默继续
 *   - versions.node 是"声明的兼容目标"，不是真实运行时版本
 */

import EventEmitter = require('./events');
import fsModule = require('./fs');
import pathModule = require('./path');
import * as os from './os';
import * as cwd from './lib/cwd';
import * as bridge from './lib/bridge';
import * as bytesCodec from './lib/bytes';
import { onjError, createError } from './lib/errors';

interface QueuedCallback {
    fn: (...args: unknown[]) => void;
    args: unknown[];
}

const pending: QueuedCallback[] = [];
let drainScheduled = false;

function drainQueue(): void {
    drainScheduled = false;
    const batch = pending.splice(0, pending.length);
    for (let i = 0; i < batch.length; i += 1) {
        batch[i].fn.apply(null, batch[i].args);
    }
}

function nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]): void {
    if (typeof fn !== 'function') {
        throw new TypeError('The "callback" argument must be of type function.');
    }
    pending.push({ fn: fn, args: args });
    if (!drainScheduled) {
        drainScheduled = true;
        queueMicrotask(drainQueue);
    }
}

function hrtime(previous?: number[]): number[] {
    const nowMs = performance.now();
    let seconds = Math.floor(nowMs / 1000);
    let nanoseconds = Math.floor((nowMs % 1000) * 1e6);
    if (previous !== undefined) {
        seconds -= previous[0];
        nanoseconds -= previous[1];
        if (nanoseconds < 0) {
            seconds -= 1;
            nanoseconds += 1e9;
        }
    }
    return [seconds, nanoseconds];
}

const hrtimeFunction = hrtime as ((previous?: number[]) => number[]) & { bigint(): bigint };
hrtimeFunction.bigint = function (): bigint {
    return BigInt(Math.floor(performance.now() * 1e6));
};

function readEnvVariable(key: string): string | undefined {
    if (typeof getEnv !== 'function') {
        return undefined;
    }
    const value = getEnv(key);
    // Operit 的 getEnv 对不存在的变量返回空串，无法与"设为空串"区分
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const env = new Proxy({} as Record<string, string | undefined>, {
    get: function (_target, key): string | undefined {
        return typeof key === 'string' ? readEnvVariable(key) : undefined;
    },
    set: function (_target, key, value): boolean {
        bridge.setEnv(String(key), value === undefined || value === null ? null : String(value));
        return true;
    },
    has: function (_target, key): boolean {
        return typeof key === 'string' && readEnvVariable(key) !== undefined;
    },
    deleteProperty: function (_target, key): boolean {
        bridge.setEnv(String(key), null);
        return true;
    },
    ownKeys: function (): string[] {
        // Operit 没有枚举环境变量的接口，因此这里只能为空
        return [];
    }
});

function createWritable(level: 'log' | 'warn'): { isTTY: boolean; columns: number; rows: number; write(chunk: string | Uint8Array): boolean } {
    return {
        isTTY: false,
        columns: 0,
        rows: 0,
        write: function (chunk: string | Uint8Array): boolean {
            const text = typeof chunk === 'string' ? chunk : bytesCodec.utf8Decode(chunk);
            const line = text.charAt(text.length - 1) === '\n' ? text.slice(0, text.length - 1) : text;
            if (level === 'log') {
                console.log(line);
            } else {
                console.warn(line);
            }
            return true;
        }
    };
}

class Process extends EventEmitter {
    // 注意：Process 只以实例形式导出（export =），所以所有成员必须是 public，
    // 否则 declaration 生成会报 TS4094。

    exitCode: number | undefined = undefined;
    title = 'operit';
    // 这三个改成 getter：读的时候才碰宿主，模块加载本身不调用 bridge
    get platform(): string {
        return os.platform();
    }

    get arch(): string {
        return os.arch();
    }

    get version(): string {
        return os.version();
    }

    readonly versions = {
        // 声明的兼容目标，不是真实运行时版本；见 README「已知偏差」
        node: '18.0.0',
        operit: 'node.operit/0.1.0',
        quickjs: 'unknown'
    };
    readonly argv = ['operit'];
    readonly execArgv: string[] = [];
    readonly execPath = 'operit';
    readonly env = env;
    readonly stdout = createWritable('log');
    readonly stderr = createWritable('warn');
    readonly stdin = {
        isTTY: false,
        read: function (): null {
            return null;
        },
        on: function (): unknown {
            return this;
        },
        resume: function (): void {
            // 沙箱里没有真实 stdin
        }
    };
    readonly nextTick = nextTick;
    readonly hrtime = hrtimeFunction;

    get pid(): number {
        return Number(bridge.callStatic('android.os.Process', 'myPid', [])) || 0;
    }

    cwd(): string {
        return cwd.get();
    }

    chdir(directory: string): void {
        if (typeof directory !== 'string') {
            throw new TypeError('The "directory" argument must be of type string.');
        }
        const stats = fsModule.statSync(directory);
        if (stats === undefined || !stats.isDirectory()) {
            throw createError('ENOTDIR', 'chdir', directory);
        }
        // Node 把 cwd 存成解析后的绝对路径，不是原始参数
        cwd.set(pathModule.resolve(directory));
    }

    uptime(): number {
        return os.uptime();
    }

    memoryUsage(): {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
        arrayBuffers: number;
    } {
        const heapTotal = os.totalmem();
        const free = os.freemem();
        return {
            rss: heapTotal,
            heapTotal: heapTotal,
            heapUsed: heapTotal - free,
            external: 0,
            arrayBuffers: 0
        };
    }

    emitWarning(warning: unknown): void {
        const value = warning instanceof Error ? warning : new Error(String(warning));
        this.emit('warning', value);
        console.warn('Warning: ' + value.message);
    }

    exit(code?: number): never {
        void code;
        throw onjError('ONJ_UNSUPPORTED', 'process.exit() 会终止整个 Operit 运行时，node.operit 不提供。');
    }

    abort(): never {
        throw onjError('ONJ_UNSUPPORTED', 'process.abort() 会终止整个 Operit 运行时，node.operit 不提供。');
    }

    umask(): number {
        return 0o022;
    }
}

const processObject = new Process();

export = processObject;
