'use strict';

/**
 * Node Buffer 的移植。
 *
 * 实现要点：
 * - 类型上 `class Buffer extends Uint8Array`，但实例一律由 `wrap()` 通过
 *   `Object.setPrototypeOf` 从普通 Uint8Array 转换而来，不走构造函数。
 *   这样 `x instanceof Buffer` 与 `x instanceof Uint8Array` 同时成立，
 *   也避开了派生 TypedArray 在各引擎上的构造差异。
 * - 编码全部落在 lib/bytes（base64/latin1/utf8）与本地 hex/utf16le/ascii 上，
 *   不依赖 TextEncoder / TextDecoder —— QuickJS 不保证有它们。
 * - Node 的 `buf.slice()` 返回**视图**（与 Uint8Array.slice 的拷贝语义相反），这里保持一致。
 */

import * as bytesCodec from './lib/bytes';

export type BufferEncoding =
    | 'utf8' | 'utf-8'
    | 'hex'
    | 'base64'
    | 'latin1' | 'binary'
    | 'ascii'
    | 'ucs2' | 'ucs-2' | 'utf16le' | 'utf-16le';

const HEX = '0123456789abcdef';

interface BufferJSON {
    type: 'Buffer';
    data: number[];
}

export class Buffer extends Uint8Array {
    // ---------------------------------------------------------------- statics

    static override from(value: string, encoding?: BufferEncoding): Buffer;
    static override from(value: ArrayLike<number> | Iterable<number>): Buffer;
    static override from(value: ArrayBuffer, byteOffset?: number, length?: number): Buffer;
    static override from(
        value: string | ArrayLike<number> | Iterable<number> | ArrayBuffer | Uint8Array,
        encodingOrOffset?: BufferEncoding | number,
        length?: number
    ): Buffer {
        if (typeof value === 'string') {
            const encoding = typeof encodingOrOffset === 'string' ? encodingOrOffset : 'utf8';
            return wrap(encodeString(value, normalizeEncoding(encoding)));
        }
        if (value instanceof ArrayBuffer) {
            const offset = typeof encodingOrOffset === 'number' ? encodingOrOffset : 0;
            return wrap(length === undefined
                ? new Uint8Array(value, offset)
                : new Uint8Array(value, offset, length));
        }
        if (value instanceof Uint8Array) {
            const copy = new Uint8Array(value.length);
            copy.set(value);
            return wrap(copy);
        }
        return wrap(Uint8Array.from(value as ArrayLike<number>));
    }

    static alloc(size: number, fill?: number | string | Uint8Array, encoding?: BufferEncoding): Buffer {
        const length = checkSize(size);
        const out = new Uint8Array(length);
        const buffer = wrap(out);
        if (fill !== undefined) {
            buffer.fill(fill, 0, length, encoding);
        }
        return buffer;
    }

    static allocUnsafe(size: number): Buffer {
        return wrap(new Uint8Array(checkSize(size)));
    }

    static allocUnsafeSlow(size: number): Buffer {
        return wrap(new Uint8Array(checkSize(size)));
    }

    static isBuffer(value: unknown): value is Buffer {
        return value instanceof Buffer;
    }

    static isEncoding(encoding: string): boolean {
        return ENCODINGS.indexOf(String(encoding).toLowerCase()) >= 0;
    }

    static byteLength(value: string | Uint8Array | ArrayBuffer, encoding?: BufferEncoding): number {
        if (typeof value === 'string') {
            return encodeString(value, normalizeEncoding(encoding)).length;
        }
        if (value instanceof ArrayBuffer) {
            return value.byteLength;
        }
        return value.length;
    }

