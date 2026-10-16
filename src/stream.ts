'use strict';

/**
 * Node stream 模块的移植：Readable / Writable / Duplex / Transform / PassThrough，
 * 以及 pipeline / finished（回调与 Promise 两种）。
 *
 * 实现取舍：
 *   - 调度用 queueMicrotask（QuickJS 不一定有 process.nextTick），语义上贴近 Node 的 nextTick；
 *     因此事件时序与 Node 是"同类但不必逐拍相同"，测试验证的是**语义**（数据、顺序、事件、
 *     背压返回值、错误传播），不是逐拍时序。
 *   - 不实现 objectMode 的完整语义差异（只影响 highWaterMark 的计数单位），
 *     也不实现 cork 的深度合并优化。
 *   - 未实现：stream.Duplex 的 allowHalfOpen 完整语义、compose、addAbortSignal。
 */

import EventEmitter = require('./events');
import { Buffer, type BufferEncoding } from './buffer';
import type { StreamOptions, WritableLike } from './lib/stream-types';

function schedule(fn: () => void): void {
    queueMicrotask(fn);
}

function isThenable(value: unknown): boolean {
    return value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function';
}

// ------------------------------------------------------------------ 状态

interface ReadableState {
    chunks: Uint8Array[];
    length: number;
    flowing: boolean | null;
    ended: boolean;
    endEmitted: boolean;
    reading: boolean;
    destroyed: boolean;
    objectMode: boolean;
    highWaterMark: number;
    encoding: string | null;
    pipes: WritableLike[];
    scheduled: boolean;
}

interface WritableState {
    queue: Array<{ chunk: Uint8Array; callback: (error?: Error | null) => void }>;
    length: number;
    writing: boolean;
    corked: number;
    ending: boolean;
    finished: boolean;
    destroyed: boolean;
    objectMode: boolean;
    highWaterMark: number;
    needDrain: boolean;
    finalizing: boolean;
}

const readableStates = new WeakMap<object, ReadableState>();
const writableStates = new WeakMap<object, WritableState>();

function readableStateOf(stream: object, options?: StreamOptions, highWaterMark?: number): ReadableState {
    let state = readableStates.get(stream);
    if (state === undefined) {
        state = {
            chunks: [],
            length: 0,
            flowing: null,
            ended: false,
            endEmitted: false,
            reading: false,
            destroyed: false,
            objectMode: options !== undefined && options.objectMode === true,
            highWaterMark: options !== undefined && typeof options.highWaterMark === 'number' ? options.highWaterMark : 16384,
            encoding: options !== undefined && typeof options.encoding === 'string' ? options.encoding : null,
            pipes: [],
            scheduled: false
        };
        void highWaterMark;
        readableStates.set(stream, state);
    }
    return state;
}

function writableStateOf(stream: object, options?: StreamOptions): WritableState {
    let state = writableStates.get(stream);
    if (state === undefined) {
        state = {
            queue: [],
            length: 0,
            writing: false,
            corked: 0,
            ending: false,
            finished: false,
            destroyed: false,
            objectMode: options !== undefined && (options.objectMode === true || options.writableObjectMode === true),
            highWaterMark: options !== undefined && typeof options.highWaterMark === 'number' ? options.highWaterMark : 16384,
            needDrain: false,
            finalizing: false
        };
        writableStates.set(stream, state);
    }
    return state;
}

function toChunk(chunk: unknown, encoding: string | null, objectMode: boolean): Uint8Array {
    if (objectMode) {
        return chunk as Uint8Array;
    }
    if (typeof chunk === 'string') {
        return Buffer.from(chunk, (encoding === null ? 'utf8' : encoding) as BufferEncoding);
    }
    if (chunk instanceof Uint8Array) {
        return chunk;
    }
    if (chunk instanceof ArrayBuffer) {
        return new Uint8Array(chunk);
    }
    throw new TypeError('The "chunk" argument must be of type string or an instance of Buffer or Uint8Array.');
}

