'use strict';

/**
 * Node fs 模块的移植（同步面）。
 *
 * 分层：本文件只做 Node 语义 —— 选项解析、flag 语义、错误码与返回值形状；
 * 所有 I/O 走 lib/fs-driver，宿主假设收敛在那里。
 *
 * 环境状态机（lib/fs-env）在这里接入：环境决定 cwd，
 * 于是相对路径的解析基准随环境改变，这就是"设置作用环境"的全部含义。
 *
 * 尚未实现：fd 系列（open/read/write/close）与流式 API，见 BUILTINS.json 的说明。
 */

import pathModule = require('./path');
import * as env from './lib/fs-env';
import * as cwd from './lib/cwd';
import * as drivers from './lib/fs-driver';
import { createError, withContext, onjError } from './lib/errors';
import { Buffer, type BufferEncoding } from './buffer';
import streamModule = require('./stream');
import type { DirectoryEntry, FileHandle, FileStat, FsDriver, OpenHandleOptions } from './lib/fs-driver';

import type { ReadStreamOptions, WriteStreamOptions } from './lib/fs-types';

type ReadStreamLike = InstanceType<typeof streamModule.Readable>;
type WriteStreamLike = InstanceType<typeof streamModule.Writable>;

// ------------------------------------------------------------------ 环境接入

env.setHooks({
    setCwd: function (value: string): void {
        cwd.set(value);
    },
    getCwd: function (): string {
        return cwd.get();
    },
    probe: function (root: string): void {
        const current = drivers.getDriver();
        if (!current.exists(root)) {
            throw createError('ENOENT', 'stat', root);
        }
    }
});

function ready(): FsDriver {
    env.ensureBound();
    return drivers.getDriver();
}

function wrapCall<T>(syscall: string, target: string, body: () => T, dest?: string): T {
    try {
        return body();
    } catch (failure) {
        throw withContext(failure, syscall, target, dest);
    }
}

function toAbsolute(value: unknown, argumentName: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(
            'The "' + argumentName + '" argument must be of type string. Received type ' + typeof value
        );
    }
    return pathModule.resolve(value);
}

// ------------------------------------------------------------------ 类型

const FILE_TYPE = 1;
const DIRECTORY_TYPE = 2;
const SYMLINK_TYPE = 3;

class Stats {
    readonly sizeValue: number;
    readonly modeValue: number;
    readonly atimeMsValue: number;
    readonly mtimeMsValue: number;
    readonly ctimeMsValue: number;
    readonly birthtimeMsValue: number;
    readonly fileLike: boolean;
    readonly directoryLike: boolean;
    readonly linkLike: boolean;

    constructor(raw: FileStat) {
        this.sizeValue = raw.size;
        this.modeValue = raw.mode;
        this.atimeMsValue = raw.atimeMs;
        this.mtimeMsValue = raw.mtimeMs;
        this.ctimeMsValue = raw.ctimeMs;
        this.birthtimeMsValue = raw.birthtimeMs;
        this.fileLike = raw.isFile;
        this.directoryLike = raw.isDirectory;
        this.linkLike = raw.isSymbolicLink;
    }

    get size(): number {
        return this.sizeValue;
    }

    get mode(): number {
        return this.modeValue;
    }

    get atimeMs(): number {
        return this.atimeMsValue;
    }

    get mtimeMs(): number {
        return this.mtimeMsValue;
    }

    get ctimeMs(): number {
        return this.ctimeMsValue;
    }

    get birthtimeMs(): number {
        return this.birthtimeMsValue;
    }

    get atime(): Date {
        return new Date(this.atimeMsValue);
    }

    get mtime(): Date {
        return new Date(this.mtimeMsValue);
    }

    get ctime(): Date {
        return new Date(this.ctimeMsValue);
    }

    get birthtime(): Date {
        return new Date(this.birthtimeMsValue);
    }

    isFile(): boolean {
        return this.fileLike;
    }

    isDirectory(): boolean {
        return this.directoryLike;
    }

    isSymbolicLink(): boolean {
        return this.linkLike;
    }

    isBlockDevice(): boolean {
        return false;
    }

