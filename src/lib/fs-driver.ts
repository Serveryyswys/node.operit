'use strict';

/**
 * fs 的宿主驱动层：把"文件系统原语"与"Node 语义"分开。
 *
 * fs.ts 只做 Node 语义（选项解析、错误码、返回值形状），所有真正的 I/O 都走本接口。
 * 这样：
 *   - 桌面测试可以注入一个基于 Node fs 的驱动，从而**把 fs.ts 的语义与 Node 对拍**；
 *   - Java 相关的假设全部收敛在 createJavaDriver() 里，真机验证只需针对这一处。
 *
 * 驱动抛出的错误是 bridge 的中间态 Java 错误（带 code），由 fs.ts 补 syscall / path。
 */

import * as bridge from './bridge';
import { javaError, createError } from './errors';
import * as bytesCodec from './bytes';

export interface FileStat {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    mode: number;
    atimeMs: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
}

export interface DirectoryEntry {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
}

/** fd 语义下的打开选项，由 fs.ts 从 flag 解析后传入。 */
export interface OpenHandleOptions {
    readable: boolean;
    writable: boolean;
    append: boolean;
    exclusive: boolean;
    truncate: boolean;
}

/** 一个打开的句柄。position 为 null 表示"用当前位置并推进"，与 Node 的 fd 语义一致。 */
export interface FileHandle {
    read(position: number | null, length: number): Uint8Array;
    write(position: number | null, data: Uint8Array): number;
    size(): number;
    truncate(length: number): void;
    sync(): void;
    close(): void;
}

export interface FsDriver {
    openHandle(target: string, options: OpenHandleOptions): FileHandle;
    stat(target: string, followLinks: boolean): FileStat;
    exists(target: string): boolean;
    readdir(target: string): DirectoryEntry[];
    readFileBytes(target: string): Uint8Array;
    writeFileBytes(target: string, data: Uint8Array, append: boolean, exclusive: boolean): void;
    mkdir(target: string, recursive: boolean): string | undefined;
    remove(target: string, recursive: boolean, force: boolean): void;
    rename(from: string, to: string): void;
    copyFile(from: string, to: string): void;
    realpath(target: string): string;
    readlink(target: string): string;
    symlink(target: string, linkPath: string): void;
    chmod(target: string, mode: number): void;
    truncate(target: string, length: number): void;
    utimes(target: string, atimeMs: number, mtimeMs: number): void;
    mkdtemp(prefix: string): string;
}

let driver: FsDriver | null = null;

/** 宿主注入点：桌面测试用，传 null 恢复为 Operit Java 驱动。 */
export function setDriver(next: FsDriver | null): void {
    driver = next;
}

export function getDriver(): FsDriver {
    if (driver === null) {
        driver = createJavaDriver();
    }
    return driver;
}

// ------------------------------------------------------------------ Java 实现

const DEFAULT_MODE_FILE = 0o666;
const DEFAULT_MODE_DIR = 0o777;

/**
 * 基于 java.io.File / java.nio.file.Files / java.io.RandomAccessFile 的驱动。
 *
 * 通道选择（对应 DESIGN.md §6.3）：
 *   - 读：Files.readAllBytes(Path) 返回 byte[]，bridge 会展开成 JSON 数字数组，直接用
 *   - 写：RandomAccessFile.writeBytes(String) 写每个字符的低 8 位 —— 正好是 latin1 通道，
 *         避免了"把 JS 数组当 byte[] 参数传进去"这类未验证行为
 *
 * 已知近似（真机验证时要确认）：
 *   - atime / ctime / birthtime 都取 lastModified
 *   - mode 按类型给默认值，不反映真实权限位
 *   - readdir 不区分符号链接
 */
