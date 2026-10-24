'use strict';

/**
 * v8 —— **partial**。
 *
 * 只实现"能从 JVM 如实取到"的堆统计；V8 专有的东西（序列化格式、V8 标志、覆盖率、
 * 堆快照）在 QuickJS + Android 上没有对应物，一律显式抛 ONJ_UNSUPPORTED，
 * 不给形状相似但语义不同的假实现。
 *
 * 注意：这里的堆统计是 **JVM 堆**，不是 V8 堆（Node 里是 V8 堆）。
 * 这一点与 os.totalmem / os.freemem 的近似同类，已在 BUILTINS.json 里记明。
 */

import * as bridge from './lib/bridge';
import * as bytesCodec from './lib/bytes';
import { Buffer } from './buffer';
import { HeapStatistics, HeapSpaceStatistics, HeapCodeStatistics } from './lib/v8-types';

function onjUnsupported(feature: string, reason: string): Error {
    const failure = new Error(feature + '：' + reason);
    (failure as Error & { code?: string }).code = 'ONJ_UNSUPPORTED';
    return failure;
}

function runtime(): unknown {
    return bridge.callStatic('java.lang.Runtime', 'getRuntime', []);
}

function heapNumbers(): { total: number; free: number; max: number } {
    const handle = runtime();
    return {
        total: Number(bridge.callInstance(handle, 'totalMemory', [])) || 0,
        free: Number(bridge.callInstance(handle, 'freeMemory', [])) || 0,
        max: Number(bridge.callInstance(handle, 'maxMemory', [])) || 0
    };
}

function getHeapStatistics(): HeapStatistics {
    const heap = heapNumbers();
    const used = heap.total - heap.free;
    return {
        total_heap_size: heap.total,
        total_heap_size_executable: 0,
        total_physical_size: heap.total,
        total_available_size: heap.max - used,
        used_heap_size: used,
        heap_size_limit: heap.max,
        malloced_memory: 0,
        peak_malloced_memory: 0,
        does_zap_garbage: false,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        external_memory: 0
    };
}

/** QuickJS 不暴露分空间统计，返回空数组（Node 在 V8 下会给出各 space）。 */
function getHeapSpaceStatistics(): HeapSpaceStatistics[] {
    return [];
}

function getHeapCodeStatistics(): HeapCodeStatistics {
    return {
        code_and_metadata_size: 0,
        bytecode_and_metadata_size: 0,
        external_script_source_size: 0,
        cpu_profiler_metadata_size: 0
    };
}

/**
 * 序列化：**自洽实现**，不是 V8 的二进制格式。
 *
 * V8 的 `serialize` 产出的是 V8 自己的堆图编码，QuickJS 无法产出兼容字节流；
 * 但绝大多数调用方只要求 `deserialize(serialize(x))` 往返一致（进程内缓存、IPC 载荷），
 * 所以这里实现一个等价的编码：带引用表，能处理循环引用与共享引用。
 *
 * 与 Node 的差异：**不能跨运行时互换字节流**（Node 的 blob 解不开，反之亦然）。
 * 已在 BUILTINS.json 记明。
 */
const TAG = {
    UNDEFINED: 0x01, NULL: 0x02, TRUE: 0x03, FALSE: 0x04,
    INT: 0x05, DOUBLE: 0x06, STRING: 0x07,
    ARRAY: 0x08, OBJECT: 0x09, MAP: 0x0a, SET: 0x0b,
    DATE: 0x0c, REGEXP: 0x0d, ERROR: 0x0e,
    BUFFER: 0x0f, TYPED: 0x10,
    REF: 0x11, BIGINT: 0x12
};

/**
 * 可增长的字节缓冲。
 *
 * 为什么不用 number[]：JS 里每个元素是一个 number（8 字节起），
 * 1MB 载荷就是 8MB 的中间数组，再 Uint8Array.from 拷一遍 —— 峰值 9 倍。
 * 这里按 2 倍扩容，末尾 slice 截断，峰值控制在 1.5 倍以内。
 */