function decodeChunk(chunk: Uint8Array, encoding: string | null): string {
    return encoding === null ? '' : Buffer.from(chunk).toString(encoding as BufferEncoding);
}

// ------------------------------------------------------------------ Readable

class Readable extends EventEmitter {
    readable = true;

    constructor(options?: StreamOptions) {
        super();
        readableStateOf(this, options);
        if (options !== undefined) {
            if (typeof options.read === 'function') {
                (this as unknown as { _read: unknown })._read = options.read;
            }
            if (typeof options.destroy === 'function') {
                (this as unknown as { _destroy: unknown })._destroy = options.destroy;
            }
        }
    }

    // 子类覆写
    _read(size: number): void {
        void size;
        const state = readableStateOf(this);
        if (!state.ended) {
            const error = new Error('The _read() method is not implemented');
            (error as Error & { code?: string }).code = 'ERR_METHOD_NOT_IMPLEMENTED';
            this.destroy(error);
        }
    }

    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        callback(error);
    }

    push(chunk: unknown, encoding?: string): boolean {
        const state = readableStateOf(this);
        if (state.destroyed) {
            return false;
        }
        if (chunk === null) {
            state.ended = true;
            scheduleReadable(this);
            return false;
        }
        const value = toChunk(chunk, encoding === undefined ? state.encoding : encoding, state.objectMode);
        state.chunks.push(value);
        state.length += value.length;
        if (state.flowing === true) {
            scheduleReadable(this);
        } else {
            this.emit('readable');
        }
        return state.length < state.highWaterMark;
    }

    unshift(chunk: unknown): void {
        const state = readableStateOf(this);
        const value = toChunk(chunk, state.encoding, state.objectMode);
        state.chunks.unshift(value);
        state.length += value.length;
    }

    read(size?: number): unknown {
        const state = readableStateOf(this);
        if (state.chunks.length === 0) {
            if (state.ended) {
                return null;
            }
            if (!state.reading) {
                state.reading = true;
                try {
                    this._read(state.highWaterMark);
                } finally {
                    state.reading = false;
                }
            }
            if (state.chunks.length === 0) {
                return null;
            }
        }
        const wanted = size === undefined || size === null || (size as number) <= 0 ? state.length : size;
        if (state.objectMode) {
            const first = state.chunks.shift();
            state.length -= (first as Uint8Array).length;
            return first;
        }
        if ((wanted as number) >= state.length) {
            const all = state.chunks.length === 1 ? state.chunks[0] : concat(state.chunks, state.length);
            state.chunks = [];
            state.length = 0;
            return all;
        }
        // 只取前 wanted 个字节
        const out = new Uint8Array(wanted as number);
        let filled = 0;
        while (filled < (wanted as number) && state.chunks.length > 0) {
            const head = state.chunks[0];
            const take = Math.min(head.length, (wanted as number) - filled);
            out.set(head.subarray(0, take), filled);
            filled += take;
            if (take === head.length) {
                state.chunks.shift();
            } else {
                state.chunks[0] = head.subarray(take);
            }
        }
        state.length -= filled;
        return out;
    }

    setEncoding(encoding: string): this {
        const state = readableStateOf(this);
        state.encoding = encoding;
        return this;
    }

    pause(): this {
        const state = readableStateOf(this);
        state.flowing = false;
        this.emit('pause');
        return this;
    }

    resume(): this {
        const state = readableStateOf(this);
        state.flowing = true;
        this.emit('resume');
        scheduleReadable(this);
        return this;
    }

    isPaused(): boolean {
        return readableStateOf(this).flowing === false;
    }

    pipe<T extends WritableLike>(destination: T, options?: { end?: boolean }): T {
        const state = readableStateOf(this);
        const shouldEnd = options === undefined || options.end !== false;
        state.pipes.push(destination);

        const onData = (chunk: unknown): void => {
            if (destination.write(chunk) === false) {
                this.pause();
            }
        };
        const onDrain = (): void => {
            if (state.flowing === false) {
                this.resume();
            }
        };
        const onEnd = (): void => {
            destination.removeListener('drain', onDrain);
            if (shouldEnd) {
                destination.end();
            }
        };
        const onError = (error: unknown): void => {
            destination.emit('error', error);
        };

        this.on('data', onData);
        destination.on('drain', onDrain);
        this.once('end', onEnd);
        this.once('error', onError);
        this.resume();
        return destination;
    }

    unpipe(destination?: WritableLike): this {
        const state = readableStateOf(this);
        state.pipes = destination === undefined
            ? []
            : state.pipes.filter(function (item) { return item !== destination; });
        return this;
    }

    destroy(error?: Error | null): this {
        const state = readableStateOf(this);
        if (state.destroyed) {
            return this;
        }
        state.destroyed = true;
        this._destroy(error === undefined ? null : error, (finalError?: Error | null): void => {
            if (finalError !== undefined && finalError !== null) {
                this.emit('error', finalError);
            }
            this.emit('close');
        });
        return this;
    }

    override on(event: string, listener: (...args: unknown[]) => void): this {
        super.on(event, listener);
        if (event === 'data') {
            this.resume();
        }
        return this;
    }

    [Symbol.asyncIterator](): { next(): Promise<{ value: unknown; done: boolean }> } {
        const stream = this;
        const queue: unknown[] = [];
        let done = false;
        let failure: Error | null = null;
        let waiting: ((result: { value: unknown; done: boolean }) => void) | null = null;

        const flush = (): void => {
            if (waiting === null) {
                return;
            }
            const resolve = waiting;
            if (queue.length > 0) {
                waiting = null;
                resolve({ value: queue.shift(), done: false });
                return;
            }
            if (failure !== null) {
                waiting = null;
                const error = failure;
                failure = null;
                resolve(Promise.reject(error) as unknown as { value: unknown; done: boolean });
                return;
            }
            if (done) {
                waiting = null;
                resolve({ value: undefined, done: true });
            }
        };

        stream.on('data', function (chunk: unknown): void {
            queue.push(chunk);
            flush();
        });
        stream.on('end', function (): void {
            done = true;
            flush();
        });
        stream.on('error', function (error: unknown): void {
            failure = error as Error;
            flush();
        });

        return {
            next(): Promise<{ value: unknown; done: boolean }> {
                if (queue.length > 0) {
                    return Promise.resolve({ value: queue.shift(), done: false });
                }
                if (failure !== null) {
                    const error = failure;
                    failure = null;
                    return Promise.reject(error);
                }
                if (done) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise(function (resolve): void {
                    waiting = resolve;
                });
            }
        };
    }

    static from(iterable: unknown): Readable {
        const source = iterable as { [Symbol.iterator]?: () => Iterator<unknown>; [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };
        const isAsync = typeof source[Symbol.asyncIterator] === 'function';
        const iterator = isAsync
            ? (source[Symbol.asyncIterator] as () => AsyncIterator<unknown>).call(source)
            : (source[Symbol.iterator] as () => Iterator<unknown>).call(source);
        let busy = false;
        const stream = new Readable({
            objectMode: true,
            read: function (): void {
                if (busy) {
                    return;
                }
                busy = true;
                const step = (): void => {
                    const result = isAsync
                        ? (iterator as AsyncIterator<unknown>).next()
                        : (iterator as Iterator<unknown>).next();
                    if (isThenable(result)) {
                        (result as Promise<IteratorResult<unknown>>).then(function (resolved): void {
                            busy = false;
                            if (resolved.done === true) {
                                stream.push(null);
                            } else {
                                stream.push(resolved.value);
                            }
                        }, function (error: unknown): void {
                            busy = false;
                            stream.destroy(error as Error);
                        });
                        return;
                    }
                    const value = result as IteratorResult<unknown>;
                    busy = false;
                    if (value.done === true) {
                        stream.push(null);
                    } else {
                        stream.push(value.value);
                    }
                };
                step();
            }
        });
        return stream;
    }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i += 1) {
        out.set(chunks[i], offset);
        offset += chunks[i].length;
    }
    return out;
}

