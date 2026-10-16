'use strict';

/**
 * console。
 *
 * 沙箱的 prelude 已经在每个模块作用域里提供了一个 console（JsExecutionScriptBuilder.kt:53），
 * 但它只有 log / info / warn / error 四个方法，而且是 `arguments.join(' ')` ——
 * 也就是 `console.log('%s', 'x')` 会原样打印 "%s x"，与 Node 不同。
 *
 * 本模块在这之上补齐 Node 的 console API，并改用 util.format 格式化。
 *
 * 与 Node 的差异（都写进 BUILTINS.json）：
 *   - 不指定输出流时走 prelude console（Node 是 process.stdout / stderr）；
 *   - clear / profile / profileEnd / timeStamp 与 Node 在非 TTY 下一样是空操作；
 *   - table 只实现 Node 的常用形态（对象数组 / 单对象），不做列的自动推算。
 */

import utilModule = require('./util');

import { WriteStreamLike, HostConsoleLike } from './lib/console-types';

const hostConsole = console as unknown as HostConsoleLike;

function hasWrite(value: unknown): value is WriteStreamLike {
    return typeof value === 'object' && value !== null && typeof (value as WriteStreamLike).write === 'function';
}

function nowMillis(): number {
    return typeof performance === 'object' && performance !== null ? performance.now() : Date.now();
}

function describeTime(milliseconds: number): string {
    return milliseconds.toFixed(3) + 'ms';
}

class Console {
    constructor(stdout?: unknown, stderr?: unknown) {
        this.stdout = hasWrite(stdout) ? stdout : null;
        this.stderr = hasWrite(stderr) ? stderr : null;
    }

    readonly stdout: WriteStreamLike | null;
    readonly stderr: WriteStreamLike | null;

    readonly counts = new Map<string, number>();
    readonly timers = new Map<string, number>();
    indent = '';

    emit(target: WriteStreamLike | null, channel: 'log' | 'info' | 'warn' | 'error', text: string): void {
        if (target !== null) {
            target.write(text + '\n');
            return;
        }
        hostConsole[channel](text);
    }

    line(...args: unknown[]): string {
        return this.indent + utilModule.format.apply(null, args as [unknown, ...unknown[]]);
    }

    log(...args: unknown[]): void {
        this.emit(this.stdout, 'log', this.line(...args));
    }

    info(...args: unknown[]): void {
        this.emit(this.stdout, 'info', this.line(...args));
    }

    debug(...args: unknown[]): void {
        this.emit(this.stdout, 'log', this.line(...args));
    }

    warn(...args: unknown[]): void {
        this.emit(this.stderr, 'warn', this.line(...args));
    }

    error(...args: unknown[]): void {
        this.emit(this.stderr, 'error', this.line(...args));
    }

    /** Node 的 console.assert 只在断言失败时输出，且不抛错。 */
    assert(value: unknown, ...args: unknown[]): void {
        if (value) {
            return;
        }
        const detail = args.length === 0 ? '' : ': ' + utilModule.format.apply(null, args as [unknown, ...unknown[]]);
        this.emit(this.stderr, 'error', 'Assertion failed' + detail);
    }

    dir(value: unknown, options?: unknown): void {
        this.emit(this.stdout, 'log', this.indent + utilModule.inspect(value, options as Parameters<typeof utilModule.inspect>[1]));
    }

    count(label?: string): void {
        const key = label === undefined ? 'default' : String(label);
        const next = (this.counts.get(key) ?? 0) + 1;
        this.counts.set(key, next);
        this.emit(this.stdout, 'log', this.indent + key + ': ' + next);
    }

    countReset(label?: string): void {
        const key = label === undefined ? 'default' : String(label);
        this.counts.set(key, 0);
        this.emit(this.stdout, 'log', this.indent + key + ': 0');
    }

    time(label?: string): void {
        this.timers.set(label === undefined ? 'default' : String(label), nowMillis());
    }

    timeEnd(label?: string): void {
        const key = label === undefined ? 'default' : String(label);
        const started = this.timers.get(key);
        if (started === undefined) {
            this.emit(this.stderr, 'warn', 'Warning: No such label \'' + key + '\' for console.timeEnd()');
            return;
        }
        this.timers.delete(key);
        this.emit(this.stdout, 'log', this.indent + key + ': ' + describeTime(nowMillis() - started));
    }