    isCharacterDevice(): boolean {
        return false;
    }

    isFIFO(): boolean {
        return false;
    }

    isSocket(): boolean {
        return false;
    }
}

class Dirent {
    readonly name: string;
    readonly kind: number;

    constructor(entry: DirectoryEntry) {
        this.name = entry.name;
        this.kind = entry.isDirectory ? DIRECTORY_TYPE : (entry.isSymbolicLink ? SYMLINK_TYPE : FILE_TYPE);
    }

    isFile(): boolean {
        return this.kind === FILE_TYPE;
    }

    isDirectory(): boolean {
        return this.kind === DIRECTORY_TYPE;
    }

    isSymbolicLink(): boolean {
        return this.kind === SYMLINK_TYPE;
    }

    isBlockDevice(): boolean {
        return false;
    }

    isCharacterDevice(): boolean {
        return false;
    }

    isFIFO(): boolean {
        return false;
    }

    isSocket(): boolean {
        return false;
    }
}

// ------------------------------------------------------------------ 选项

interface FlagSpec {
    readable: boolean;
    writable: boolean;
    append: boolean;
    exclusive: boolean;
    truncate: boolean;
    mustExist: boolean;
}

const FLAGS: Readonly<Record<string, FlagSpec>> = {
    'r': { readable: true, writable: false, append: false, exclusive: false, truncate: false, mustExist: true },
    'r+': { readable: true, writable: true, append: false, exclusive: false, truncate: false, mustExist: true },
    'w': { readable: false, writable: true, append: false, exclusive: false, truncate: true, mustExist: false },
    'w+': { readable: true, writable: true, append: false, exclusive: false, truncate: true, mustExist: false },
    'a': { readable: false, writable: true, append: true, exclusive: false, truncate: false, mustExist: false },
    'a+': { readable: true, writable: true, append: true, exclusive: false, truncate: false, mustExist: false },
    'wx': { readable: false, writable: true, append: false, exclusive: true, truncate: true, mustExist: false },
    'wx+': { readable: true, writable: true, append: false, exclusive: true, truncate: true, mustExist: false },
    'ax': { readable: false, writable: true, append: true, exclusive: true, truncate: false, mustExist: false },
    'ax+': { readable: true, writable: true, append: true, exclusive: true, truncate: false, mustExist: false }
};

function parseFlag(value: unknown): FlagSpec {
    const text = value === undefined || value === null ? 'r' : String(value);
    const spec = FLAGS[text];
    if (spec === undefined) {
        throw new TypeError('Unknown file open flag: ' + text);
    }
    return spec;
}

function normalizeEncoding(value: unknown): BufferEncoding | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string') {
        return value as BufferEncoding;
    }
    if (typeof value === 'object' && typeof (value as { encoding?: unknown }).encoding === 'string') {
        return (value as { encoding: string }).encoding as BufferEncoding;
    }
    return null;
}

// ------------------------------------------------------------------ 同步 API

/** readFileSync / writeFileSync 也接受 fd（Node 支持），这里转成对应句柄。 */
function entryForDescriptor(descriptor: number, syscall: string): OpenEntry {
    return resolveEntry(descriptor, syscall);
}

function readFileSync(target: unknown, options?: unknown): string | Buffer {
    if (typeof target === 'number') {
        const entry = entryForDescriptor(target, 'read');
        const size = entry.handle.size();
        const data = entry.handle.read(0, size);
        const buffer = Buffer.from(data);
        const encoding = normalizeEncoding(options);
        return encoding === null ? buffer : buffer.toString(encoding);
    }
    const file = toAbsolute(target, 'path');
    const encoding = normalizeEncoding(options);
    const flag = options !== null && typeof options === 'object'
        ? (options as { flag?: unknown }).flag
        : undefined;
    const spec = parseFlag(flag);
    if (!spec.readable) {
        throw createError('EBADF', 'read', file);
    }
    const current = ready();
    const data = wrapCall('open', file, function (): Uint8Array {
        return current.readFileBytes(file);
    });
    const buffer = Buffer.from(data);
    return encoding === null ? buffer : buffer.toString(encoding);
}