/** 把缓冲里的数据按需推给 'data' 监听器，并在结束时补一次 'end'。 */
function scheduleReadable(stream: Readable): void {
    const state = readableStateOf(stream);
    if (state.scheduled || state.destroyed) {
        return;
    }
    state.scheduled = true;
    schedule(function (): void {
        state.scheduled = false;
        flow(stream);
    });
}

function takeBufferedChunk(state: ReadableState): Uint8Array | undefined {
    if (state.chunks.length === 0) {
        return undefined;
    }
    const chunk = state.chunks.shift();
    if (chunk === undefined) {
        return undefined;
    }
    state.length -= typeof chunk.length === 'number' ? chunk.length : 1;
    return chunk;
}

function flow(stream: Readable): void {
    const state = readableStateOf(stream);
    if (state.destroyed) {
        return;
    }
    while (state.flowing === true && state.chunks.length > 0) {
        // 一次只发一块：Node 是每个 push() 对应一次 'data'，不是把缓冲拼起来发
        const chunk = takeBufferedChunk(state);
        if (chunk === undefined) {
            break;
        }
        if (state.encoding !== null && !state.objectMode) {
            stream.emit('data', decodeChunk(chunk as Uint8Array, state.encoding));
        } else {
            stream.emit('data', chunk);
        }
    }
    if (state.chunks.length === 0 && !state.ended && state.flowing === true) {
        if (!state.reading) {
            state.reading = true;
            try {
                stream._read(state.highWaterMark);
            } finally {
                state.reading = false;
            }
        }
        if (state.chunks.length > 0) {
            scheduleReadable(stream);
            return;
        }
    }
    if (state.ended && state.chunks.length === 0 && !state.endEmitted) {
        if (state.flowing !== false) {
            state.endEmitted = true;
            stream.emit('end');
        }
    }
}