    timeLog(label?: string, ...args: unknown[]): void {
        const key = label === undefined ? 'default' : String(label);
        const started = this.timers.get(key);
        if (started === undefined) {
            this.emit(this.stderr, 'warn', 'Warning: No such label \'' + key + '\' for console.timeLog()');
            return;
        }
        const suffix = args.length === 0 ? '' : ' ' + utilModule.format.apply(null, args as [unknown, ...unknown[]]);
        this.emit(this.stdout, 'log', this.indent + key + ': ' + describeTime(nowMillis() - started) + suffix);
    }

    trace(...args: unknown[]): void {
        const message = args.length === 0 ? 'Trace' : 'Trace: ' + utilModule.format.apply(null, args as [unknown, ...unknown[]]);
        const stack = new Error(message).stack;
        this.emit(this.stderr, 'error', this.indent + message + (stack === undefined ? '' : '\n' + stack));
    }

    table(data: unknown, columns?: readonly string[]): void {
        if (data === null || typeof data !== 'object') {
            this.log(data);
            return;
        }
        const rows: unknown[] = Array.isArray(data) ? data : [data];
        const keys: string[] = [];
        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            if (row === null || typeof row !== 'object') {
                continue;
            }
            const names = columns === undefined ? Object.keys(row) : columns;
            for (let name = 0; name < names.length; name += 1) {
                if (keys.indexOf(names[name]) < 0) {
                    keys.push(names[name]);
                }
            }
        }
        const lines = ['┌─────────┬' + keys.map(() => '──────────').join('┬') + '┐'];
        lines.push('│ (index) │' + keys.map((key) => ' ' + key.padEnd(8) + ' │').join(''));
        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index] as Record<string, unknown>;
            const cells = keys.map((key) => ' ' + utilModule.inspect(row === null || row === undefined ? undefined : row[key]).slice(0, 8).padEnd(8) + ' │');
            lines.push('│ ' + String(index).padEnd(7) + ' │' + cells.join(''));
        }
        lines.push('└─────────┴' + keys.map(() => '──────────').join('┴') + '┘');
        this.emit(this.stdout, 'log', this.indent + lines.join('\n' + this.indent));
    }

    group(...args: unknown[]): void {
        if (args.length > 0) {
            this.log(...args);
        }
        this.indent += '  ';
    }

    groupCollapsed(...args: unknown[]): void {
        this.group(...args);
    }

    groupEnd(): void {
        if (this.indent.length >= 2) {
            this.indent = this.indent.slice(0, -2);
        }
    }

    /** 非 TTY 下与 Node 一样什么都不做。 */
    clear(): void {
        return;
    }

    profile(): void {
        return;
    }

    profileEnd(): void {
        return;
    }

    timeStamp(): void {
        return;
    }
}

const consoleInstance = new Console();

/** Node 的 require('console') 给的是实例，并把 Console 挂在它上面。 */
const consoleModule = {
    Console: Console,
    log: consoleInstance.log.bind(consoleInstance),
    info: consoleInstance.info.bind(consoleInstance),
    debug: consoleInstance.debug.bind(consoleInstance),
    warn: consoleInstance.warn.bind(consoleInstance),
    error: consoleInstance.error.bind(consoleInstance),
    assert: consoleInstance.assert.bind(consoleInstance),
    dir: consoleInstance.dir.bind(consoleInstance),
    count: consoleInstance.count.bind(consoleInstance),
    countReset: consoleInstance.countReset.bind(consoleInstance),
    time: consoleInstance.time.bind(consoleInstance),
    timeEnd: consoleInstance.timeEnd.bind(consoleInstance),
    timeLog: consoleInstance.timeLog.bind(consoleInstance),
    trace: consoleInstance.trace.bind(consoleInstance),
    table: consoleInstance.table.bind(consoleInstance),
    group: consoleInstance.group.bind(consoleInstance),
    groupCollapsed: consoleInstance.groupCollapsed.bind(consoleInstance),
    groupEnd: consoleInstance.groupEnd.bind(consoleInstance),
    clear: consoleInstance.clear.bind(consoleInstance),
    profile: consoleInstance.profile.bind(consoleInstance),
    profileEnd: consoleInstance.profileEnd.bind(consoleInstance),
    timeStamp: consoleInstance.timeStamp.bind(consoleInstance)
};

export = consoleModule;
