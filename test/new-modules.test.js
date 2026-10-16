'use strict';

/**
 * 0.1.3 补进来的模块：util/types、sys、punycode、console、diagnostics_channel、
 * stream/consumers、v8。
 *
 * 能对拍的一律与 Node 对拍（尤其是 console 的输出格式：我们改了格式化方式，
 * 必须证明与 Node 逐字节一致）。平台不成立的显式拒绝也要断言。
 */

var nodeStream = require('stream');
var nodeConsoleModule = require('console');
var nodeUtil = require('util');
var nodeDiagnostics = require('diagnostics_channel');
var nodeConsumers = require('stream/consumers');
var nodeV8 = require('v8');

var h = require('./harness.js');
var onj = require('../dist/index.js');
var streamModule = require('../dist/stream.js');
var bufferModule = require('../dist/buffer.js');

var Buffer = bufferModule.Buffer;

/**
 * 收集写入内容的输出流。
 *
 * 用真的 Writable 而不是只有 write 的假对象：Node 的 Console 会调
 * stream.removeListener / on，只给 write 会直接抛 TypeError。
 * 我们这边只要 write 就够（hasWrite 只检查 write），但两边用同一个流才谈得上对拍。
 */
function createSink() {
    var sink = new nodeStream.Writable({
        write: function (chunk, encoding, callback) {
            sink.chunks.push(String(chunk));
            callback();
        }
    });
    sink.chunks = [];
    return sink;
}

function readAll(stream) {
    return new Promise(function (resolve, reject) {
        var parts = [];
        stream.on('data', function (chunk) { parts.push(Buffer.from(chunk)); });
        stream.on('end', function () { resolve(Buffer.concat(parts).toString('utf8')); });
        stream.on('error', reject);
    });
}