// ------------------------------------------------------------------ Writable

const writableMethods = {
    write(this: unknown, chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
        const stream = this as WritableLike;
        const state = writableStateOf(stream as object);
        let chunkEncoding: string | null = state.objectMode ? null : 'utf8';
        let done: (error?: Error | null) => void = function (): void { /* 无回调 */ };
        if (typeof encoding === 'function') {
            done = encoding as (error?: Error | null) => void;
        } else {
            if (typeof encoding === 'string') {
                chunkEncoding = encoding;
            }
            if (typeof callback === 'function') {
                done = callback as (error?: Error | null) => void;
            }
        }
        if (state.destroyed) {
            const error = new Error('Cannot call write after a stream was destroyed');
            (error as Error & { code?: string }).code = 'ERR_STREAM_DESTROYED';
            schedule(function (): void { done(error); });
            return false;
        }
        const bytes = toChunk(chunk, chunkEncoding, state.objectMode);
        state.queue.push({ chunk: bytes, callback: done });
        state.length += bytes.length;
        processWritableQueue(stream as object);
        const canContinue = state.length < state.highWaterMark;
        state.needDrain = !canContinue;
        return canContinue;
    },

    end(this: unknown, chunk?: unknown, encoding?: unknown, callback?: unknown): unknown {
        const stream = this as WritableLike;
        const state = writableStateOf(stream as object);
        let done: (() => void) | undefined;
        if (typeof chunk === 'function') {
            done = chunk as () => void;
        } else if (typeof encoding === 'function') {
            done = encoding as () => void;
        } else if (typeof callback === 'function') {
            done = callback as () => void;
        }
        if (typeof chunk !== 'function' && chunk !== undefined && chunk !== null) {
            (this as WritableLike).write(chunk, encoding);
        }
        state.ending = true;
        if (done !== undefined) {
            stream.once('finish', done);
        }
        processWritableQueue(stream as object);
        return this;
    },

    cork(this: unknown): void {
        const state = writableStateOf(this as object);
        state.corked += 1;
    },

    uncork(this: unknown): void {
        const state = writableStateOf(this as object);
        if (state.corked > 0) {
            state.corked -= 1;
        }
        processWritableQueue(this as object);
    },

    setDefaultEncoding(this: unknown, encoding: string): unknown {
        void encoding;
        return this;
    },

    destroy(this: unknown, error?: Error | null): unknown {
        const state = writableStateOf(this as object);
        const stream = this as WritableLike;
        if (state.destroyed) {
            return this;
        }
        state.destroyed = true;
        const target = this as unknown as { _destroy?: (e: Error | null, cb: (e?: Error | null) => void) => void };
        const finish = (finalError?: Error | null): void => {
            if (finalError !== undefined && finalError !== null) {
                stream.emit('error', finalError);
            }
            stream.emit('close');
        };
        if (typeof target._destroy === 'function') {
            target._destroy(error === undefined ? null : error, finish);
        } else {
            finish(error === undefined ? null : error);
        }
        return this;
    }
};