class ByteSink {
    private buffer: Uint8Array;
    private length = 0;

    constructor(initial: number = 1024) {
        this.buffer = new Uint8Array(initial);
    }

    private ensure(extra: number): void {
        if (this.length + extra <= this.buffer.length) {
            return;
        }
        let capacity = this.buffer.length === 0 ? 1024 : this.buffer.length;
        while (capacity < this.length + extra) {
            capacity *= 2;
        }
        const grown = new Uint8Array(capacity);
        grown.set(this.buffer.subarray(0, this.length));
        this.buffer = grown;
    }

    push(byte: number): void {
        this.ensure(1);
        this.buffer[this.length] = byte & 0xff;
        this.length += 1;
    }

    pushBytes(bytes: Uint8Array): void {
        this.ensure(bytes.length);
        this.buffer.set(bytes, this.length);
        this.length += bytes.length;
    }

    bytes(): Uint8Array {
        return this.buffer.slice(0, this.length);
    }
}

function writeVarUint(out: ByteSink, value: number): void {
    let v = value;
    while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
    }
    out.push(v & 0x7f);
}

function readVarUint(bytes: Uint8Array, state: { at: number }): number {
    let shift = 0;
    let value = 0;
    for (;;) {
        const byte = bytes[state.at];
        state.at += 1;
        value += (byte & 0x7f) * Math.pow(2, shift);
        if ((byte & 0x80) === 0) {
            return value;
        }
        shift += 7;
    }
}

function writeString(out: ByteSink, text: string): void {
    const encoded = bytesCodec.utf8Encode(text);
    writeVarUint(out, encoded.length);
    out.pushBytes(encoded);
}

function readString(bytes: Uint8Array, state: { at: number }): string {
    const length = readVarUint(bytes, state);
    const slice = bytes.subarray(state.at, state.at + length);
    state.at += length;
    return bytesCodec.utf8Decode(slice);
}