async function run() {
    h.section('util/types 与 sys');
    h.equal(onj['util/types'] === onj.util.types, true, 'util/types 与 util.types 是同一个对象');
    h.equal(onj['util/types'].isDate(new Date()), true, 'util/types.isDate');
    h.equal(onj['util/types'].isRegExp(/x/), true, 'util/types.isRegExp');
    h.equal(onj.util.types.isPromise(Promise.resolve()), true, 'util/types.isPromise');
    h.equal(onj.sys === onj.util, true, 'sys 与 util 是同一个对象（与 Node 一致）');
    h.equal(onj.sys === require('../dist/sys.js'), true, 'sys 子路径与 index 上的 sys 一致');

    h.section('punycode（与 Node 对拍）');
    var nodePunycode = null;
    try {
        nodePunycode = require('punycode');
    } catch (error) {
        nodePunycode = null;
    }
    if (nodePunycode !== null) {
        var samples = ['mañana', '日本語', '中文', '☃-⌘', 'xn--maana-pta.com', '例え.テスト'];
        var mismatches = [];
        samples.forEach(function (sample) {
            [['toASCII', sample], ['toUnicode', sample], ['encode', 'mañana'], ['decode', 'maana-pta']].forEach(function (pair) {
                var method = pair[0];
                var input = pair[1];
                var mine = String(onj.punycode[method](input));
                var theirs = String(nodePunycode[method](input));
                if (mine !== theirs) {
                    mismatches.push(method + '(' + input + '): 本库 ' + mine + ' Node ' + theirs);
                }
            });
        });
        h.deepEqual(mismatches, [], 'punycode 各方法结果与 Node 一致');
        h.equal(onj.punycode.ucs2.decode('☃').length, nodePunycode.ucs2.decode('☃').length, 'ucs2.decode');
        h.equal(onj.punycode.ucs2.encode([0x2603]), nodePunycode.ucs2.encode([0x2603]), 'ucs2.encode');
    } else {
        h.equal(true, true, '（Node 未提供 punycode，跳过对拍）');
    }

    h.section('console：输出格式与 Node 逐字节对拍');
    var mySink = createSink();
    var theirSink = createSink();
    var myConsole = new onj.console.Console(mySink, mySink);
    var theirConsole = new nodeConsoleModule.Console(theirSink, theirSink);
    var cases = [
        function (c) { c.log('a', 1, { b: 2 }); },
        function (c) { c.log('%s=%d', 'x', 42); },
        function (c) { c.log('%j', { k: [1, 2] }); },
        function (c) { c.log(); },
        function (c) { c.info('info', true); },
        function (c) { c.warn('warn'); },
        function (c) { c.error('error'); },
        function (c) { c.debug('debug'); },
        function (c) { c.assert(true, '不该出现'); },
        function (c) { c.assert(false, 'fail %d', 1); },
        function (c) { c.dir({ a: 1 }); },
        function (c) { c.group('g'); c.log('inner'); c.groupEnd(); c.log('after'); },
        function (c) { c.log('占位 %s 与 %% 与 %d', 'x', 7); }
    ];
    cases.forEach(function (fn, index) {
        fn(myConsole);
        fn(theirConsole);
    });
    var myLines = mySink.chunks.join('');
    var theirLines = theirSink.chunks.join('');
    if (myLines !== theirLines) {
        h.equal(myLines, theirLines, 'console 输出与 Node 一致');
    } else {
        h.equal(myLines === theirLines, true, 'console 输出与 Node 逐字节一致（' + mySink.chunks.length + ' 条）');
    }
    h.equal(typeof onj.console.Console, 'function', '导出 Console 类');
    h.equal(typeof onj.console.table, 'function', '导出 table');
    h.equal(typeof onj.console.timeStamp, 'function', '导出 timeStamp');

    h.section('console：计数与计时');
    var countSink = createSink();
    var counter = new onj.console.Console(countSink, countSink);
    counter.count('c');
    counter.count('c');
    counter.countReset('c');
    counter.count('c');
    h.deepEqual(countSink.chunks.map(function (line) { return line.trim(); }), ['c: 1', 'c: 2', 'c: 0', 'c: 1'], 'count / countReset 输出');
    var timeSink = createSink();
    var timer = new onj.console.Console(timeSink, timeSink);
    timer.time('t');
    timer.timeEnd('t');
    h.equal(/^t: [0-9]+\.[0-9]{3}ms$/.test(timeSink.chunks[0].trim()), true, 'timeEnd 输出 ' + JSON.stringify(timeSink.chunks[0].trim()));

    h.section('diagnostics_channel（与 Node 对拍）');
    var received = [];
    var listener = function (message) { received.push(message); };
    onj.diagnostics_channel.subscribe('onj.test', listener);
    h.equal(onj.diagnostics_channel.channel('onj.test').hasSubscribers, true, 'hasSubscribers');
    h.equal(onj.diagnostics_channel.hasSubscribers('onj.test'), true, '顶层 hasSubscribers');
    onj.diagnostics_channel.channel('onj.test').publish('payload');
    h.deepEqual(received, ['payload'], 'publish 送达订阅者');
    onj.diagnostics_channel.unsubscribe('onj.test', listener);
    h.equal(onj.diagnostics_channel.channel('onj.test').hasSubscribers, false, 'unsubscribe 之后无订阅者');
    h.equal(onj.diagnostics_channel.channel('onj.test') === onj.diagnostics_channel.channel('onj.test'), true, '同名 channel 是同一个对象');
    h.equal(typeof nodeDiagnostics.Channel, 'function', '（Node 侧同样有 Channel，仅作对照）');
    var boundError = null;
    try {
        onj.diagnostics_channel.channel('x').bindStore({});
    } catch (error) {
        boundError = error;
    }
    h.equal(boundError !== null && boundError.code === 'ONJ_UNSUPPORTED', true, 'bindStore 显式抛 ONJ_UNSUPPORTED');

    h.section('stream/consumers（与 Node 对拍）');
    var payloadText = JSON.stringify({ hello: '世界', n: 3 });
    async function drain(factory) {
        var readable = new streamModule.Readable({
            read: function () {
                this.push(Buffer.from(payloadText));
                this.push(null);
            }
        });
        return factory(readable);
    }
    h.equal(await drain(function (r) { return onj['stream/consumers'].text(r); }), payloadText, 'text() 内容正确');
    h.deepEqual(await drain(function (r) { return onj['stream/consumers'].json(r); }), JSON.parse(payloadText), 'json() 解析正确');
    h.equal((await drain(function (r) { return onj['stream/consumers'].buffer(r); })).toString('utf8'), payloadText, 'buffer() 内容正确');
    var arrayBuf = await drain(function (r) { return onj['stream/consumers'].arrayBuffer(r); });
    h.equal(arrayBuf instanceof ArrayBuffer, true, 'arrayBuffer() 返回 ArrayBuffer');
    h.equal(Buffer.from(arrayBuf).toString('utf8'), payloadText, 'arrayBuffer() 内容正确');
    var blobError = await drain(function (r) { return onj['stream/consumers'].blob(r); }).then(function () { return null; }, function (e) { return e; });
    h.equal(blobError !== null && blobError.code === 'ONJ_UNSUPPORTED', true, 'blob() 显式抛 ONJ_UNSUPPORTED');
    h.equal(typeof nodeConsumers.text, 'function', '（Node 侧同样有 text，仅作对照）');

    h.section('v8');
    // v8 的堆统计要读 JVM，桌面测试按既有做法注入 mock backend
    var bridge = require('../dist/lib/bridge.js');
    bridge.setBackend({
        classExists: function () { return true; },
        callStatic: function (className, methodName) {
            if (className === 'java.lang.Runtime' && methodName === 'getRuntime') {
                return { __javaHandle: 'runtime', __javaClass: 'java.lang.Runtime' };
            }
            return null;
        },
        callInstance: function (instance, methodName) {
            if (methodName === 'totalMemory') { return 268435456; }
            if (methodName === 'freeMemory') { return 134217728; }
            if (methodName === 'maxMemory') { return 536870912; }
            return null;
        },
        newInstance: function () { return null; },
        getStaticField: function () { return null; },
        setStaticField: function () { return null; },
        getInstanceField: function () { return null; },
        setInstanceField: function () { return null; },
        getApplicationContext: function () { return null; },
        getCurrentActivity: function () { return null; },
        setEnv: function () { return undefined; }
    });
    h.deepEqual(Object.keys(onj.v8.getHeapStatistics()).sort(), Object.keys(nodeV8.getHeapStatistics()).sort(), 'getHeapStatistics 字段名与 Node 一致');
    var heap = onj.v8.getHeapStatistics();
    h.equal(typeof heap.total_heap_size === 'number' && heap.total_heap_size > 0, true, 'total_heap_size 为正数');
    h.equal(heap.used_heap_size <= heap.total_heap_size, true, 'used <= total');
    h.deepEqual(onj.v8.getHeapSpaceStatistics(), [], 'getHeapSpaceStatistics 返回空数组（QuickJS 不暴露分空间）');
    h.deepEqual(Object.keys(onj.v8.getHeapCodeStatistics()).sort(), Object.keys(nodeV8.getHeapCodeStatistics()).sort(), 'getHeapCodeStatistics 字段名与 Node 一致');
    var v8Unsupported = ['serialize', 'deserialize', 'setFlagsFromString', 'cachedDataVersionTag', 'writeHeapSnapshot', 'takeCoverage', 'stopCoverage'];
    var notThrown = v8Unsupported.filter(function (name) {
        try {
            onj.v8[name]();
            return true;
        } catch (error) {
            return error.code !== 'ONJ_UNSUPPORTED';
        }
    });
    h.deepEqual(notThrown, [], 'V8 专有能力全部显式抛 ONJ_UNSUPPORTED');
    bridge.setBackend(null);

    h.section('index 聚合导出与契约表同步');
    var contract = require('../BUILTINS.json');
    var contractKeys = Object.keys(contract.builtins).sort();
    // index 必须覆盖**所有已实现**的模块（unsupported / planned 没有可加载的实现，不进聚合）。
    // 这条断言就是为了抓住「实现了但忘了登记进 index 或契约表」那类漏项 —— dns/promises 就漏过一次。
    var implemented = contractKeys.filter(function (key) {
        var status = contract.builtins[key].status;
        return status !== 'unsupported' && status !== 'planned';
    });
    var exported = Object.keys(onj).sort().filter(function (key) { return key !== 'version'; });
    var missing = implemented.filter(function (key) { return exported.indexOf(key) < 0; });
    var extra = exported.filter(function (key) { return implemented.indexOf(key) < 0; });
    h.deepEqual(missing, [], 'index 没有漏掉任何已实现的模块');
    h.deepEqual(extra, [], 'index 没有多出契约表之外的键');
    h.deepEqual(onj.module.builtinModules.slice().sort(), contractKeys, 'module.builtinModules 与契约表一致');
    h.equal(onj.version, '0.1.3', 'version');
}

module.exports = { run: run };
