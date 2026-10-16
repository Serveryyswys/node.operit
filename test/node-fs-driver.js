'use strict';

/**
 * 测试专用驱动：用 Node 自己的 fs 实现 FsDriver 接口。
 *
 * 存在的意义：把 fs.ts 的 Node 语义层与 Node 本身对拍。
 * 它把 Node 的错误重新包装成 bridge 的"中间态 Java 错误"（isJavaError），
 * 好让 fs.ts 走与真机完全相同的错误映射路径。
 */

var nodeFs = require('fs');

function javaClassFor(code) {
    switch (code) {
        case 'ENOENT': return 'java.io.FileNotFoundException';
        case 'EACCES':
        case 'EPERM': return 'java.nio.file.AccessDeniedException';
        case 'EEXIST': return 'java.nio.file.FileAlreadyExistsException';
        case 'ENOTDIR': return 'java.nio.file.NotDirectoryException';
        case 'ENOTEMPTY': return 'java.nio.file.DirectoryNotEmptyException';
        case 'EISDIR': return 'java.io.IOException';
        case 'ENOSPC': return 'java.io.IOException';
        default: return 'java.io.IOException';
    }
}

function intermediate(error) {
    var code = error && error.code ? error.code : 'EIO';
    var out = new Error(error && error.message ? error.message : String(error));
    out.code = code;
    out.javaClass = javaClassFor(code);
    out.javaMessage = out.message;
    out.isJavaError = true;
    return out;
}

function guard(body) {
    try {
        return body();
    } catch (error) {
        throw intermediate(error);
    }
}

function toBytes(value) {
    var copy = new Uint8Array(value.length);
    copy.set(value);
    return copy;
}

function createNodeDriver() {
    return {
        openHandle: function (target, options) {
            var flags;
            if (options.writable && options.readable) {
                flags = options.truncate ? 'w+' : (options.append ? 'a+' : 'r+');
            } else if (options.writable) {
                flags = options.truncate ? 'w' : (options.append ? 'a' : 'r+');
            } else {
                flags = 'r';
            }
            if (options.exclusive) {
                flags += 'x';
            }
            var fd = nodeFs.openSync(target, flags);
            return {
                read: function (position, length) {
                    var buffer = Buffer.alloc(length);
                    var count = nodeFs.readSync(fd, buffer, 0, length, position === null ? null : position);
                    var out = Buffer.alloc(count);
                    buffer.copy(out, 0, 0, count);
                    return new Uint8Array(out);
                },
                write: function (position, data) {
                    return nodeFs.writeSync(fd, Buffer.from(data), 0, data.length, position === null ? null : position);
                },
                size: function () {
                    return nodeFs.fstatSync(fd).size;
                },
                truncate: function (length) {
                    nodeFs.ftruncateSync(fd, length);
                },
                sync: function () {
                    nodeFs.fsyncSync(fd);
                },
                close: function () {
                    nodeFs.closeSync(fd);
                }
            };
        },
        stat: function (target, followLinks) {
            return guard(function () {
                var raw = followLinks ? nodeFs.statSync(target) : nodeFs.lstatSync(target);
                return {
                    isFile: raw.isFile(),
                    isDirectory: raw.isDirectory(),
                    isSymbolicLink: raw.isSymbolicLink(),
                    size: raw.size,
                    mode: raw.mode,
                    atimeMs: raw.atimeMs,
                    mtimeMs: raw.mtimeMs,
                    ctimeMs: raw.ctimeMs,
                    birthtimeMs: raw.birthtimeMs
                };
            });
        },
        exists: function (target) {
            return nodeFs.existsSync(target);
        },
        readdir: function (target) {
            return guard(function () {
                return nodeFs.readdirSync(target).map(function (name) {
                    var raw = nodeFs.lstatSync(target + '/' + name);
                    return {
                        name: name,
                        isFile: raw.isFile(),
                        isDirectory: raw.isDirectory(),
                        isSymbolicLink: raw.isSymbolicLink()
                    };
                });
            });
        },
        readFileBytes: function (target) {
            return guard(function () {
                return toBytes(nodeFs.readFileSync(target));
            });
        },
        writeFileBytes: function (target, data, append, exclusive) {
            return guard(function () {
                if (exclusive && nodeFs.existsSync(target)) {
                    var conflict = new Error('EEXIST: file already exists, open ' + target);
                    conflict.code = 'EEXIST';
                    throw conflict;
                }
                nodeFs.writeFileSync(target, Buffer.from(data), { flag: append ? 'a' : 'w' });
            });
        },
        mkdir: function (target, recursive) {
            return guard(function () {
                var created = nodeFs.mkdirSync(target, { recursive: recursive });
                return created === undefined ? undefined : String(created);
            });
        },
        remove: function (target, recursive, force) {
            return guard(function () {
                if (!nodeFs.existsSync(target)) {
                    if (force) {
                        return;
                    }
                    var missing = new Error('ENOENT: no such file or directory, rm ' + target);
                    missing.code = 'ENOENT';
                    throw missing;
                }
                if (recursive) {
                    nodeFs.rmSync(target, { recursive: true, force: true });
                    return;
                }
                var raw = nodeFs.lstatSync(target);
                if (raw.isDirectory()) {
                    nodeFs.rmdirSync(target);
                } else {
                    nodeFs.unlinkSync(target);
                }
            });
        },
        rename: function (from, to) {
            return guard(function () {
                nodeFs.renameSync(from, to);
            });
        },
        copyFile: function (from, to) {
            return guard(function () {
                nodeFs.copyFileSync(from, to);
            });
        },
        realpath: function (target) {
            return guard(function () {
                return nodeFs.realpathSync(target);
            });
        },
        readlink: function (target) {
            return guard(function () {
                return nodeFs.readlinkSync(target);
            });
        },
        symlink: function (target, linkPath) {
            return guard(function () {
                nodeFs.symlinkSync(target, linkPath);
            });
        },
        chmod: function (target, mode) {
            return guard(function () {
                nodeFs.chmodSync(target, mode);
            });
        },
        truncate: function (target, length) {
            return guard(function () {
                nodeFs.truncateSync(target, length);
            });
        },
        utimes: function (target, atimeMs, mtimeMs) {
            return guard(function () {
                nodeFs.utimesSync(target, atimeMs / 1000, mtimeMs / 1000);
            });
        },
        mkdtemp: function (prefix) {
            return guard(function () {
                return nodeFs.mkdtempSync(prefix);
            });
        }
    };
}

module.exports = { createNodeDriver: createNodeDriver, intermediate: intermediate };