function writeFileSync(target: unknown, data: unknown, options?: unknown): void {
    if (typeof target === 'number') {
        const entry = entryForDescriptor(target, 'write');
        const encoding = normalizeEncoding(options);
        const payload = toBytes(data, encoding === null ? 'utf8' : encoding);
        entry.handle.truncate(0);
        entry.handle.write(0, payload);
        return;
    }
    const file = toAbsolute(target, 'path');
    // writeFileSync 的默认 flag 是 'w'（readFileSync 才是 'r'）
    const declaredFlag = options !== null && typeof options === 'object'
        ? (options as { flag?: unknown }).flag
        : undefined;
    const spec = parseFlag(declaredFlag === undefined ? 'w' : declaredFlag);
    if (!spec.writable) {
        throw createError('EBADF', 'write', file);
    }
    const encoding = normalizeEncoding(options);
    const payload = toBytes(data, encoding === null ? 'utf8' : encoding);
    const current = ready();
    wrapCall('open', file, function (): void {
        if (spec.mustExist && !current.exists(file)) {
            throw createError('ENOENT', 'open', file);
        }
        if (spec.truncate || spec.append) {
            current.writeFileBytes(file, payload, spec.append, spec.exclusive);
            return;
        }
        // r+ ：从 0 覆盖，保留尾部
        const existing = current.exists(file) ? current.readFileBytes(file) : new Uint8Array(0);
        const merged = new Uint8Array(Math.max(existing.length, payload.length));
        merged.set(existing);
        merged.set(payload, 0);
        current.writeFileBytes(file, merged, false, false);
    });
}

function appendFileSync(target: unknown, data: unknown, options?: unknown): void {
    const encoding = normalizeEncoding(options);
    const payload = toBytes(data, encoding === null ? 'utf8' : encoding);
    const file = toAbsolute(target, 'path');
    const current = ready();
    wrapCall('open', file, function (): void {
        current.writeFileBytes(file, payload, true, false);
    });
}

function toBytes(data: unknown, encoding: BufferEncoding): Uint8Array {
    if (typeof data === 'string') {
        return Buffer.from(data, encoding);
    }
    if (data instanceof Uint8Array) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
}

function existsSync(target: unknown): boolean {
    if (typeof target !== 'string') {
        return false;
    }
    try {
        env.ensureBound();
        return drivers.getDriver().exists(pathModule.resolve(target));
    } catch (failure) {
        return false;
    }
}

function statSync(target: unknown, options?: unknown): Stats | undefined {
    const file = toAbsolute(target, 'path');
    const throwIfNoEntry = options !== null && typeof options === 'object' &&
        (options as { throwIfNoEntry?: unknown }).throwIfNoEntry === false
        ? false
        : true;
    const bigint = options !== null && typeof options === 'object' &&
        (options as { bigint?: unknown }).bigint === true;
    if (bigint) {
        throw onjError('ONJ_UNSUPPORTED', 'bigint 形式的 Stats 尚未实现。');
    }
    const current = ready();
    try {
        return new Stats(current.stat(file, true));
    } catch (failure) {
        if (!throwIfNoEntry && isMissing(failure)) {
            return undefined;
        }
        throw withContext(failure, 'stat', file);
    }
}

function lstatSync(target: unknown, options?: unknown): Stats | undefined {
    const file = toAbsolute(target, 'path');
    const throwIfNoEntry = options !== null && typeof options === 'object' &&
        (options as { throwIfNoEntry?: unknown }).throwIfNoEntry === false
        ? false
        : true;
    const current = ready();
    try {
        return new Stats(current.stat(file, false));
    } catch (failure) {
        if (!throwIfNoEntry && isMissing(failure)) {
            return undefined;
        }
        throw withContext(failure, 'lstat', file);
    }
}

function isMissing(failure: unknown): boolean {
    return (failure as { code?: string } | null)?.code === 'ENOENT';
}

