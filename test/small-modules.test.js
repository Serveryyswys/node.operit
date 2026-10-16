'use strict';

/**
 * timers / timers/promises / perf_hooks / constants / module / tty 的对拍。
 *
 * 这几块都小，但真实包常用（debug 要 tty，supports-color 要 tty，
 * 各种重试逻辑要 promisify(setTimeout)），缺了会静默变成 {}。
 */

var nodeFs = require('fs');
var nodePath = require('path');
var nodeOs = require('os');
var nodeZlib = require('zlib');
var nodePerfHooks = require('perf_hooks');
var nodeTimersPromises = require('timers/promises');

var h = require('./harness.js');
var myUtil = require('../dist/util.js');
var myTimers = require('../dist/timers.js');
var myTimersPromises = require('../dist/timers/promises.js');
var myPerfHooks = require('../dist/perf_hooks.js');
var myConstants = require('../dist/constants.js');
var myModule = require('../dist/module.js');
var myTty = require('../dist/tty.js');
var contract = JSON.parse(nodeFs.readFileSync(nodePath.join(__dirname, '..', 'BUILTINS.json'), 'utf8'));

async function run() {
    h.section('timers');
    h.equal(myTimers.setTimeout === setTimeout, true, 'timers.setTimeout 就是全局 setTimeout');
    h.equal(myTimers.setInterval === setInterval, true, 'timers.setInterval 就是全局 setInterval');
    h.equal(myTimers.promises === myTimersPromises, true, 'timers.promises 与子路径是同一对象');
    h.equal(typeof myTimers.setImmediate, 'function', 'setImmediate 存在');

    var order = [];
    await new Promise(function (resolve) {
        myTimers.setImmediate(function () { order.push('immediate'); resolve(); });
        order.push('sync');
    });
    h.deepEqual(order, ['sync', 'immediate'], 'setImmediate 在同步代码之后执行');

    var cancelled = false;
    var handle = myTimers.setImmediate(function () { cancelled = true; });
    myTimers.clearImmediate(handle);
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    h.equal(cancelled, false, 'clearImmediate 生效');

    var sleep = myUtil.promisify(myTimers.setTimeout);
    var started = Date.now();
    await sleep(30);
    h.equal(Date.now() - started >= 25, true, 'promisify(setTimeout) 是能用的（靠 promisify.custom）');

    h.section('timers/promises');
    h.deepEqual(await myTimersPromises.setTimeout(1, 'v'), 'v', 'setTimeout 传递 value');
    h.deepEqual(await myTimersPromises.setImmediate('i'), 'i', 'setImmediate 传递 value');
    h.deepEqual(await myTimersPromises.setTimeout(1), undefined, '不传 value 时决议 undefined');
    h.equal(nodeTimersPromises.setTimeout !== undefined, true, '对照物存在');
    await myTimersPromises.scheduler.wait(5);
    await myTimersPromises.scheduler.yield();
    h.equal(true, true, 'scheduler.wait / yield 可等待');

    var ticks = [];
    for await (var tick of myTimersPromises.setInterval(5, 'tick')) {
        ticks.push(tick);
        if (ticks.length >= 3) {
            break;
        }
    }
    h.deepEqual(ticks, ['tick', 'tick', 'tick'], 'setInterval 产出 3 次后 break 能退出');

    var controller = new AbortController();
    var pending = myTimersPromises.setTimeout(50, 'x', { signal: controller.signal });
    controller.abort();
    var abortError = null;
    try {
        await pending;
    } catch (error) {
        abortError = error;
    }
    h.equal(abortError !== null && abortError.name === 'AbortError', true, 'signal 中止抛 AbortError');

    h.section('perf_hooks');
    h.equal(typeof myPerfHooks.performance.now(), 'number', 'now() 返回数字');
    h.equal(typeof myPerfHooks.performance.timeOrigin, 'number', 'timeOrigin 是数字');
    myPerfHooks.performance.clearMarks();
    myPerfHooks.performance.clearMeasures();
    myPerfHooks.performance.mark('m1');
    myPerfHooks.performance.measure('d1', 'm1');
    h.equal(myPerfHooks.performance.getEntriesByType('measure').length, 1, 'measure 产生一条条目');
    h.equal(myPerfHooks.performance.getEntriesByType('mark').some(function (entry) { return entry.name === 'm1'; }), true, 'mark 可查到');
    // options 形式：start / end 的数字当时间戳
    myPerfHooks.performance.measure('d2', { start: 10, end: 30 });
    var d2 = myPerfHooks.performance.getEntriesByName('d2')[0];
    h.equal(d2.startTime, 10, 'measure(options) 的数字当时间戳');
    h.equal(d2.duration, 20, 'measure(options) 的 duration');

    nodePerfHooks.performance.clearMarks();
    nodePerfHooks.performance.clearMeasures();
    nodePerfHooks.performance.measure('nd', { start: 10, end: 30 });
    var nd = nodePerfHooks.performance.getEntriesByName('nd')[0];
    h.deepEqual([d2.startTime, d2.duration], [nd.startTime, nd.duration], 'measure(options) 语义与 Node 一致');

    // 位置参数形式：两个参数只当 mark 名字，数字不当时间戳（实测 Node 就是如此）
    myPerfHooks.performance.measure('d3', 10, 30);
    var d3 = myPerfHooks.performance.getEntriesByName('d3')[0];
    h.equal(d3.startTime, 0, '位置参数形式里数字被当成 mark 名字 -> startTime 0');
    nodePerfHooks.performance.measure('nd3', 10, 30);
    var nd3 = nodePerfHooks.performance.getEntriesByName('nd3')[0];
    h.equal(nd3.startTime, 0, '对照：Node 的位置参数形式同样只认 mark 名字');

    myPerfHooks.performance.clearMarks();
    myPerfHooks.performance.clearMeasures();
    h.equal(myPerfHooks.performance.getEntries().length, 0, 'clearMarks / clearMeasures 清空');
    h.deepEqual(myPerfHooks.constants, nodePerfHooks.constants, 'perf_hooks.constants 与 Node 一致');

    h.section('constants');
    h.equal(myConstants.EACCES, nodeOs.constants.errno.EACCES, 'EACCES');
    h.equal(myConstants.ENOENT, nodeOs.constants.errno.ENOENT, 'ENOENT');
    h.equal(myConstants.SIGINT, nodeOs.constants.signals.SIGINT, 'SIGINT');
    h.deepEqual([myConstants.F_OK, myConstants.R_OK, myConstants.W_OK, myConstants.X_OK], [0, 4, 2, 1], 'F_OK / R_OK / W_OK / X_OK');
    var nodeMerged = Object.assign({}, nodeFs.constants, nodeOs.constants.signals, nodeOs.constants.errno, nodeOs.constants.priority, nodeZlib.constants);

    // 与平台无关的承诺清单：必须存在，且与 Node 的数值一致
    var promisedPortable = [
        'F_OK', 'R_OK', 'W_OK', 'X_OK',
        'O_RDONLY', 'O_WRONLY', 'O_RDWR',
        'COPYFILE_EXCL', 'COPYFILE_FICLONE',
        'S_IFMT', 'S_IFREG', 'S_IFDIR', 'S_IFLNK', 'S_IRUSR', 'S_IWUSR', 'S_IXUSR',
        'EACCES', 'ENOENT', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOSPC', 'EROFS', 'EBADF', 'EINVAL', 'EPERM',
        'SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGWINCH',
        'PRIORITY_NORMAL', 'PRIORITY_HIGH',
        'Z_NO_FLUSH', 'Z_FINISH', 'Z_BEST_COMPRESSION', 'Z_DEFAULT_COMPRESSION',
        'DEFLATE', 'INFLATE', 'GZIP', 'GUNZIP', 'UNZIP'
    ];
    var wrongValues = [];
    promisedPortable.forEach(function (key) {
        if (!(key in myConstants)) {
            wrongValues.push(key + '(缺失)');
            return;
        }
        if (key in nodeMerged && myConstants[key] !== nodeMerged[key]) {
            wrongValues.push(key + ' 本库 ' + myConstants[key] + ' Node ' + nodeMerged[key]);
        }
    });
    h.deepEqual(wrongValues, [], '平台无关的承诺常量都存在且与 Node 数值一致');

    // open(2) 的这几个标志是**平台相关**的：本库给 Linux/Android 的值
    // （O_CREAT=0o100），Node 在 Windows 上给的是另一套（O_CREAT=256）。
    // 与 pathToFileURL 一样，这是平台差异不是分歧。
    h.deepEqual(
        [myConstants.O_CREAT, myConstants.O_EXCL, myConstants.O_TRUNC, myConstants.O_APPEND],
        [0o100, 0o200, 0o1000, 0o2000],
        'O_CREAT / O_EXCL / O_TRUNC / O_APPEND 是 Linux 的值'
    );

    // 分歧普查：其余没提供的键分类列出来，看得见但不硬性失败。
    // WSA* / SIGBREAK 是 Windows 专有 —— Linux/Android 本来就该没有。
    var census = {};
    var other = [];
    Object.keys(nodeMerged).forEach(function (key) {
        if (key in myConstants) {
            return;
        }
        var group;
        if (/^WSA/.test(key) || key === 'SIGBREAK') {
            group = 'Windows 专有（Linux/Android 本就没有）';
        } else if (/^UV_/.test(key)) {
            group = 'libuv 内部常量';
        } else if (/^(BROTLI_|ZSTD_)/.test(key) || key === 'ZLIB_VERNUM') {
            group = 'Brotli / Zstd / 版本标记（未实现）';
        } else {
            group = '其它（主要是 errno 表待补全）';
            other.push(key);
        }
        census[group] = (census[group] || 0) + 1;
    });
    console.log('  常量覆盖情况（相对 Node on Windows）：');
    Object.keys(census).forEach(function (group) {
        console.log('    ' + group + ': ' + census[group] + ' 个键');
    });
    if (other.length > 0) {
        console.log('    「其它」示例: ' + other.slice(0, 8).join(', '));
    }
    var errnoKeys = Object.keys(nodeOs.constants.errno);
    var unexpected = other.filter(function (key) { return errnoKeys.indexOf(key) < 0; });
    h.deepEqual(unexpected, [], '「其它」缺口必须只来自 errno 表');

    h.section('module');
    h.equal(myModule.isBuiltin('fs'), true, 'isBuiltin(fs)');
    h.equal(myModule.isBuiltin('node:fs'), true, 'isBuiltin(node:fs)');
    h.equal(myModule.isBuiltin('nope'), false, 'isBuiltin(nope)');
    h.deepEqual(myModule.builtinModules.slice().sort(), Object.keys(contract.builtins).sort(),
        'builtinModules 与 BUILTINS.json 的键逐字一致');
    var createRequireError = null;
    try {
        myModule.createRequire('x');
    } catch (error) {
        createRequireError = error;
    }
    h.equal(createRequireError !== null && createRequireError.code === 'ONJ_UNSUPPORTED', true, 'createRequire 显式抛 ONJ_UNSUPPORTED');

    h.section('tty');
    h.equal(myTty.isatty(1), false, 'isatty 恒为 false');
    h.equal(myTty.isatty(0), false, 'isatty(0) 也是 false');
    var readError = null;
    try {
        new myTty.ReadStream();
    } catch (error) {
        readError = error;
    }
    h.equal(readError !== null && readError.code === 'ONJ_UNSUPPORTED', true, 'tty.ReadStream 显式抛 ONJ_UNSUPPORTED');

    h.section('刻意留空的部分');
    h.equal(myPerfHooks.PerformanceObserver, undefined, 'PerformanceObserver 未实现（不放假壳）');
    h.equal(myPerfHooks.monitorEventLoopDelay, undefined, 'monitorEventLoopDelay 未实现');
}

module.exports = { run: run };