    static concat(list: readonly Uint8Array[], totalLength?: number): Buffer {
        if (!Array.isArray(list) || list.length === 0) {
            return wrap(new Uint8Array(0));
        }
        let total = 0;
        for (let i = 0; i < list.length; i += 1) {
            total += list[i].length;
        }
        const length = totalLength === undefined ? total : checkSize(totalLength);
        const out = new Uint8Array(length);
        let offset = 0;
        for (let i = 0; i < list.length && offset < length; i += 1) {
            const chunk = list[i];
            const room = length - offset;
            const take = chunk.length < room ? chunk.length : room;
            out.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
            offset += take;
        }
        return wrap(out);
    }

    static compare(a: Uint8Array, b: Uint8Array): number {
        return compareBytes(a, b);
    }

    // ---------------------------------------------------------------- instance

    override toString(encoding?: BufferEncoding, start?: number, end?: number): string {
        const begin = clampIndex(start === undefined ? 0 : start, this.length);
        const finish = clampIndex(end === undefined ? this.length : end, this.length);
        if (finish <= begin) {
            return '';
        }
        const slice = viewOf(this, begin, finish);
        switch (normalizeEncoding(encoding)) {
            case 'hex':
                return hexEncode(slice);
            case 'base64':
                return bytesCodec.encodeBase64(slice);
            case 'latin1':
                return bytesCodec.bytesToLatin1(slice);
            case 'ascii':
                return asciiDecode(slice);
            case 'utf16le':
                return utf16leDecode(slice);
            default:
                return bytesCodec.utf8Decode(slice);
        }
    }

    toJSON(): BufferJSON {
        const data: number[] = new Array(this.length);
        for (let i = 0; i < this.length; i += 1) {
            data[i] = this[i];
        }
        return { type: 'Buffer', data: data };
    }

    equals(other: Uint8Array): boolean {
        if (!(other instanceof Uint8Array)) {
            throw new TypeError('Argument must be a Buffer or Uint8Array');
        }
        return compareBytes(this, other) === 0;
    }

    compare(
        other: Uint8Array,
        targetStart?: number,
        targetEnd?: number,
        sourceStart?: number,
        sourceEnd?: number
    ): number {
        const target = viewOf(other, clampIndex(targetStart ?? 0, other.length), clampIndex(targetEnd ?? other.length, other.length));
        const source = viewOf(this, clampIndex(sourceStart ?? 0, this.length), clampIndex(sourceEnd ?? this.length, this.length));
        return compareBytes(source, target);
    }

    copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number {
        const start = clampIndex(targetStart ?? 0, target.length);
        const from = clampIndex(sourceStart ?? 0, this.length);
        const to = clampIndex(sourceEnd ?? this.length, this.length);
        if (to <= from || start >= target.length) {
            return 0;
        }
        const room = target.length - start;
        const take = Math.min(to - from, room);
        target.set(viewOf(this, from, from + take), start);
        return take;
    }

    override fill(value: number | string | Uint8Array, offset?: number, end?: number, encoding?: BufferEncoding): this {
        const start = clampIndex(offset ?? 0, this.length);
        const finish = clampIndex(end ?? this.length, this.length);
        if (finish <= start) {
            return this;
        }
        let source: Uint8Array;
        if (typeof value === 'string') {
            source = encodeString(value, normalizeEncoding(encoding));
        } else if (typeof value === 'number') {
            source = Uint8Array.of(value & 255);
        } else {
            source = value;
        }
        if (source.length === 0) {
            return this;
        }
        for (let i = start; i < finish; i += 1) {
            this[i] = source[(i - start) % source.length];
        }
        return this;
    }

    override indexOf(value: number | string | Uint8Array, byteOffset?: number, encoding?: BufferEncoding): number {
        return indexOfValue(this, value, byteOffset ?? 0, encoding, false);
    }

    override lastIndexOf(value: number | string | Uint8Array, byteOffset?: number, encoding?: BufferEncoding): number {
        return indexOfValue(this, value, byteOffset ?? this.length, encoding, true);
    }

    override includes(value: number | string | Uint8Array, byteOffset?: number, encoding?: BufferEncoding): boolean {
        return indexOfValue(this, value, byteOffset ?? 0, encoding, false) >= 0;
    }