function readdirSync(target: unknown, options?: unknown): string[] | Dirent[] {
    const dir = toAbsolute(target, 'path');
    const withFileTypes = options !== null && typeof options === 'object' &&
        (options as { withFileTypes?: unknown }).withFileTypes === true;
    const current = ready();
    const entries = wrapCall('scandir', dir, function (): DirectoryEntry[] {
        return current.readdir(dir);
    });
    if (withFileTypes) {
        return entries.map(function (entry: DirectoryEntry): Dirent {
            return new Dirent(entry);
        });
    }
    return entries.map(function (entry: DirectoryEntry): string {
        return entry.name;
    });
}

function mkdirSync(target: unknown, options?: unknown): string | undefined {
    const dir = toAbsolute(target, 'path');
    const recursive = options !== null && typeof options === 'object' &&
        (options as { recursive?: unknown }).recursive === true;
    const current = ready();
    return wrapCall('mkdir', dir, function (): string | undefined {
        return current.mkdir(dir, recursive);
    });
}

function rmSync(target: unknown, options?: unknown): void {
    const file = toAbsolute(target, 'path');
    const recursive = options !== null && typeof options === 'object' &&
        (options as { recursive?: unknown }).recursive === true;
    const force = options !== null && typeof options === 'object' &&
        (options as { force?: unknown }).force === true;
    const current = ready();
    wrapCall('rm', file, function (): void {
        current.remove(file, recursive, force);
    });
}

function unlinkSync(target: unknown): void {
    const file = toAbsolute(target, 'path');
    const current = ready();
    wrapCall('unlink', file, function (): void {
        current.remove(file, false, false);
    });
}

function rmdirSync(target: unknown, options?: unknown): void {
    const dir = toAbsolute(target, 'path');
    const recursive = options !== null && typeof options === 'object' &&
        (options as { recursive?: unknown }).recursive === true;
    const current = ready();
    wrapCall('rmdir', dir, function (): void {
        current.remove(dir, recursive, false);
    });
}

function renameSync(from: unknown, to: unknown): void {
    const source = toAbsolute(from, 'oldPath');
    const destination = toAbsolute(to, 'newPath');
    const current = ready();
    wrapCall('rename', source, function (): void {
        current.rename(source, destination);
    }, destination);
}

function copyFileSync(from: unknown, to: unknown): void {
    const source = toAbsolute(from, 'src');
    const destination = toAbsolute(to, 'dest');
    const current = ready();
    wrapCall('copyfile', source, function (): void {
        current.copyFile(source, destination);
    }, destination);
}

function realpathSync(target: unknown): string {
    const file = toAbsolute(target, 'path');
    const current = ready();
    return wrapCall('realpath', file, function (): string {
        return current.realpath(file);
    });
}

function readlinkSync(target: unknown): string {
    const file = toAbsolute(target, 'path');
    const current = ready();
    return wrapCall('readlink', file, function (): string {
        return current.readlink(file);
    });
}

function symlinkSync(target: unknown, linkPath: unknown): void {
    const linkTarget = String(target);
    const file = toAbsolute(linkPath, 'path');
    const current = ready();
    wrapCall('symlink', file, function (): void {
        current.symlink(linkTarget, file);
    });
}

function chmodSync(target: unknown, mode: unknown): void {
    const file = toAbsolute(target, 'path');
    const current = ready();
    wrapCall('chmod', file, function (): void {
        current.chmod(file, Number(mode) || 0);
    });
}

function truncateSync(target: unknown, length?: unknown): void {
    const file = toAbsolute(target, 'path');
    const size = length === undefined ? 0 : Number(length);
    const current = ready();
    wrapCall('truncate', file, function (): void {
        current.truncate(file, size);
    });
}

function utimesSync(target: unknown, atime: unknown, mtime: unknown): void {
    const file = toAbsolute(target, 'path');
    const current = ready();
    wrapCall('utime', file, function (): void {
        current.utimes(file, toMillis(atime), toMillis(mtime));
    });
}

function toMillis(value: unknown): number {
    if (value instanceof Date) {
        return value.getTime();
    }
    if (typeof value === 'number') {
        return value * 1000;
    }
    return Number(value) * 1000;
}

function accessSync(target: unknown): void {
    const file = toAbsolute(target, 'path');
    const current = ready();
    wrapCall('access', file, function (): void {
        if (!current.exists(file)) {
            throw createError('ENOENT', 'access', file);
        }
    });
}

