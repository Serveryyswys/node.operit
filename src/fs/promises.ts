'use strict';

/**
 * fs/promises 子路径入口。
 *
 * 实现方式：把同步面逐个包进 Promise。
 * 原因很直接 —— 宿主只有 Java bridge 这一条同步通道（DESIGN.md §6.3），
 * 没有真异步可用；所以这里给的是"接口是异步、执行是同步"。
 * 调用方若在 UI 线程上使用，需要自己评估阻塞成本。
 *
 * `open()` 按 Node 语义返回 **FileHandle**（不是裸 fd）。
 * Node 的 fs.promises 并没有 fd 形式的 read/write/close/fstat/ftruncate/fsync，
 * 所以这里也不提供 —— 那些能力在 FileHandle 上。
 */

import fs = require('../fs');
import { Buffer, type BufferEncoding } from '../buffer';

type AsyncFn = (...args: never[]) => unknown;

function promisify<T extends AsyncFn>(fn: T): (...args: Parameters<T>) => Promise<ReturnType<T>> {
    return function (this: unknown, ...args: Parameters<T>): Promise<ReturnType<T>> {
        try {
            return Promise.resolve(fn.apply(null, args) as ReturnType<T>);
        } catch (failure) {
            return Promise.reject(failure);
        }
    };
}

function toBytes(data: unknown, encoding?: string | { encoding?: string }): Uint8Array {
    if (typeof data === 'string') {
        const resolved = typeof encoding === 'string'
            ? encoding
            : (encoding !== undefined && encoding !== null && typeof encoding.encoding === 'string' ? encoding.encoding : 'utf8');
        return Buffer.from(data, resolved as BufferEncoding);
    }
    if (data instanceof Uint8Array) {
        return data;
    }
    throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
}

class FileHandle {
    readonly fd: number;
    closed = false;

    constructor(fd: number) {
        this.fd = fd;
    }

    /** 公开而非 private：FileHandle 会随 fs/promises 一起被聚合导出，TS 不允许导出型别含私有成员（TS4094）。 */
    ensureOpen(): void {
        if (this.closed) {
            const error = new Error('file descriptor was closed');
            (error as Error & { code?: string }).code = 'EBADF';
            throw error;
        }
    }

    /** Node 的 FileHandle.read 返回 { bytesRead, buffer }，不是裸数字。 */
    async read(
        buffer: Uint8Array,
        offset?: number,
        length?: number,
        position?: number | null
    ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
        this.ensureOpen();
        const bytesRead = fs.readSync(this.fd, buffer, offset, length, position);
        return { bytesRead: bytesRead, buffer: buffer };
    }

    /** 同理，write 返回 { bytesWritten, buffer }，buffer 是调用方传入的原始数据。 */
    async write(data: unknown, ...rest: unknown[]): Promise<{ bytesWritten: number; buffer: unknown }> {
        this.ensureOpen();
        const bytesWritten = (fs.writeSync as (...inner: unknown[]) => number)(this.fd, data, rest[0], rest[1], rest[2]);
        return { bytesWritten: bytesWritten, buffer: data };
    }

    async readFile(options?: unknown): Promise<string | Uint8Array> {
        this.ensureOpen();
        return fs.readFileSync(this.fd, options);
    }

    async writeFile(data: unknown, options?: unknown): Promise<void> {
        this.ensureOpen();
        fs.writeFileSync(this.fd, data, options);
    }

    async appendFile(data: unknown, options?: unknown): Promise<void> {
        this.ensureOpen();
        const bytes = toBytes(data, options as string | { encoding?: string } | undefined);
        const size = fs.fstatSync(this.fd).size;
        fs.writeSync(this.fd, bytes, 0, bytes.length, size);
    }

    async stat(): Promise<unknown> {
        this.ensureOpen();
        return fs.fstatSync(this.fd);
    }

    async truncate(length?: number): Promise<void> {
        this.ensureOpen();
        fs.ftruncateSync(this.fd, length);
    }

    async sync(): Promise<void> {
        this.ensureOpen();
        fs.fsyncSync(this.fd);
    }

    async datasync(): Promise<void> {
        this.ensureOpen();
        fs.fdatasyncSync(this.fd);
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        fs.closeSync(this.fd);
    }
}

function open(path: unknown, flags?: unknown, mode?: unknown): Promise<FileHandle> {
    return Promise.resolve().then(function (): FileHandle {
        return new FileHandle(fs.openSync(path, flags, mode));
    });
}

const api = {
    open: open,
    readFile: promisify(fs.readFileSync),
    writeFile: promisify(fs.writeFileSync),
    appendFile: promisify(fs.appendFileSync),
    stat: promisify(fs.statSync),
    lstat: promisify(fs.lstatSync),
    readdir: promisify(fs.readdirSync),
    mkdir: promisify(fs.mkdirSync),
    rm: promisify(fs.rmSync),
    unlink: promisify(fs.unlinkSync),
    rmdir: promisify(fs.rmdirSync),
    rename: promisify(fs.renameSync),
    copyFile: promisify(fs.copyFileSync),
    realpath: promisify(fs.realpathSync),
    readlink: promisify(fs.readlinkSync),
    symlink: promisify(fs.symlinkSync),
    chmod: promisify(fs.chmodSync),
    truncate: promisify(fs.truncateSync),
    utimes: promisify(fs.utimesSync),
    access: promisify(fs.accessSync),
    mkdtemp: promisify(fs.mkdtempSync),
    constants: fs.constants
};

export = api;
