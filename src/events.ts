'use strict';

/**
 * Node events 模块的移植（EventEmitter）。
 *
 * 与 Node 的差异（有意为之）：
 *   - 本实现是 ES class，不能用 `EventEmitter.call(this)` 这种函数式继承；
 *     现代代码一律走 `class X extends EventEmitter`，不受影响。
 *   - `captureRejections` 与 `events.on()`（异步迭代器）未实现。
 */

type EventListener = (...args: unknown[]) => void;
type EventName = string | symbol;

interface StoredListener {
    fn: EventListener;
    once: boolean;
}

interface Registered {
    events: Map<EventName, StoredListener[]>;
    maxListeners: number;
}

const registry = new WeakMap<object, Registered>();

/** Node 用它旁听 error 事件而不消费它。 */
const errorMonitor = Symbol.for('nodejs.errorMonitor');

function stateOf(emitter: object): Registered {
    let current = registry.get(emitter);
    if (current === undefined) {
        current = { events: new Map<EventName, StoredListener[]>(), maxListeners: 0 };
        registry.set(emitter, current);
    }
    return current;
}

function listenersOf(emitter: object, name: EventName, create: boolean): StoredListener[] | undefined {
    const state = stateOf(emitter);
    let list = state.events.get(name);
    if (list === undefined && create) {
        list = [];
        state.events.set(name, list);
    }
    return list;
}

function unwrap(entry: StoredListener): EventListener {
    const fn = entry.fn as EventListener & { listener?: EventListener };
    return entry.once && typeof fn.listener === 'function' ? fn.listener : entry.fn;
}

function indexFromEnd(list: StoredListener[], fn: EventListener): number {
    for (let i = list.length - 1; i >= 0; i -= 1) {
        if (unwrap(list[i]) === fn || list[i].fn === fn) {
            return i;
        }
    }
    return -1;
}

class EventEmitter {
    static defaultMaxListeners = 10;
    static errorMonitor = errorMonitor;
    static EventEmitter = EventEmitter;

    static listenerCount(emitter: EventEmitter, name: EventName): number {
        return emitter.listenerCount(name);
    }

    static getEventListeners(emitter: EventEmitter, name: EventName): EventListener[] {
        return emitter.listeners(name);
    }

    static once(emitter: EventEmitter, name: EventName): Promise<unknown[]> {
        return new Promise(function (resolve, reject): void {
            function onEvent(...args: unknown[]): void {
                emitter.removeListener(name, onError as EventListener);
                resolve(args);
            }
            function onError(error: unknown): void {
                emitter.removeListener(name, onEvent);
                reject(error);
            }
            emitter.once(name, onEvent);
            if (name !== 'error') {
                emitter.once('error', onError);
            }
        });
    }

    static on(emitter: EventEmitter, name: EventName): void {
        void emitter;
        void name;
        throw new Error('node.operit 尚未实现 events.on()（异步迭代器）。');
    }

    constructor() {
        stateOf(this);
    }

    get maxListeners(): number {
        const current = stateOf(this).maxListeners;
        return current === 0 ? EventEmitter.defaultMaxListeners : current;
    }

    set maxListeners(value: number) {
        this.setMaxListeners(value);
    }

    setMaxListeners(count: number): this {
        const normalized = Number(count);
        if (normalized < 0 || !isFinite(normalized)) {
            throw new RangeError('The value of "n" is out of range. It must be a non-negative number.');
        }
        stateOf(this).maxListeners = Math.floor(normalized);
        return this;
    }

    getMaxListeners(): number {
        return this.maxListeners;
    }

    on(name: EventName, listener: EventListener): this {
        return this.addEntry(name, listener, false);
    }

    addListener(name: EventName, listener: EventListener): this {
        return this.addEntry(name, listener, false);
    }

    prependListener(name: EventName, listener: EventListener): this {
        return this.addEntry(name, listener, false, true);
    }

    once(name: EventName, listener: EventListener): this {
        return this.addEntry(name, listener, true);
    }

    prependOnceListener(name: EventName, listener: EventListener): this {
        return this.addEntry(name, listener, true, true);
    }