function mkdtempSync(prefix: unknown): string {
    const base = toAbsolute(prefix, 'prefix');
    const current = ready();
    return wrapCall('mkdtemp', base, function (): string {
        return current.mkdtemp(base);
    });
}

// ------------------------------------------------------------------ fd 系列

interface OpenEntry {
    handle: FileHandle;
    path: string;
    readable: boolean;
    writable: boolean;
}

/** Node 的 fd 是小整数；0/1/2 留给 stdio，所以从 3 开始发。 */
const openEntries = new Map<number, OpenEntry>();
let nextDescriptor = 3;

function resolveEntry(descriptor: unknown, syscall: string): OpenEntry {
    const value = Number(descriptor);
    const entry = openEntries.get(value);
    if (entry === undefined) {
        throw createError('EBADF', syscall, String(descriptor));
    }
    return entry;
}

function openSync(target: unknown, flags?: unknown, mode?: unknown): number {
    void mode;
    const file = toAbsolute(target, 'path');
    const spec = parseFlag(flags);
    const current = ready();
    const options: OpenHandleOptions = {
        readable: spec.readable,
        writable: spec.writable,
        append: spec.append,
        exclusive: spec.exclusive,
        truncate: spec.truncate
    };
    const handle = wrapCall('open', file, function (): FileHandle {
        return current.openHandle(file, options);
    });
    const descriptor = nextDescriptor;
    nextDescriptor += 1;
    openEntries.set(descriptor, { handle: handle, path: file, readable: spec.readable, writable: spec.writable });
    return descriptor;
}

function closeSync(descriptor: unknown): void {
    const entry = resolveEntry(descriptor, 'close');
    openEntries.delete(Number(descriptor));
    wrapCall('close', entry.path, function (): void {
        entry.handle.close();
    });
}

function readSync(descriptor: unknown, buffer: unknown, offset?: unknown, length?: unknown, position?: unknown): number {
    const entry = resolveEntry(descriptor, 'read');
    if (!(buffer instanceof Uint8Array)) {
        throw new TypeError('The "buffer" argument must be an instance of Buffer, TypedArray, or DataView.');
    }
    const start = offset === undefined || offset === null ? 0 : Number(offset);
    const count = length === undefined || length === null ? buffer.length - start : Number(length);
    const data = wrapCall('read', entry.path, function (): Uint8Array {
        return entry.handle.read(position === undefined || position === null ? null : Number(position), count);
    });
    buffer.set(data, start);
    return data.length;
}

function writeSync(descriptor: unknown, data: unknown, a?: unknown, b?: unknown, c?: unknown): number {
    const entry = resolveEntry(descriptor, 'write');
    if (typeof data === 'string') {
        // Node 的字符串形式：writeSync(fd, string, position?, encoding?)
        const position = a === undefined || a === null ? null : Number(a);
        const encoding = b === undefined ? 'utf8' : String(b);
        const bytes = Buffer.from(data, encoding as BufferEncoding);
        return wrapCall('write', entry.path, function (): number {
            return entry.handle.write(position, bytes);
        });
    }
    if (!(data instanceof Uint8Array)) {
        throw new TypeError('The "buffer" argument must be an instance of Buffer, TypedArray, or DataView.');
    }
    const offset = a === undefined || a === null ? 0 : Number(a);
    const length = b === undefined || b === null ? data.length - offset : Number(b);
    const position = c === undefined || c === null ? null : Number(c);
    const slice = data.subarray(offset, offset + length);
    return wrapCall('write', entry.path, function (): number {
        return entry.handle.write(position, slice);
    });
}

function fstatSync(descriptor: unknown, options?: unknown): Stats {
    const entry = resolveEntry(descriptor, 'fstat');
    const throwIfNoEntry = options !== null && typeof options === 'object' &&
        (options as { throwIfNoEntry?: unknown }).throwIfNoEntry === false
        ? false
        : true;
    const current = ready();
    try {
        return new Stats(current.stat(entry.path, true));
    } catch (failure) {
        if (!throwIfNoEntry && isMissing(failure)) {
            return new Stats({
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
                size: entry.handle.size(),
                mode: 0o666,
                atimeMs: 0,
                mtimeMs: 0,
                ctimeMs: 0,
                birthtimeMs: 0
            });
        }
        throw withContext(failure, 'fstat', entry.path);
    }
}

