'use strict';

/**
 * Node crypto 模块的移植。
 *
 * 覆盖范围：
 *   createHash / createHmac / pbkdf2Sync / pbkdf2 / randomBytes / randomFillSync
 *   randomUUID / randomInt / timingSafeEqual / getHashes / constants
 *
 * 不覆盖（调用即显式抛错，不静默）：createCipheriv / createDecipheriv / createSign /
 * createVerify / generateKeyPair(一个) / createDiffieHellman —— 见 BUILTINS.json。
 *
 * 随机数来源用 java.util.UUID.randomUUID()：它由 SecureRandom 支撑，
 * 每次调用给 16 字节强熵，而且**不需要往 bridge 传 byte[]**（那是本库最不确定的一段）。
 *
 * 哈希是纯 JS 实现（lib/hashes），因为运行时注入的 CryptoJS 只是个 4KB shim，
 * 只有 MD5(string) 与 AES.decrypt，撑不起 crypto 模块。
 */

import * as bridge from './lib/bridge';
import * as hashes from './lib/hashes';
import { Buffer, type BufferEncoding } from './buffer';
import { onjError } from './lib/errors';
import type { HashSpec } from './lib/hashes';

function toBytes(data: unknown, encoding?: string): Uint8Array {
    if (typeof data === 'string') {
        return Buffer.from(data, (encoding === undefined ? 'utf8' : encoding) as BufferEncoding);
    }
    if (data instanceof Uint8Array) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
}

function concatChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (let i = 0; i < chunks.length; i += 1) {
        out.set(chunks[i], offset);
        offset += chunks[i].length;
    }
    return out;
}

class Hash {
    readonly spec: HashSpec;
    chunks: Uint8Array[] = [];
    total = 0;
    finalized = false;

    constructor(algorithm: string) {
        this.spec = hashes.resolveAlgorithm(algorithm);
    }

    update(data: unknown, inputEncoding?: string): this {
        if (this.finalized) {
            throw onjError('ONJ_UNSUPPORTED', 'Hash.digest() 之后不能再 update()。');
        }
        const bytes = toBytes(data, inputEncoding);
        this.chunks.push(bytes);
        this.total += bytes.length;
        return this;
    }

    digest(encoding?: string): string | Buffer {
        if (this.finalized) {
            throw onjError('ONJ_UNSUPPORTED', 'Hash.digest() 只能调用一次。');
        }
        this.finalized = true;
        const result = Buffer.from(this.spec.compute(concatChunks(this.chunks, this.total)));
        this.chunks = [];
        this.total = 0;
        return encoding === undefined ? result : result.toString(encoding as BufferEncoding);
    }

    copy(): Hash {
        const clone = new Hash(this.spec.name);
        clone.chunks = this.chunks.slice();
        clone.total = this.total;
        return clone;
    }
}

class Hmac {
    readonly spec: HashSpec;
    readonly key: Uint8Array;
    chunks: Uint8Array[] = [];
    total = 0;
    finalized = false;

    constructor(algorithm: string, key: unknown, keyEncoding?: string) {
        this.spec = hashes.resolveAlgorithm(algorithm);
        this.key = toBytes(key, keyEncoding);
    }

    update(data: unknown, inputEncoding?: string): this {
        if (this.finalized) {
            throw onjError('ONJ_UNSUPPORTED', 'Hmac.digest() 之后不能再 update()。');
        }
        const bytes = toBytes(data, inputEncoding);
        this.chunks.push(bytes);
        this.total += bytes.length;
        return this;
    }

    digest(encoding?: string): string | Buffer {
        if (this.finalized) {
            throw onjError('ONJ_UNSUPPORTED', 'Hmac.digest() 只能调用一次。');
        }
        this.finalized = true;
        const message = concatChunks(this.chunks, this.total);
        const result = Buffer.from(hashes.hmac(this.spec, this.key, message));
        this.chunks = [];
        this.total = 0;
        return encoding === undefined ? result : result.toString(encoding as BufferEncoding);
    }
}

function createHash(algorithm: string, options?: { outputLength?: number }): Hash {
    void options;
    return new Hash(algorithm);
}

function createHmac(algorithm: string, key: unknown, options?: { encoding?: string }): Hmac {
    return new Hmac(algorithm, key, options === undefined ? undefined : options.encoding);
}

/**
 * 用 UUID.randomUUID() 填满目标缓冲区：每次 16 字节强熵，且不需要传 byte[]。
 */
function fillRandom(target: Uint8Array): Uint8Array {
    let offset = 0;
    while (offset < target.length) {
        const uuid = bridge.callStatic('java.util.UUID', 'randomUUID', []);
        const text = String(bridge.callInstance(uuid, 'toString', []));
        const hex = text.replace(/-/g, '');
        for (let i = 0; i + 1 < hex.length && offset < target.length; i += 2) {
            target[offset] = parseInt(hex.slice(i, i + 2), 16);
            offset += 1;
        }
    }
    return target;
}

function randomBytes(size: number, callback?: (error: Error | null, buffer: Buffer) => void): Buffer | void {
    if (typeof size !== 'number' || size < 0 || !isFinite(size)) {
        throw new RangeError('The value of "size" is out of range.');
    }
    const buffer = Buffer.from(fillRandom(new Uint8Array(Math.floor(size))));
    if (callback !== undefined) {
        callback(null, buffer);
        return undefined;
    }
    return buffer;
}

function randomFillSync(buffer: Uint8Array): Uint8Array {
    if (!(buffer instanceof Uint8Array)) {
        throw new TypeError('The "buffer" argument must be an instance of Buffer or Uint8Array.');
    }
    return fillRandom(buffer);
}