    /** 内部注册入口。Node 的 EventEmitter 没有它，但 Process 只以实例导出，成员必须是 public。 */
    addEntry(name: EventName, listener: EventListener, once: boolean, prepend = false): this {
        if (typeof listener !== 'function') {
            throw new TypeError('The "listener" argument must be of type function.');
        }
        const list = listenersOf(this, name, true);
        if (list === undefined) {
            return this;
        }
        const emitter = this;
        let stored: StoredListener;
        if (once) {
            // once 的包装器自己摘除自己（与 Node 一致：emit 不做预先移除），
            // 并在 .listener 上保留原函数，供 listeners() / rawListeners() 区分。
            const wrapped = function (this: unknown, ...args: unknown[]): void {
                removeEntry(emitter, name, wrapped);
                listener.apply(emitter, args);
            } as EventListener & { listener?: EventListener };
            wrapped.listener = listener;
            stored = { fn: wrapped, once: true };
        } else {
            stored = { fn: listener, once: false };
        }
        if (prepend) {
            list.unshift(stored);
        } else {
            list.push(stored);
        }
        return this;
    }

    emit(name: EventName, ...args: unknown[]): boolean {
        const list = listenersOf(this, name, false);
        const monitor = name === 'error' ? listenersOf(this, errorMonitor, false) : undefined;
        if ((list === undefined || list.length === 0) && (monitor === undefined || monitor.length === 0)) {
            if (name === 'error') {
                const first = args[0];
                if (first instanceof Error) {
                    throw first;
                }
                const error = new Error('Unhandled error.' + (first === undefined ? '' : ' (' + String(first) + ')'));
                (error as Error & { context?: unknown }).context = first;
                throw error;
            }
            return false;
        }
        if (monitor !== undefined) {
            for (let i = 0; i < monitor.length; i += 1) {
                monitor[i].fn.apply(this, args);
            }
        }
        if (list === undefined || list.length === 0) {
            return false;
        }
        const snapshot = list.slice();
        for (let i = 0; i < snapshot.length; i += 1) {
            const entry = snapshot[i];
            if (entry.once && indexOfEntry(list, entry.fn) < 0) {
                continue;
            }
            entry.fn.apply(this, args);
        }
        return true;
    }

    removeListener(name: EventName, listener: EventListener): this {
        return this.off(name, listener);
    }

    off(name: EventName, listener: EventListener): this {
        const list = listenersOf(this, name, false);
        if (list === undefined) {
            return this;
        }
        const index = indexFromEnd(list, listener);
        if (index >= 0) {
            list.splice(index, 1);
            if (list.length === 0) {
                stateOf(this).events.delete(name);
            }
        }
        return this;
    }

    removeAllListeners(name?: EventName): this {
        const state = stateOf(this);
        if (name === undefined) {
            state.events.clear();
            return this;
        }
        state.events.delete(name);
        return this;
    }

    listeners(name: EventName): EventListener[] {
        const list = listenersOf(this, name, false);
        if (list === undefined) {
            return [];
        }
        return list.map(unwrap);
    }

    rawListeners(name: EventName): EventListener[] {
        const list = listenersOf(this, name, false);
        if (list === undefined) {
            return [];
        }
        return list.map(function (entry: StoredListener): EventListener {
            return entry.fn;
        });
    }

    listenerCount(name: EventName): number {
        const list = listenersOf(this, name, false);
        return list === undefined ? 0 : list.length;
    }

    eventNames(): EventName[] {
        return Array.from(stateOf(this).events.keys());
    }
}

function indexOfEntry(list: StoredListener[], fn: EventListener): number {
    for (let i = 0; i < list.length; i += 1) {
        if (list[i].fn === fn) {
            return i;
        }
    }
    return -1;
}

function removeEntry(emitter: object, name: EventName, fn: EventListener): void {
    const list = listenersOf(emitter, name, false);
    if (list === undefined) {
        return;
    }
    const index = indexOfEntry(list, fn);
    if (index >= 0) {
        list.splice(index, 1);
        if (list.length === 0) {
            stateOf(emitter).events.delete(name);
        }
    }
}

export = EventEmitter;