function ftruncateSync(descriptor: unknown, length?: unknown): void {
    const entry = resolveEntry(descriptor, 'ftruncate');
    const size = length === undefined ? 0 : Number(length);
    wrapCall('ftruncate', entry.path, function (): void {
        entry.handle.truncate(size);
    });
}

function fsyncSync(descriptor: unknown): void {
    const entry = resolveEntry(descriptor, 'fsync');
    wrapCall('fsync', entry.path, function (): void {
        entry.handle.sync();
    });
}

// ------------------------------------------------------------------ 回调形式

type ErrorFirstCallback = (error: Error | null, ...rest: unknown[]) => void;

/**
 * 把同步面包装成 Node 的回调形式（最后一个参数是回调）。
 * 与 fs/promises 同样的取舍：宿主只有同步通道，所以是"接口异步、执行同步"。
 */
function withCallback(syncFunction: (...args: unknown[]) => unknown, args: unknown[]): void {
    const done = args[args.length - 1];
    if (typeof done !== 'function') {
        throw new TypeError('The "callback" argument must be of type function.');
    }
    const forward = args.slice(0, args.length - 1);
    queueMicrotask(function (): void {
        try {
            (done as ErrorFirstCallback)(null, syncFunction.apply(null, forward));
        } catch (failure) {
            (done as ErrorFirstCallback)(failure as Error);
        }
    });
}

function readFile(...args: unknown[]): void {
    withCallback(readFileSync, args);
}

function writeFile(...args: unknown[]): void {
    withCallback(writeFileSync, args);
}

function appendFile(...args: unknown[]): void {
    withCallback(appendFileSync, args);
}

function stat(...args: unknown[]): void {
    withCallback(statSync, args);
}

function lstat(...args: unknown[]): void {
    withCallback(lstatSync, args);
}

function readdir(...args: unknown[]): void {
    withCallback(readdirSync, args);
}

function mkdir(...args: unknown[]): void {
    withCallback(mkdirSync, args);
}

function rm(...args: unknown[]): void {
    withCallback(rmSync, args);
}

function unlink(...args: unknown[]): void {
    withCallback(unlinkSync, args);
}

function rmdir(...args: unknown[]): void {
    withCallback(rmdirSync, args);
}

function rename(...args: unknown[]): void {
    withCallback(renameSync, args);
}

function copyFile(...args: unknown[]): void {
    withCallback(copyFileSync, args);
}

function realpath(...args: unknown[]): void {
    withCallback(realpathSync, args);
}

function access(...args: unknown[]): void {
    withCallback(accessSync, args);
}

function mkdtemp(...args: unknown[]): void {
    withCallback(mkdtempSync, args);
}

function open(...args: unknown[]): void {
    withCallback(openSync, args);
}

function close(...args: unknown[]): void {
    withCallback(closeSync, args);
}

function read(...args: unknown[]): void {
    withCallback(readSync, args);
}

function write(...args: unknown[]): void {
    withCallback(writeSync, args);
}

function fstat(...args: unknown[]): void {
    withCallback(fstatSync, args);
}

function ftruncate(...args: unknown[]): void {
    withCallback(ftruncateSync, args);
}

function fsync(...args: unknown[]): void {
    withCallback(fsyncSync, args);
}

/** Node 的 fs.exists 回调只收一个布尔值，是唯一不带 error 的形态。 */
function exists(target: unknown, callback: unknown): void {
    if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function.');
    }
    const done = callback as (value: boolean) => void;
    queueMicrotask(function (): void {
        done(existsSync(target));
    });
}

// ------------------------------------------------------------------ 流式接口

/**
 * fs.createReadStream。
 *
 * 与 Node 的差异（本库的驱动层没有 fd 概念，因此是"按需整块读 + 切片下发"）：
 *   - 首次 _read 时把整个文件读进内存，之后按 highWaterMark 切片，
 *     所以内存占用不是流式的；
 *   - 'open' 事件仍会发，但参数是 null（没有真实 fd）。
 */