/**
 * 队列排空后结束可写侧：先跑 _final（Transform 就是靠它在 _flush 后 push(null)），
 * 再发 'finish'。漏掉 _final 会让 Transform 的可读侧永远不结束 —— 这个坑踩过。
 */
function finalizeWritable(stream: object): void {
    const state = writableStateOf(stream);
    const target = stream as unknown as { _final?: (callback: (error?: Error | null) => void) => void };
    const emitFinish = function (error?: Error | null): void {
        state.finalizing = false;
        if (error !== undefined && error !== null) {
            (stream as WritableLike).emit('error', error);
            return;
        }
        state.finished = true;
        (stream as WritableLike).emit('finish');
    };
    if (typeof target._final !== 'function') {
        state.finalizing = true;
        emitFinish(null);
        return;
    }
    state.finalizing = true;
    target._final(emitFinish);
}

function processWritableQueue(stream: object): void {
    const state = writableStateOf(stream);
    if (state.writing || state.corked > 0) {
        return;
    }
    const next = state.queue.shift();
    if (next === undefined) {
        if (state.ending && !state.finished && !state.finalizing) {
            finalizeWritable(stream);
        }
        return;
    }
    state.writing = true;
    // 在途的这一块也要计入 length —— Node 的 write() 返回值与 drain 时机都依赖这点
    const target = stream as unknown as { _write?: (chunk: unknown, encoding: string, cb: (error?: Error | null) => void) => void; _final?: (cb: (error?: Error | null) => void) => void };
    const afterWrite = function (error?: Error | null): void {
        state.writing = false;
        state.length -= next.chunk.length;
        if (error !== undefined && error !== null) {
            (stream as WritableLike).emit('error', error);
            return;
        }
        next.callback(null);
        if (state.needDrain && state.length < state.highWaterMark) {
            state.needDrain = false;
            (stream as WritableLike).emit('drain');
        }
        processWritableQueue(stream);
    };
    if (typeof target._write !== 'function') {
        const error = new Error('The _write() method is not implemented');
        (error as Error & { code?: string }).code = 'ERR_METHOD_NOT_IMPLEMENTED';
        (stream as WritableLike).emit('error', error);
        return;
    }
    target._write(next.chunk, 'buffer', afterWrite);
}

class Writable extends EventEmitter {
    writable = true;

    constructor(options?: StreamOptions) {
        super();
        writableStateOf(this, options);
        if (options !== undefined) {
            if (typeof options.write === 'function') {
                (this as unknown as { _write: unknown })._write = options.write;
            }
            if (typeof options.final === 'function') {
                (this as unknown as { _final: unknown })._final = options.final;
            }
            if (typeof options.destroy === 'function') {
                (this as unknown as { _destroy: unknown })._destroy = options.destroy;
            }
        }
    }
}

