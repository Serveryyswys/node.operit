'use strict';

/**
 * 聚合入口（糖）。
 *
 * 正式契约是"一个 Node 内置名 = 一个子路径"，见 BUILTINS.json；
 * 本文件只把已实现的模块聚合成一个对象，方便手写代码时少写几行 require。
 *
 * 用法：
 *     const onj = require('<项目>/node_modules/@serveryyswys/node.operit/index.js');
 *     onj.path.join('a', 'b');
 *
 * 注意：stream 不在聚合里，因为它以类形式 `export =` 导出（`require('.../stream')` 返回
 * Stream 类本身），无法在 .d.ts 里被"命名"，加进来会让本文件的声明生成失败。
 * 需要它请直接引子路径。
 */

import pathPosixModule = require('./path/posix');
import pathWin32Module = require('./path/win32');
import eventsModule = require('./events');
import querystringModule = require('./querystring');
import stringDecoderModule = require('./string_decoder');
import utilModule = require('./util');
import assertModule = require('./assert');
import assertStrictModule = require('./assert/strict');
import streamModule = require('./stream');
import streamPromisesModule = require('./stream/promises');
import pathModule = require('./path');
import fsModule = require('./fs');
import fsPromisesModule = require('./fs/promises');
import bufferModule = require('./buffer');
import osModule = require('./os');
import processModule = require('./process');
import cryptoModule = require('./crypto');
import zlibModule = require('./zlib');
import childProcessModule = require('./child_process');
import urlModule = require('./url');
import timersModule = require('./timers');
import timersPromisesModule = require('./timers/promises');
import perfHooksModule = require('./perf_hooks');
import constantsModule = require('./constants');
import moduleModule = require('./module');
import ttyModule = require('./tty');
import httpModule = require('./http');
import httpsModule = require('./https');
import dnsModule = require('./dns');
import dnsPromisesModule = require('./dns/promises');
import consoleModule = require('./console');
import utilTypesModule = require('./util/types');
import sysModule = require('./sys');
import punycodeModule = require('./punycode');
import diagnosticsChannelModule = require('./diagnostics_channel');
import streamConsumersModule = require('./stream/consumers');
import v8Module = require('./v8');

const api = {
    version: '0.1.7',
    path: pathModule,
    'path/posix': pathPosixModule,
    'path/win32': pathWin32Module,
    events: eventsModule,
    querystring: querystringModule,
    string_decoder: stringDecoderModule,
    util: utilModule,
    assert: assertModule,
    'assert/strict': assertStrictModule,
    stream: streamModule,
    'stream/promises': streamPromisesModule,
    fs: fsModule,
    'fs/promises': fsPromisesModule,
    buffer: bufferModule,
    os: osModule,
    process: processModule,
    crypto: cryptoModule,
    zlib: zlibModule,
    child_process: childProcessModule,
    url: urlModule,
    timers: timersModule,
    'timers/promises': timersPromisesModule,
    perf_hooks: perfHooksModule,
    constants: constantsModule,
    module: moduleModule,
    tty: ttyModule,
    http: httpModule,
    https: httpsModule,
    dns: dnsModule,
    'dns/promises': dnsPromisesModule,
    console: consoleModule,
    'util/types': utilTypesModule,
    sys: sysModule,
    punycode: punycodeModule,
    diagnostics_channel: diagnosticsChannelModule,
    'stream/consumers': streamConsumersModule,
    v8: v8Module
};

export = api;