function createReadStream(target: unknown, options?: ReadStreamOptions): ReadStreamLike {
    const file = toAbsolute(target, 'path');
    const spec = parseFlag(options === undefined ? undefined : options.flags);
    if (!spec.readable) {
        throw createError('EBADF', 'open', file);
    }
    const highWaterMark = options !== undefined && typeof options.highWaterMark === 'number'
        ? options.highWaterMark
        : 65536;
    const startAt = options !== undefined && typeof options.start === 'number' ? options.start : 0;
    const endAt = options !== undefined && typeof options.end === 'number' ? options.end : Infinity;

    let opened = false;
    let failed = false;
    let position = startAt;
    let payload: Uint8Array | null = null;
    let readable: ReadStreamLike | null = null;

    const open = function (): void {
        const self = readable as ReadStreamLike;
        if (opened || failed) {
            return;
        }
        try {
            const current = ready();
            payload = wrapCall('open', file, function (): Uint8Array {
                return current.readFileBytes(file);
            });
            opened = true;
            // 没有真实 fd，'open' 的参数如实给 null
            self.emit('open', null);
        } catch (failure) {
            failed = true;
            self.destroy(failure as Error);
        }
    };

    readable = new streamModule.Readable({
        highWaterMark: highWaterMark,
        encoding: options === undefined ? undefined : options.encoding,
        read: function (this: unknown): void {
            const self = readable as ReadStreamLike;
            if (!opened) {
                open();
                if (!opened) {
                    return;
                }
            }
            const bytes = payload as Uint8Array;
            if (position >= bytes.length || position > endAt) {
                (self as unknown as { push(data: unknown): boolean }).push(null);
                return;
            }
            const upper = Math.min(bytes.length, endAt === Infinity ? bytes.length : endAt + 1, position + highWaterMark);
            (self as unknown as { push(data: unknown): boolean }).push(bytes.subarray(position, upper));
            position = upper;
        },
        destroy: function (this: unknown, error: Error | null, callback: (error?: Error | null) => void): void {
            callback(error);
        }
    });
    // 与 Node 一致：构造后就打开文件并发 'open'，因此只监听 'open' 的代码不会挂住
    schedule(function (): void {
        open();
    });
    return readable;
}

function schedule(task: () => void): void {
    queueMicrotask(task);
}

/**
 * fs.createWriteStream。
 *
 * 驱动层没有 fd，但写入语义可以保持流式：首次写按 flag 决定是否截断，
 * 之后逐块追加，内存占用与流式一致。
 */