    override slice(start?: number, end?: number): Buffer {
        return this.subarray(start, end);
    }

    override subarray(start?: number, end?: number): Buffer {
        const begin = clampIndex(start ?? 0, this.length);
        const finish = clampIndex(end ?? this.length, this.length);
        return wrap(viewOf(this, begin, Math.max(begin, finish)));
    }

    write(value: string, offset?: number, length?: number, encoding?: BufferEncoding): number {
        const start = clampIndex(offset ?? 0, this.length);
        const encoded = encodeString(value, normalizeEncoding(encoding));
        const room = this.length - start;
        const take = Math.min(length === undefined ? encoded.length : length, encoded.length, room);
        this.set(encoded.subarray(0, take), start);
        return take;
    }

    writeUInt8(value: number, offset?: number): number {
        const at = checkOffset(offset ?? 0, 1, this.length);
        this[at] = value & 255;
        return at + 1;
    }

    writeInt8(value: number, offset?: number): number {
        return this.writeUInt8(value < 0 ? value + 256 : value, offset);
    }

    writeUInt16LE(value: number, offset?: number): number {
        const at = checkOffset(offset ?? 0, 2, this.length);
        this[at] = value & 255;
        this[at + 1] = (value >>> 8) & 255;
        return at + 2;
    }

    writeUInt16BE(value: number, offset?: number): number {
        const at = checkOffset(offset ?? 0, 2, this.length);
        this[at] = (value >>> 8) & 255;
        this[at + 1] = value & 255;
        return at + 2;
    }

    writeUInt32LE(value: number, offset?: number): number {
        const at = checkOffset(offset ?? 0, 4, this.length);
        this[at] = value & 255;
        this[at + 1] = (value >>> 8) & 255;
        this[at + 2] = (value >>> 16) & 255;
        this[at + 3] = (value >>> 24) & 255;
        return at + 4;
    }

    writeUInt32BE(value: number, offset?: number): number {
        const at = checkOffset(offset ?? 0, 4, this.length);
        this[at] = (value >>> 24) & 255;
        this[at + 1] = (value >>> 16) & 255;
        this[at + 2] = (value >>> 8) & 255;
        this[at + 3] = value & 255;
        return at + 4;
    }

    writeInt16LE(value: number, offset?: number): number {
        return this.writeUInt16LE(value < 0 ? value + 0x10000 : value, offset);
    }

    writeInt16BE(value: number, offset?: number): number {
        return this.writeUInt16BE(value < 0 ? value + 0x10000 : value, offset);
    }

    writeInt32LE(value: number, offset?: number): number {
        return this.writeUInt32LE(value < 0 ? value + 0x100000000 : value, offset);
    }

    writeInt32BE(value: number, offset?: number): number {
        return this.writeUInt32BE(value < 0 ? value + 0x100000000 : value, offset);
    }

    readUInt8(offset?: number): number {
        return this[checkOffset(offset ?? 0, 1, this.length)];
    }

    readInt8(offset?: number): number {
        const value = this.readUInt8(offset);
        return value > 127 ? value - 256 : value;
    }

    readUInt16LE(offset?: number): number {
        const at = checkOffset(offset ?? 0, 2, this.length);
        return this[at] | (this[at + 1] << 8);
    }

    readUInt16BE(offset?: number): number {
        const at = checkOffset(offset ?? 0, 2, this.length);
        return (this[at] << 8) | this[at + 1];
    }

    readUInt32LE(offset?: number): number {
        const at = checkOffset(offset ?? 0, 4, this.length);
        return (this[at] | (this[at + 1] << 8) | (this[at + 2] << 16) | (this[at + 3] << 24)) >>> 0;
    }