export function createJavaDriver(): FsDriver {
    function fileOf(target: string): unknown {
        return bridge.newInstance('java.io.File', [target]);
    }

    function pathOf(target: string): unknown {
        return bridge.callInstance(fileOf(target), 'toPath', []);
    }

    function callFile(target: string, method: string, args: readonly unknown[] = []): unknown {
        return bridge.callInstance(fileOf(target), method, args);
    }

    /**
     * 单次从 bridge 搬多少字节。
     *
     * 为什么必须分块：`Files.readAllBytes` 会把**整个文件**变成一个 JS 数字数组
     * 再经 JSON 传过来。1MB 的文件就是 ~106 万个元素的数组 + 几 MB 的 JSON 字符串，
     * 传输链路上任何一次 `apply` / 展开 / 递归转换都会爆栈（真机上 readFile 就炸在这里）。
     * 64KB 是安全且不至于太碎的量级。
     */
    const READ_CHUNK = 64 * 1024;

    function readAllBytes(target: string): Uint8Array {
        const handle = openHandle(target, { readable: true, writable: false, exclusive: false, truncate: false, append: false });
        try {
            const size = handle.size();
            if (size === 0) {
                return new Uint8Array(0);
            }
            const out = new Uint8Array(size);
            let offset = 0;
            while (offset < size) {
                const want = Math.min(READ_CHUNK, size - offset);
                const chunk = handle.read(offset, want);
                if (chunk.length === 0) {
                    break;
                }
                out.set(chunk, offset);
                offset += chunk.length;
            }
            if (offset !== size) {
                throw createError('EIO', 'read');
            }
            return out;
        } finally {
            handle.close();
        }
    }

    function writeAllBytes(target: string, data: Uint8Array, append: boolean, exclusive: boolean): void {
        if (exclusive && callFile(target, 'exists')) {
            throw javaError('java.nio.file.FileAlreadyExistsException: ' + target);
        }
        const handle = bridge.newInstance('java.io.RandomAccessFile', [target, 'rw']);
        try {
            if (append) {
                bridge.callInstance(handle, 'seek', [bridge.callInstance(handle, 'length', [])]);
            } else {
                bridge.callInstance(handle, 'setLength', [0]);
            }
            bridge.callInstance(handle, 'writeBytes', [bytesCodec.bytesToLatin1(data)]);
        } finally {
            bridge.callInstance(handle, 'close', []);
        }
    }

    function describe(target: string, followLinks: boolean): FileStat {
        if (!callFile(target, 'exists')) {
            throw javaError('java.io.FileNotFoundException: ' + target);
        }
        const isLink = followLinks ? false : bridge.normalizeBoolean(
            bridge.callStatic('java.nio.file.Files', 'isSymbolicLink', [pathOf(target)])
        );
        const isDirectory = bridge.normalizeBoolean(callFile(target, 'isDirectory'));
        const isFile = bridge.normalizeBoolean(callFile(target, 'isFile'));
        const size = Number(callFile(target, 'length')) || 0;
        const modified = Number(callFile(target, 'lastModified')) || 0;
        return {
            isFile: isFile,
            isDirectory: isDirectory,
            isSymbolicLink: isLink,
            size: isFile ? size : 0,
            mode: isDirectory ? DEFAULT_MODE_DIR : DEFAULT_MODE_FILE,
            atimeMs: modified,
            mtimeMs: modified,
            ctimeMs: modified,
            birthtimeMs: modified
        };
    }

    function removeRecursive(target: string): void {
        const handle = fileOf(target);
        if (!bridge.normalizeBoolean(bridge.callInstance(handle, 'exists', []))) {
            return;
        }
        if (bridge.normalizeBoolean(bridge.callInstance(handle, 'isDirectory', []))) {
            const children = bridge.callInstance(handle, 'listFiles', []);
            if (Array.isArray(children)) {
                for (let i = 0; i < children.length; i += 1) {
                    removeRecursive(String(bridge.callInstance(children[i], 'getAbsolutePath', [])));
                }
            }
        }
        bridge.callInstance(handle, 'delete', []);
    }

    /**
     * fd 句柄基于 java.io.RandomAccessFile：
     *   - 读：FileChannel.read(ByteBuffer, position) —— ByteBuffer.array() 能把数据**返回**出来，
     *     避免"把 byte[] 当参数传进去、靠 Java 原地修改"这种在 bridge 上不可见的行为；
     *   - 写：seek + writeBytes(String)，写每个字符的低 8 位，正好是 latin1 通道。
     */
    function openHandle(target: string, options: OpenHandleOptions): FileHandle {
        if (options.exclusive && bridge.normalizeBoolean(callFile(target, 'exists'))) {
            throw javaError('java.nio.file.FileAlreadyExistsException: ' + target);
        }
        const handle = bridge.newInstance('java.io.RandomAccessFile', [target, options.writable ? 'rw' : 'r']);
        const channel = bridge.callInstance(handle, 'getChannel', []);
        if (options.truncate) {
            bridge.callInstance(handle, 'setLength', [0]);
        }
        if (options.append) {
            bridge.callInstance(handle, 'seek', [bridge.callInstance(handle, 'length', [])]);
        }
        return {
            read(position: number | null, length: number): Uint8Array {
                if (length <= 0) {
                    return new Uint8Array(0);
                }
                const buffer = bridge.callStatic('java.nio.ByteBuffer', 'allocate', [length]);
                const start = position === null
                    ? Number(bridge.callInstance(handle, 'getFilePointer', []))
                    : position;
                const count = Number(bridge.callInstance(channel, 'read', [buffer, start]));
                if (position === null) {
                    bridge.callInstance(handle, 'seek', [start + (isFinite(count) ? count : 0)]);
                }
                if (!isFinite(count) || count <= 0) {
                    return new Uint8Array(0);
                }
                const raw = bridge.callInstance(buffer, 'array', []);
                if (!Array.isArray(raw)) {
                    return new Uint8Array(0);
                }
                const usable = Math.min(count, raw.length);
                const out = new Uint8Array(usable);
                for (let i = 0; i < usable; i += 1) {
                    out[i] = (raw[i] as number) & 255;
                }
                return out;
            },
            write(position: number | null, data: Uint8Array): number {
                const pointer = Number(bridge.callInstance(handle, 'getFilePointer', []));
                const start = position === null ? pointer : position;
                bridge.callInstance(handle, 'seek', [start]);
                bridge.callInstance(handle, 'writeBytes', [bytesCodec.bytesToLatin1(data)]);
                const advanced = Number(bridge.callInstance(handle, 'getFilePointer', []));
                if (position !== null) {
                    // Node 语义：带 position 的写不改变文件位置
                    bridge.callInstance(handle, 'seek', [pointer]);
                }
                return advanced - start;
            },
            size(): number {
                return Number(bridge.callInstance(handle, 'length', [])) || 0;
            },
            truncate(length: number): void {
                bridge.callInstance(handle, 'setLength', [length]);
            },
            sync(): void {
                bridge.callInstance(bridge.callInstance(handle, 'getFD', []), 'sync', []);
            },
            close(): void {
                bridge.callInstance(handle, 'close', []);
            }
        };
    }

    return {
        openHandle: openHandle,
        stat(target: string, followLinks: boolean): FileStat {
            return describe(target, followLinks);
        },
        exists(target: string): boolean {
            return bridge.normalizeBoolean(callFile(target, 'exists'));
        },
        readdir(target: string): DirectoryEntry[] {
            if (!bridge.normalizeBoolean(callFile(target, 'isDirectory'))) {
                if (callFile(target, 'exists')) {
                    throw javaError('java.nio.file.NotDirectoryException: ' + target);
                }
                throw javaError('java.io.FileNotFoundException: ' + target);
            }
            const children = callFile(target, 'listFiles');
            if (!Array.isArray(children)) {
                return [];
            }
            const out: DirectoryEntry[] = [];
            for (let i = 0; i < children.length; i += 1) {
                const child = children[i];
                out.push({
                    name: String(bridge.callInstance(child, 'getName', [])),
                    isFile: bridge.normalizeBoolean(bridge.callInstance(child, 'isFile', [])),
                    isDirectory: bridge.normalizeBoolean(bridge.callInstance(child, 'isDirectory', [])),
                    isSymbolicLink: false
                });
            }
            return out;
        },
        readFileBytes(target: string): Uint8Array {
            return readAllBytes(target);
        },
        writeFileBytes(target: string, data: Uint8Array, append: boolean, exclusive: boolean): void {
            writeAllBytes(target, data, append, exclusive);
        },
        mkdir(target: string, recursive: boolean): string | undefined {
            if (recursive) {
                const parent = bridge.callInstance(fileOf(target), 'getParent', []);
                const created = bridge.normalizeBoolean(callFile(target, 'mkdirs'));
                if (!created && !callFile(target, 'isDirectory')) {
                    throw javaError('java.io.IOException: Cannot create directory ' + target);
                }
                return created ? (typeof parent === 'string' ? target : target) : undefined;
            }
            const ok = bridge.normalizeBoolean(callFile(target, 'mkdir'));
            if (!ok) {
                if (callFile(target, 'exists')) {
                    throw javaError('java.nio.file.FileAlreadyExistsException: ' + target);
                }
                throw javaError('java.io.IOException: Cannot create directory ' + target);
            }
            return undefined;
        },
        remove(target: string, recursive: boolean, force: boolean): void {
            const handle = fileOf(target);
            if (!bridge.normalizeBoolean(bridge.callInstance(handle, 'exists', []))) {
                if (force) {
                    return;
                }
                throw javaError('java.io.FileNotFoundException: ' + target);
            }
            const isDirectory = bridge.normalizeBoolean(bridge.callInstance(handle, 'isDirectory', []));
            if (isDirectory && !recursive) {
                const children = bridge.callInstance(handle, 'listFiles', []);
                if (Array.isArray(children) && children.length > 0) {
                    throw javaError('java.nio.file.DirectoryNotEmptyException: ' + target);
                }
            }
            if (isDirectory && recursive) {
                removeRecursive(target);
                return;
            }
            bridge.callInstance(handle, 'delete', []);
        },
        rename(from: string, to: string): void {
            const moved = bridge.normalizeBoolean(bridge.callInstance(fileOf(from), 'renameTo', [fileOf(to)]));
            if (!moved) {
                throw javaError('java.io.IOException: Cannot rename ' + from + ' to ' + to);
            }
        },
        copyFile(from: string, to: string): void {
            writeAllBytes(to, readAllBytes(from), false, false);
        },
        realpath(target: string): string {
            const resolved = callFile(target, 'getCanonicalPath');
            if (typeof resolved !== 'string' || resolved.length === 0) {
                throw javaError('java.io.FileNotFoundException: ' + target);
            }
            return resolved;
        },
        readlink(target: string): string {
            const resolved = bridge.callStatic('java.nio.file.Files', 'readSymbolicLink', [pathOf(target)]);
            return String(bridge.callInstance(resolved, 'toString', []));
        },
        symlink(target: string, linkPath: string): void {
            bridge.callStatic('java.nio.file.Files', 'createSymbolicLink', [pathOf(linkPath), pathOf(target)]);
        },
        chmod(target: string, mode: number): void {
            callFile(target, 'setReadable', [(mode & 0o444) !== 0, false]);
            callFile(target, 'setWritable', [(mode & 0o222) !== 0, false]);
            callFile(target, 'setExecutable', [(mode & 0o111) !== 0, false]);
        },
        truncate(target: string, length: number): void {
            const handle = bridge.newInstance('java.io.RandomAccessFile', [target, 'rw']);
            try {
                bridge.callInstance(handle, 'setLength', [length]);
            } finally {
                bridge.callInstance(handle, 'close', []);
            }
        },
        utimes(target: string, atimeMs: number, mtimeMs: number): void {
            const ok = bridge.normalizeBoolean(callFile(target, 'setLastModified', [mtimeMs]));
            if (!ok) {
                throw javaError('java.io.IOException: Cannot set times on ' + target);
            }
        },
        mkdtemp(prefix: string): string {
            for (let attempt = 0; attempt < 64; attempt += 1) {
                const candidate = prefix + randomSuffix();
                if (!bridge.normalizeBoolean(callFile(candidate, 'exists'))) {
                    if (bridge.normalizeBoolean(callFile(candidate, 'mkdir'))) {
                        return candidate;
                    }
                }
            }
            throw javaError('java.io.IOException: Cannot create temp directory under ' + prefix);
        }
    };
}

const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(): string {
    let out = '';
    for (let i = 0; i < 6; i += 1) {
        out += SUFFIX_ALPHABET.charAt(Math.floor(Math.random() * SUFFIX_ALPHABET.length));
    }
    return out;
}
