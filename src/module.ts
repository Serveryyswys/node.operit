'use strict';

/**
 * module 模块（只取在 Operit 里说得通的部分）。
 *
 * 提供：
 *   - builtinModules：**与 BUILTINS.json 的键逐字一致**（包含尚未实现的那些，
 *     因为 isBuiltin 回答的是"这是不是一个 Node 内建名"，不是"我们实现了没有"）。
 *     测试里会断言两者同步，防止改契约表时漏改这里；
 *   - isBuiltin()：认 'node:' 前缀；
 *   - createRequire()：显式抛 ONJ_UNSUPPORTED。
 *
 * createRequire 为什么不做：它依赖 node_modules 逐级查找与 main/exports 解析，
 * 而 Operit 的 require 两样都没有（见 BUILTINS.json 的 packing 段）。
 * 与其给一个"看起来像但解析不出东西"的 require，不如明确拒绝。
 *
 * Module 类、_resolveFilename 等内部接口不提供。
 */

import { onjError } from './lib/errors';

const builtinModules = [
    '_http_agent',
    '_http_client',
    '_http_common',
    '_http_incoming',
    '_http_outgoing',
    '_http_server',
    '_stream_duplex',
    '_stream_passthrough',
    '_stream_readable',
    '_stream_transform',
    '_stream_wrap',
    '_stream_writable',
    '_tls_common',
    '_tls_wrap',
    'assert',
    'assert/strict',
    'async_hooks',
    'buffer',
    'child_process',
    'cluster',
    'console',
    'constants',
    'crypto',
    'dgram',
    'diagnostics_channel',
    'dns',
    'dns/promises',
    'domain',
    'events',
    'fs',
    'fs/promises',
    'http',
    'http2',
    'https',
    'inspector',
    'inspector/promises',
    'module',
    'net',
    'os',
    'path',
    'path/posix',
    'path/win32',
    'perf_hooks',
    'process',
    'punycode',
    'querystring',
    'readline',
    'repl',
    'stream',
    'stream/consumers',
    'stream/promises',
    'stream/web',
    'string_decoder',
    'sys',
    'timers',
    'timers/promises',
    'tls',
    'trace_events',
    'tty',
    'url',
    'util',
    'util/types',
    'v8',
    'vm',
    'wasi',
    'worker_threads',
    'zlib'
]

function isBuiltin(name: unknown): boolean {
    const text = String(name);
    const bare = text.indexOf('node:') === 0 ? text.slice(5) : text;
    return builtinModules.indexOf(bare) >= 0;
}

function createRequire(): never {
    throw onjError(
        'ONJ_UNSUPPORTED',
        'module.createRequire() 依赖 node_modules 逐级查找与 main/exports 解析，Operit 的 require 两者都没有；' +
        '打包期由 OperitPackageManager 把裸名重写成相对路径。'
    );
}

const api = {
    builtinModules: builtinModules,
    isBuiltin: isBuiltin,
    createRequire: createRequire
};

export = api;