    readUInt32BE(offset?: number): number {
        const at = checkOffset(offset ?? 0, 4, this.length);
        return ((this[at] << 24) | (this[at + 1] << 16) | (this[at + 2] << 8) | this[at + 3]) >>> 0;
    }

    readInt16LE(offset?: number): number {
        const value = this.readUInt16LE(offset);
        return value > 0x7fff ? value - 0x10000 : value;
    }

    readInt16BE(offset?: number): number {
        const value = this.readUInt16BE(offset);
        return value > 0x7fff ? value - 0x10000 : value;
    }

    readInt32LE(offset?: number): number {
        return this.readUInt32LE(offset) | 0;
    }

    readInt32BE(offset?: number): number {
        return this.readUInt32BE(offset) | 0;
    }
}

/** Node `buffer.constants` 的形状；MAX_STRING_LENGTH 与 V8 上限一致。 */
export const constants = {
    // Node 在 64 位平台取 2^53-1；Operit 只支持 arm64-v8a，故取同一值。
    MAX_LENGTH: 9007199254740991,
    MAX_STRING_LENGTH: 0x1fffffe8
};

export const kMaxLength = constants.MAX_LENGTH;

export const INSPECT_MAX_BYTES = 50;

const ENCODINGS: readonly string[] = [
    'utf8', 'utf-8', 'hex', 'base64', 'latin1', 'binary', 'ascii', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'
];

/** 把普通 Uint8Array 变成 Buffer 实例（不改内容、不拷贝）。 */
export function wrap(source: Uint8Array): Buffer {
    Object.setPrototypeOf(source, Buffer.prototype);
    return source as unknown as Buffer;
}

function viewOf(source: Uint8Array, start: number, end: number): Uint8Array {
    return Uint8Array.prototype.subarray.call(source, start, end) as Uint8Array;
}

function normalizeEncoding(encoding?: string): string {
    const value = typeof encoding === 'string' ? encoding.toLowerCase() : 'utf8';
    if (value === 'utf-8') {
        return 'utf8';
    }
    if (value === 'binary') {
        return 'latin1';
    }
    if (value === 'ucs-2' || value === 'ucs2') {
        return 'utf16le';
    }
    if (value === 'utf-16le') {
        return 'utf16le';
    }
    if (ENCODINGS.indexOf(value) >= 0) {
        return value;
    }
    throw new TypeError('Unknown encoding: ' + String(encoding));
}

function encodeString(value: string, encoding: string): Uint8Array {
    switch (encoding) {
        case 'hex':
            return hexDecode(value);
        case 'base64':
            return bytesCodec.decodeBase64(value);
        case 'latin1':
            return bytesCodec.latin1ToBytes(value);
        case 'ascii':
            return asciiEncode(value);
        case 'utf16le':
            return utf16leEncode(value);
        default:
            return bytesCodec.utf8Encode(value);
    }
}

function hexEncode(source: Uint8Array): string {
    let out = '';
    for (let i = 0; i < source.length; i += 1) {
        out += HEX[source[i] >> 4] + HEX[source[i] & 15];
    }
    return out;
}

function hexDecode(value: string): Uint8Array {
    const text = String(value);
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i += 2) {
        const high = hexValue(text.charCodeAt(i));
        const low = hexValue(text.charCodeAt(i + 1));
        if (high < 0 || low < 0) {
            break;
        }
        out.push((high << 4) | low);
    }
    return new Uint8Array(out);
}

function hexValue(code: number): number {
    if (code >= 48 && code <= 57) {
        return code - 48;
    }
    if (code >= 97 && code <= 102) {
        return code - 87;
    }
    if (code >= 65 && code <= 70) {
        return code - 55;
    }
    return -1;
}

/**
 * ascii 编码按 Node 语义取低 8 位（与 latin1 一致，不是掩 0x7f）；
 * 解码时才把高位抹掉。这两侧不对称是 Node 的既有行为。
 */
function asciiEncode(value: string): Uint8Array {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
        out[i] = value.charCodeAt(i) & 255;
    }
    return out;
}

