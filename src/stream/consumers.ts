'use strict';

/**
 * stream/consumers：把一个可读流整体读成各种表示。
 *
 * 与 Node 的差异（都写进 BUILTINS.json）：
 *   - `blob` 显式抛 ONJ_UNSUPPORTED：运行时不提供 Blob（Node 的 blob() 返回一个 Blob 实例），
 *     与其返回一个形状相似但不是 Blob 的对象，不如明确拒绝；
 *   - 不做 Node 内部的 `stream.Readable` 品牌校验，只要求对象有 on()。
 */

import bufferModule = require('../buffer');

import { ReadableLike } from '../lib/stream-consumers-types';

type BufferInstance = InstanceType<typeof bufferModule.Buffer>;

function onjUnsupported(feature: string): Error {
    const failure = new Error(feature + ' 需要运行时的 Blob 实现，Android 的 QuickJS 运行时不提供。');
    (failure as Error & { code?: string }).code = 'ONJ_UNSUPPORTED';
    return failure;
}

function toBytes(chunk: unknown): Uint8Array {
    if (typeof chunk === 'string') {
        return bufferModule.Buffer.from(chunk) as unknown as Uint8Array;
    }
    if (chunk instanceof Uint8Array) {
        return chunk;
    }
    throw new TypeError('流给出的数据块既不是字符串也不是 Uint8Array。');
}

function consume(stream: ReadableLike): Promise<BufferInstance> {
    return new Promise<BufferInstance>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        let finished = false;
        stream.on('data', (chunk) => {
            chunks.push(toBytes(chunk));
        });
        stream.on('end', () => {
            if (finished) {
                return;
            }
            finished = true;
            resolve(bufferModule.Buffer.concat(chunks as unknown as Uint8Array[]) as BufferInstance);
        });
        stream.on('error', (error) => {
            if (finished) {
                return;
            }
            finished = true;
            reject(error);
        });
    });
}

async function buffer(stream: ReadableLike): Promise<BufferInstance> {
    return consume(stream);
}

async function text(stream: ReadableLike): Promise<string> {
    const bytes = await consume(stream);
    return bytes.toString('utf8');
}

async function json(stream: ReadableLike): Promise<unknown> {
    const content = await text(stream);
    return JSON.parse(content);
}

async function arrayBuffer(stream: ReadableLike): Promise<ArrayBuffer> {
    const bytes = await consume(stream);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
}

function blob(_stream: ReadableLike): Promise<never> {
    return Promise.reject(onjUnsupported('stream/consumers.blob()'));
}

const consumers = {
    buffer: buffer,
    text: text,
    json: json,
    arrayBuffer: arrayBuffer,
    blob: blob
};

export = consumers;