function applyWritable(target: object): void {
    const source = writableMethods as unknown as Record<string, unknown>;
    Object.keys(source).forEach(function (key): void {
        (target as Record<string, unknown>)[key] = source[key];
    });
}

applyWritable(Writable.prototype);

// ------------------------------------------------------------------ Duplex

class Duplex extends Readable {
    writable = true;

    constructor(options?: StreamOptions) {
        super(options);
        writableStateOf(this, options);
        if (options !== undefined) {
            if (typeof options.write === 'function') {
                (this as unknown as { _write: unknown })._write = options.write;
            }
            if (typeof options.final === 'function') {
                (this as unknown as { _final: unknown })._final = options.final;
            }
        }
    }
}

applyWritable(Duplex.prototype);

// ------------------------------------------------------------------ Transform

class Transform extends Duplex {
    constructor(options?: StreamOptions) {
        super(options);
        if (options !== undefined) {
            if (typeof options.transform === 'function') {
                (this as unknown as { _transform: unknown })._transform = options.transform;
            }
            if (typeof options.flush === 'function') {
                (this as unknown as { _flush: unknown })._flush = options.flush;
            }
        }
    }

    _transform(chunk: unknown, encoding: string, callback: (error?: Error | null, data?: unknown) => void): void {
        void chunk;
        void encoding;
        const error = new Error('The _transform() method is not implemented');
        (error as Error & { code?: string }).code = 'ERR_METHOD_NOT_IMPLEMENTED';
        callback(error);
    }

    /** Transform 的可读侧由 _write 推入，不去主动拉数据，因此这里是空的。 */
    override _read(size: number): void {
        void size;
    }

    _flush(callback: (error?: Error | null) => void): void {
        callback();
    }