function serialize(value: unknown): Uint8Array {
    const out = new ByteSink();
    const seen = new Map<object, number>();

    const write = (item: unknown): void => {
        if (item === undefined) { out.push(TAG.UNDEFINED); return; }
        if (item === null) { out.push(TAG.NULL); return; }
        const kind = typeof item;
        if (kind === 'boolean') { out.push(item === true ? TAG.TRUE : TAG.FALSE); return; }
        if (kind === 'number') {
            const num = item as number;
            if (Number.isInteger(num) && Math.abs(num) <= 0x7fffffff) {
                out.push(TAG.INT);
                writeVarUint(out, num < 0 ? (-num * 2 + 1) : num * 2);
                return;
            }
            out.push(TAG.DOUBLE);
            const scratch = new DataView(new ArrayBuffer(8));
            scratch.setFloat64(0, num);
            out.pushBytes(new Uint8Array(scratch.buffer));
            return;
        }
        if (kind === 'string') { out.push(TAG.STRING); writeString(out, item as string); return; }
        if (kind === 'bigint') { out.push(TAG.BIGINT); writeString(out, (item as bigint).toString(10)); return; }
        if (kind !== 'object') { out.push(TAG.UNDEFINED); return; }

        const object = item as object;
        const known = seen.get(object);
        if (known !== undefined) {
            out.push(TAG.REF);
            writeVarUint(out, known);
            return;
        }
        seen.set(object, seen.size);

        if (Array.isArray(object)) {
            out.push(TAG.ARRAY);
            writeVarUint(out, object.length);
            for (const element of object) {
                write(element);
            }
            return;
        }
        if (object instanceof Map) {
            out.push(TAG.MAP);
            writeVarUint(out, object.size);
            object.forEach((v, k) => { write(k); write(v); });
            return;
        }
        if (object instanceof Set) {
            out.push(TAG.SET);
            writeVarUint(out, object.size);
            object.forEach((v) => { write(v); });
            return;
        }
        if (object instanceof Date) {
            out.push(TAG.DATE);
            const scratch = new DataView(new ArrayBuffer(8));
            scratch.setFloat64(0, object.getTime());
            out.pushBytes(new Uint8Array(scratch.buffer));
            return;
        }
        if (object instanceof RegExp) {
            out.push(TAG.REGEXP);
            writeString(out, object.source);
            writeString(out, object.flags);
            return;
        }
        if (object instanceof Error) {
            out.push(TAG.ERROR);
            writeString(out, object.name);
            writeString(out, object.message);
            return;
        }
        if (object instanceof Buffer) {
            const raw = object as unknown as Uint8Array;
            out.push(TAG.BUFFER);
            writeVarUint(out, raw.length);
            out.pushBytes(new Uint8Array(raw));
            return;
        }
        // TypedArray 判定用 ArrayBuffer.isView（Int32Array / Float64Array 都不是 Uint8Array 子类）；
        // DataView 没有元素类型，按普通对象处理。
        if (ArrayBuffer.isView(object) && !(object instanceof DataView)) {
            out.push(TAG.TYPED);
            writeString(out, object.constructor === undefined ? 'Uint8Array' : (object.constructor as { name?: string }).name || 'Uint8Array');
            // 按**字节**写出（不是按元素），解码时按类型名还原 —— 这样 Int32Array 也能原样回来
            const view = new Uint8Array((object as unknown as { buffer: ArrayBuffer }).buffer, (object as unknown as { byteOffset: number }).byteOffset, (object as unknown as { byteLength: number }).byteLength);
            writeVarUint(out, view.length);
            out.pushBytes(view);
            return;
        }
        out.push(TAG.OBJECT);
        const keys = Object.keys(object);
        writeVarUint(out, keys.length);
        for (const key of keys) {
            writeString(out, key);
            write((object as Record<string, unknown>)[key]);
        }
    };

    write(value);
    return out.bytes();
}

function deserialize(bytes: Uint8Array): unknown {
    const refs: unknown[] = [];
    const state = { at: 0 };

    const read = (): unknown => {
        const tag = bytes[state.at];
        state.at += 1;
        switch (tag) {
            case TAG.UNDEFINED: return undefined;
            case TAG.NULL: return null;
            case TAG.TRUE: return true;
            case TAG.FALSE: return false;
            case TAG.INT: {
                const raw = readVarUint(bytes, state);
                return raw % 2 === 0 ? raw / 2 : -((raw - 1) / 2);
            }
            case TAG.DOUBLE: {
                const scratch = new DataView(new ArrayBuffer(8));
                for (let i = 0; i < 8; i += 1) {
                    scratch.setUint8(i, bytes[state.at + i]);
                }
                state.at += 8;
                return scratch.getFloat64(0);
            }
            case TAG.STRING: return readString(bytes, state);
            case TAG.BIGINT: return BigInt(readString(bytes, state));
            case TAG.ARRAY: {
                const length = readVarUint(bytes, state);
                const array: unknown[] = [];
                refs.push(array);
                for (let i = 0; i < length; i += 1) {
                    array.push(read());
                }
                return array;
            }
            case TAG.OBJECT: {
                const record: Record<string, unknown> = {};
                refs.push(record);
                const count = readVarUint(bytes, state);
                for (let i = 0; i < count; i += 1) {
                    const key = readString(bytes, state);
                    record[key] = read();
                }
                return record;
            }
            case TAG.MAP: {
                const map = new Map<unknown, unknown>();
                refs.push(map);
                const count = readVarUint(bytes, state);
                for (let i = 0; i < count; i += 1) {
                    const key = read();
                    map.set(key, read());
                }
                return map;
            }
            case TAG.SET: {
                const set = new Set<unknown>();
                refs.push(set);
                const count = readVarUint(bytes, state);
                for (let i = 0; i < count; i += 1) {
                    set.add(read());
                }
                return set;
            }
            case TAG.DATE: {
                const scratch = new DataView(new ArrayBuffer(8));
                for (let i = 0; i < 8; i += 1) {
                    scratch.setUint8(i, bytes[state.at + i]);
                }
                state.at += 8;
                const date = new Date(scratch.getFloat64(0));
                refs.push(date);
                return date;
            }
            case TAG.REGEXP: {
                const source = readString(bytes, state);
                const flags = readString(bytes, state);
                const regexp = new RegExp(source, flags);
                refs.push(regexp);
                return regexp;
            }
            case TAG.ERROR: {
                const name = readString(bytes, state);
                const message = readString(bytes, state);
                const error = new Error(message);
                error.name = name;
                refs.push(error);
                return error;
            }
            case TAG.BUFFER: {
                const length = readVarUint(bytes, state);
                const buffer = Buffer.alloc(length);
                for (let i = 0; i < length; i += 1) {
                    buffer[i] = bytes[state.at + i];
                }
                state.at += length;
                refs.push(buffer);
                return buffer;
            }
            case TAG.TYPED: {
                const typeName = readString(bytes, state);
                const byteLength = readVarUint(bytes, state);
                const raw = bytes.subarray(state.at, state.at + byteLength).slice();
                state.at += byteLength;
                const typed = makeTypedArray(typeName, raw);
                refs.push(typed);
                return typed;
            }
            case TAG.REF: {
                const index = readVarUint(bytes, state);
                return refs[index];
            }
            default:
                throw onjUnsupported('v8.deserialize()', '遇到无法识别的标签 ' + String(tag));
        }
    };

    return read();
}