function asciiDecode(source: Uint8Array): string {
    let out = '';
    for (let i = 0; i < source.length; i += 1) {
        out += String.fromCharCode(source[i] & 127);
    }
    return out;
}

function utf16leEncode(value: string): Uint8Array {
    const out = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        out[i * 2] = code & 255;
        out[i * 2 + 1] = (code >>> 8) & 255;
    }
    return out;
}

function utf16leDecode(source: Uint8Array): string {
    let out = '';
    for (let i = 0; i + 1 < source.length; i += 2) {
        out += String.fromCharCode(source[i] | (source[i + 1] << 8));
    }
    return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
        if (a[i] !== b[i]) {
            return a[i] < b[i] ? -1 : 1;
        }
    }
    if (a.length === b.length) {
        return 0;
    }
    return a.length < b.length ? -1 : 1;
}

function indexOfValue(
    source: Uint8Array,
    value: number | string | Uint8Array,
    byteOffset: number,
    encoding: BufferEncoding | undefined,
    backwards: boolean
): number {
    let needle: Uint8Array;
    if (typeof value === 'number') {
        needle = Uint8Array.of(value & 255);
    } else if (typeof value === 'string') {
        needle = encodeString(value, normalizeEncoding(encoding));
    } else {
        needle = value;
    }
    if (needle.length === 0) {
        return backwards ? Math.min(byteOffset, source.length) : Math.min(Math.max(byteOffset, 0), source.length);
    }
    if (backwards) {
        let from = Math.min(byteOffset, source.length - needle.length);
        for (; from >= 0; from -= 1) {
            if (matchesAt(source, needle, from)) {
                return from;
            }
        }
        return -1;
    }
    for (let from = Math.max(byteOffset, 0); from + needle.length <= source.length; from += 1) {
        if (matchesAt(source, needle, from)) {
            return from;
        }
    }
    return -1;
}

function matchesAt(source: Uint8Array, needle: Uint8Array, at: number): boolean {
    for (let i = 0; i < needle.length; i += 1) {
        if (source[at + i] !== needle[i]) {
            return false;
        }
    }
    return true;
}

function checkSize(size: number): number {
    if (typeof size !== 'number' || !isFinite(size) || size < 0) {
        throw new RangeError('The value of "size" is out of range.');
    }
    return Math.floor(size);
}

function clampIndex(value: number, length: number): number {
    if (!isFinite(value) || value <= 0) {
        return 0;
    }
    return value >= length ? length : Math.floor(value);
}

function checkOffset(offset: number, size: number, length: number): number {
    if (typeof offset !== 'number' || offset < 0 || offset + size > length) {
        throw new RangeError('Attempt to access memory outside buffer bounds');
    }
    return offset;
}

/**
 * 把静态成员补成**可枚举的自有属性**。
 *
 * Node 的 Buffer 静态成员是赋值出来的，因此可枚举；而 `class` 的 static 方法不可枚举。
 * 这不是吹毛求疵：safer-buffer（iconv-lite 的依赖，装机量极大）就是用
 * `for (key in Buffer)` 遍历静态成员来做能力探测的 —— 不可枚举时它复制出空对象，
 * `Buffer.concat` 之类随即消失，iconv-lite 一调用就炸。
 * 这个差异只有在跑真实 npm 包时才会暴露，纯对拍 API 是看不出来的。
 */
for (const staticKey of Object.getOwnPropertyNames(Buffer)) {
    if (staticKey === 'length' || staticKey === 'name' || staticKey === 'prototype') {
        continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(Buffer, staticKey);
    if (descriptor !== undefined && descriptor.enumerable !== true) {
        Object.defineProperty(Buffer, staticKey, {
            value: descriptor.value,
            writable: descriptor.writable === true,
            enumerable: true,
            configurable: descriptor.configurable === true
        });
    }
}

export default Buffer;