function randomUUID(): string {
    const uuid = bridge.callStatic('java.util.UUID', 'randomUUID', []);
    return String(bridge.callInstance(uuid, 'toString', []));
}

function unbiasedBelow(limit: number): number {
    if (limit <= 0) {
        throw new RangeError('The value of "max" is out of range.');
    }
    if (limit === 1) {
        return 0;
    }
    // 48 位样本 + 拒绝采样，避免取模偏置
    const ceiling = Math.floor(281474976710656 / limit) * limit;
    const sample = new Uint8Array(6);
    for (;;) {
        fillRandom(sample);
        let value = 0;
        for (let i = 0; i < 6; i += 1) {
            value = value * 256 + sample[i];
        }
        if (value < ceiling) {
            return value % limit;
        }
    }
}

function randomInt(
    min: number,
    max?: number | ((error: Error | null, value: number) => void),
    callback?: (error: Error | null, value: number) => void
): number | void {
    // Node 有 randomInt(max) 与 randomInt(min, max) 两种形式
    let low = 0;
    let high: number;
    let done = callback;
    if (typeof max === 'function') {
        done = max;
        high = min;
    } else if (max === undefined) {
        high = min;
    } else {
        low = min;
        high = max;
    }
    if (high <= low) {
        throw new RangeError('The value of "max" is out of range. It must be greater than the value of "min".');
    }
    const value = low + unbiasedBelow(high - low);
    if (done !== undefined) {
        done(null, value);
        return undefined;
    }
    return value;
}

function timingSafeEqual(left: unknown, right: unknown): boolean {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
        throw new TypeError('The "buf1" and "buf2" arguments must be Buffer or Uint8Array.');
    }
    if (left.length !== right.length) {
        const error = new RangeError('Input buffers must have the same byte length');
        (error as RangeError & { code?: string }).code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
        throw error;
    }
    let difference = 0;
    for (let i = 0; i < left.length; i += 1) {
        difference |= left[i] ^ right[i];
    }
    return difference === 0;
}

function pbkdf2Sync(
    password: unknown,
    salt: unknown,
    iterations: number,
    keylen: number,
    digest: string
): Buffer {
    const spec = hashes.resolveAlgorithm(digest);
    return Buffer.from(hashes.pbkdf2(
        spec,
        toBytes(password, 'utf8'),
        toBytes(salt, 'utf8'),
        iterations,
        keylen
    ));
}

function pbkdf2(
    password: unknown,
    salt: unknown,
    iterations: number,
    keylen: number,
    digest: string,
    callback: (error: Error | null, derivedKey: Buffer) => void
): void {
    callback(null, pbkdf2Sync(password, salt, iterations, keylen, digest));
}

function getHashes(): string[] {
    return hashes.hashNames();
}

function getCiphers(): string[] {
    // 未实现任何分组密码，因此这里如实为空
    return [];
}

function unsupported(name: string): never {
    throw onjError('ONJ_UNSUPPORTED', 'crypto.' + name + '() 尚未实现（见 BUILTINS.json）。');
}

function createCipheriv(): never {
    return unsupported('createCipheriv');
}

function createDecipheriv(): never {
    return unsupported('createDecipheriv');
}

function createSign(): never {
    return unsupported('createSign');
}

function createVerify(): never {
    return unsupported('createVerify');
}

function generateKeyPairSync(): never {
    return unsupported('generateKeyPairSync');
}

function createDiffieHellman(): never {
    return unsupported('createDiffieHellman');
}

const constants = {
    RSA_PKCS1_PADDING: 1,
    RSA_NO_PADDING: 3,
    RSA_PKCS1_OAEP_PADDING: 4,
    RSA_X931_PADDING: 5,
    RSA_PKCS1_PSS_PADDING: 6,
    SSL_OP_ALL: 0,
    SSL_OP_NO_SSLv2: 0,
    SSL_OP_NO_SSLv3: 0,
    SSL_OP_NO_TLSv1: 0
};

/**
 * Web Crypto 的最小可用面。
 *
 * getRandomValues / randomUUID 是真实现的（走同一条强随机源）；
 * subtle 整个是"存在但每个操作都显式拒绝"—— 运行时不提供 WebCrypto 的算法实现，
 * 给一个看起来像但结果不对的契约比明确报错更糟。
 */
const webcrypto = {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
        const bytes = randomBytes((array as unknown as Uint8Array).length) as unknown as Uint8Array;
        (array as unknown as Uint8Array).set(bytes);
        return array;
    },
    randomUUID: randomUUID,
    subtle: new Proxy({} as Record<string | symbol, unknown>, {
        get(_target, property) {
            if (property === Symbol.toStringTag || property === 'then' || property === 'toJSON' || property === 'inspect') {
                return undefined;
            }
            throw unsupported('crypto.webcrypto.subtle.' + String(property));
        }
    })
};

const crypto = {
    webcrypto: webcrypto,
    createHash: createHash,
    createHmac: createHmac,
    randomBytes: randomBytes,
    randomFillSync: randomFillSync,
    randomUUID: randomUUID,
    randomInt: randomInt,
    timingSafeEqual: timingSafeEqual,
    pbkdf2Sync: pbkdf2Sync,
    pbkdf2: pbkdf2,
    getHashes: getHashes,
    getCiphers: getCiphers,
    createCipheriv: createCipheriv,
    createDecipheriv: createDecipheriv,
    createSign: createSign,
    createVerify: createVerify,
    generateKeyPairSync: generateKeyPairSync,
    createDiffieHellman: createDiffieHellman,
    constants: constants,
    Hash: Hash,
    Hmac: Hmac
};

export = crypto;