    _write(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void {
        const self = this as unknown as {
            _transform: (chunk: unknown, encoding: string, cb: (error?: Error | null, data?: unknown) => void) => void;
            push: (data: unknown) => boolean;
        };
        self._transform(chunk, encoding, function (error?: Error | null, data?: unknown): void {
            if (error !== undefined && error !== null) {
                callback(error);
                return;
            }
            if (data !== undefined && data !== null) {
                self.push(data);
            }
            callback(null);
        });
    }

    _final(callback: (error?: Error | null) => void): void {
        const self = this as unknown as {
            _flush: (cb: (error?: Error | null) => void) => void;
            push: (data: unknown) => boolean;
        };
        self._flush(function (error?: Error | null): void {
            if (error !== undefined && error !== null) {
                callback(error);
                return;
            }
            self.push(null);
            callback(null);
        });
    }
}

// ------------------------------------------------------------------ PassThrough

class PassThrough extends Transform {
    override _transform(chunk: unknown, encoding: string, callback: (error?: Error | null, data?: unknown) => void): void {
        void encoding;
        callback(null, chunk);
    }
}

// ------------------------------------------------------------------ pipeline / finished

function finished(stream: WritableLike | Readable, callback: (error?: Error | null) => void): () => void {
    const target = stream as unknown as EventEmitter;
    let done = false;
    const onError = (error: unknown): void => {
        if (done) {
            return;
        }
        done = true;
        cleanup();
        callback(error as Error);
    };
    const onEnd = (): void => {
        if (done) {
            return;
        }
        done = true;
        cleanup();
        callback(null);
    };
    const cleanup = (): void => {
        target.removeListener('error', onError);
        target.removeListener('end', onEnd);
        target.removeListener('finish', onEnd);
        target.removeListener('close', onEnd);
    };
    target.on('error', onError);
    target.once('end', onEnd);
    target.once('finish', onEnd);
    target.once('close', onEnd);
    return cleanup;
}

function isReadableStream(value: unknown): boolean {
    return value !== null && typeof value === 'object' && typeof (value as WritableLike).on === 'function' &&
        typeof (value as { read?: unknown }).read === 'function';
}

function isWritableStream(value: unknown): boolean {
    return value !== null && typeof value === 'object' && typeof (value as WritableLike).write === 'function' &&
        typeof (value as WritableLike).end === 'function';
}

function pipeline(...args: unknown[]): unknown {
    const callback = args.length > 0 && typeof args[args.length - 1] === 'function'
        ? args.pop() as (error?: Error | null) => void
        : undefined;
    if (callback === undefined) {
        // 与 Node 一致：stream.pipeline 必须给回调，Promise 形式走 stream/promises
        const error = new TypeError('The "streams[stream.length - 1]" property must be of type function.');
        (error as TypeError & { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
        throw error;
    }
    const streams = args as Array<Readable | WritableLike | ((error?: Error | null) => void)>;
    const transforms = streams.filter(function (item): boolean {
        return typeof item !== 'function';
    }) as Array<Readable | WritableLike>;

    if (transforms.length === 0) {
        if (callback !== undefined) {
            schedule(function (): void { callback(null); });
            return undefined;
        }
        return Promise.resolve();
    }

    const last = transforms[transforms.length - 1];
    const failures: Error[] = [];
    const promise = new Promise<void>(function (resolve, reject): void {
        let settled = false;
        const fail = (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            const value = error as Error;
            if (callback !== undefined) {
                callback(value);
                resolve();
            } else {
                reject(value);
            }
        };
        if (callback !== undefined) {
            finished(last as WritableLike, function (error?: Error | null): void {
                if (error !== undefined && error !== null) {
                    fail(error);
                    return;
                }
                if (settled) {
                    return;
                }
                settled = true;
                callback(null);
                resolve();
            });
        } else {
            finished(last as WritableLike, function (error?: Error | null): void {
                if (error !== undefined && error !== null) {
                    fail(error);
                    return;
                }
                if (!settled) {
                    settled = true;
                    resolve();
                }
            });
        }
        for (let i = 0; i < transforms.length; i += 1) {
            const current = transforms[i] as unknown as EventEmitter;
            current.on('error', fail);
            if (i + 1 < transforms.length) {
                (transforms[i] as Readable).pipe(transforms[i + 1] as WritableLike);
            }
        }
        void failures;
    });

    promise.catch(function (error: unknown): void { callback(error as Error); });
    return last;
}

/** stream/promises 用的 Promise 版：不走 pipeline 的回调校验。 */
function pipelinePromise(...streams: unknown[]): Promise<void> {
    const list = streams as Array<Readable | WritableLike>;
    return new Promise(function (resolve, reject): void {
        if (list.length === 0) {
            resolve();
            return;
        }
        let settled = false;
        // 参数收成 unknown：既能喂给 finished，也能直接当 EventEmitter 的错误监听器
        const settle = function (error?: unknown): void {
            if (settled) {
                return;
            }
            settled = true;
            if (error !== undefined && error !== null) {
                reject(error);
            } else {
                resolve();
            }
        };
        finished(list[list.length - 1], settle);
        for (let i = 0; i < list.length; i += 1) {
            (list[i] as unknown as EventEmitter).on('error', settle);
            if (i + 1 < list.length) {
                (list[i] as Readable).pipe(list[i + 1] as WritableLike);
            }
        }
    });
}

function finishedPromise(stream: unknown): Promise<void> {
    return new Promise(function (resolve, reject): void {
        finished(stream as WritableLike, function (error?: Error | null): void {
            if (error !== undefined && error !== null) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

// ------------------------------------------------------------------ 导出

class Stream extends EventEmitter {
    static Readable = Readable;
    static Writable = Writable;
    static Duplex = Duplex;
    static Transform = Transform;
    static PassThrough = PassThrough;
    static Stream = Stream;
    static pipeline = pipeline;
    static finished = finished;
    static promises = { pipeline: pipelinePromise, finished: finishedPromise };
    static isReadable = isReadableStream;
    static isWritable = isWritableStream;
}

export = Stream;