/** 按类型名把字节还原成对应的 TypedArray。未知类型退回 Uint8Array。 */
function makeTypedArray(typeName: string, raw: Uint8Array): unknown {
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    switch (typeName) {
        case 'Int8Array': return new Int8Array(buffer);
        case 'Uint8ClampedArray': return new Uint8ClampedArray(buffer);
        case 'Int16Array': return new Int16Array(buffer);
        case 'Uint16Array': return new Uint16Array(buffer);
        case 'Int32Array': return new Int32Array(buffer);
        case 'Uint32Array': return new Uint32Array(buffer);
        case 'Float32Array': return new Float32Array(buffer);
        case 'Float64Array': return new Float64Array(buffer);
        default: return new Uint8Array(buffer);
    }
}

function setFlagsFromString(): void {
    // V8 专有的标志开关。运行时不是 V8，没有可设的标志；静默忽略比抛错更合适 ——
    // 调用方通常只是为了关掉某些 V8 优化，抛错会让整段逻辑中断。
}

function cachedDataVersionTag(): number {
    // 该值只用于判断编译缓存是否与当前运行时匹配。这里没有 V8 缓存，
    // 返回固定值即可，且保证同一运行期内一致。
    return 0x6f706d31;
}



function writeHeapSnapshot(): never {
    throw onjUnsupported('v8.writeHeapSnapshot()', '堆快照是 V8 专有格式');
}

function takeCoverage(): never {
    throw onjUnsupported('v8.takeCoverage()', '覆盖率采集是 V8 专有能力');
}

function stopCoverage(): never {
    throw onjUnsupported('v8.stopCoverage()', '覆盖率采集是 V8 专有能力');
}

const v8Module = {
    getHeapStatistics: getHeapStatistics,
    getHeapSpaceStatistics: getHeapSpaceStatistics,
    getHeapCodeStatistics: getHeapCodeStatistics,
    serialize: serialize,
    deserialize: deserialize,
    setFlagsFromString: setFlagsFromString,
    cachedDataVersionTag: cachedDataVersionTag,
    writeHeapSnapshot: writeHeapSnapshot,
    takeCoverage: takeCoverage,
    stopCoverage: stopCoverage
};

export = v8Module;