function createWriteStream(target: unknown, options?: WriteStreamOptions): WriteStreamLike {
    const file = toAbsolute(target, 'path');
    // 写流的默认 flag 是 'w'（读流才是 'r'）—— 与 writeFileSync 同类，踩过一次
    const spec = parseFlag(options === undefined || options.flags === undefined ? 'w' : options.flags);
    if (!spec.writable) {
        throw createError('EBADF', 'write', file);
    }
    const highWaterMark = options !== undefined && typeof options.highWaterMark === 'number'
        ? options.highWaterMark
        : 16384;
    let wroteAny = false;

    let writable: WriteStreamLike | null = null;
    writable = new streamModule.Writable({
        highWaterMark: highWaterMark,
        write: function (chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void {
            try {
                const current = ready();
                const bytes = chunk instanceof Uint8Array
                    ? chunk
                    : Buffer.from(String(chunk), (encoding === 'buffer' ? 'utf8' : encoding) as BufferEncoding);
                const append = wroteAny || spec.append;
                const exclusive = !wroteAny && spec.exclusive;
                wrapCall('write', file, function (): void {
                    current.writeFileBytes(file, bytes, append, exclusive);
                });
                wroteAny = true;
                callback(null);
            } catch (failure) {
                callback(failure as Error);
            }
        },
        final: function (callback: (error?: Error | null) => void): void {
            // Node 的 'w' 即使一个字节都没写也会建出空文件
            if (!wroteAny && spec.truncate) {
                try {
                    const current = ready();
                    wrapCall('open', file, function (): void {
                        current.writeFileBytes(file, new Uint8Array(0), false, spec.exclusive);
                    });
                } catch (failure) {
                    callback(failure as Error);
                    return;
                }
            }
            callback(null);
        }
    });
    void writable;
    return writable;
}

// ------------------------------------------------------------------ 常量

const constants = {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4,
    // libuv 自己的那套镜像常量，Node 也导出
    UV_FS_COPYFILE_EXCL: 1,
    UV_FS_COPYFILE_FICLONE: 2,
    UV_FS_COPYFILE_FICLONE_FORCE: 4,
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 64,
    O_EXCL: 128,
    O_TRUNC: 512,
    O_APPEND: 1024,
    UV_FS_O_FILEMAP: 0,
    UV_FS_SYMLINK_DIR: 1,
    UV_FS_SYMLINK_JUNCTION: 2,
    UV_DIRENT_UNKNOWN: 0,
    UV_DIRENT_FILE: 1,
    UV_DIRENT_DIR: 2,
    UV_DIRENT_LINK: 3,
    UV_DIRENT_FIFO: 4,
    UV_DIRENT_SOCKET: 5,
    UV_DIRENT_CHAR: 6,
    UV_DIRENT_BLOCK: 7,
    // POSIX 文件类型与权限位（Linux/Android 的值）
    S_IFMT: 61440,
    S_IFREG: 32768,
    S_IFDIR: 16384,
    S_IFCHR: 8192,
    S_IFIFO: 4096,
    S_IFLNK: 40960,
    S_IRUSR: 256,
    S_IWUSR: 128,
    S_IXUSR: 64,
    S_IRGRP: 32,
    S_IWGRP: 16,
    S_IXGRP: 8,
    S_IROTH: 4,
    S_IWOTH: 2,
    S_IXOTH: 1
};

const fs = {
    /**
     * `require('fs').promises` —— 与 fs/promises 子路径**同一个对象**。
     *
     * 用惰性 getter 而不是直接 require：fs/promises 自己也 require fs，直接写会成环。
     * getter 在对象字面量里是可枚举的，所以 for...in 探测（safer-buffer 那种）也能看到它。
     */
    get promises(): unknown {
        return require('./fs/promises');
    },
    readFileSync: readFileSync,
    writeFileSync: writeFileSync,
    appendFileSync: appendFileSync,
    existsSync: existsSync,
    statSync: statSync,
    lstatSync: lstatSync,
    readdirSync: readdirSync,
    mkdirSync: mkdirSync,
    rmSync: rmSync,
    unlinkSync: unlinkSync,
    rmdirSync: rmdirSync,
    renameSync: renameSync,
    copyFileSync: copyFileSync,
    realpathSync: realpathSync,
    readlinkSync: readlinkSync,
    symlinkSync: symlinkSync,
    chmodSync: chmodSync,
    truncateSync: truncateSync,
    utimesSync: utimesSync,
    accessSync: accessSync,
    mkdtempSync: mkdtempSync,
    openSync: openSync,
    closeSync: closeSync,
    readSync: readSync,
    writeSync: writeSync,
    fstatSync: fstatSync,
    ftruncateSync: ftruncateSync,
    fsyncSync: fsyncSync,
    fdatasyncSync: fsyncSync,
    readFile: readFile,
    writeFile: writeFile,
    appendFile: appendFile,
    stat: stat,
    lstat: lstat,
    readdir: readdir,
    mkdir: mkdir,
    rm: rm,
    unlink: unlink,
    rmdir: rmdir,
    rename: rename,
    copyFile: copyFile,
    realpath: realpath,
    access: access,
    mkdtemp: mkdtemp,
    exists: exists,
    open: open,
    close: close,
    read: read,
    write: write,
    fstat: fstat,
    ftruncate: ftruncate,
    fsync: fsync,
    createReadStream: createReadStream,
    createWriteStream: createWriteStream,
    Stats: Stats,
    Dirent: Dirent,
    constants: constants,
    env: env
};

export = fs;
