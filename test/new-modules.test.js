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
    h.equal(onj.version, require('../package.json').version, 'version');

    // 字段形态断言：契约表是打包器的唯一真源，字段名漂了会让打包器读不到拒绝理由
    // （vm / worker_threads 等早期条目曾用 reason，而后来加的是 note —— 就是这条抓的）。
    var shapeProblems = [];
    contractKeys.forEach(function (key) {
        var entry = contract.builtins[key];
        if (entry.subpath !== key) {
            shapeProblems.push(key + ': subpath=' + JSON.stringify(entry.subpath));
        }
        if (['ready', 'partial', 'planned', 'unsupported'].indexOf(entry.status) < 0) {
            shapeProblems.push(key + ': status=' + JSON.stringify(entry.status));
        }
        if (typeof entry.note !== 'string' || entry.note.length === 0) {
            shapeProblems.push(key + ': 缺少 note');
        }
        if (entry.reason !== undefined) {
            shapeProblems.push(key + ': 用了 reason 字段，应统一为 note');
        }
    });
    h.deepEqual(shapeProblems, [], '契约表字段形态一致（subpath / status / note）');
}

    h.section('常见继承目标（util.inherits 的直接受害者）');
    // 真实教训：pureimage / pngjs 这类库写 util.inherits(X, zlib.Zlib)，
    // 一旦那个导出是 undefined，抛的就是本库 util.inherits 的
    // "The superConstructor argument must be a function."，
    // 表面看不出是哪个模块缺了导出。这里把常见目标逐个真调一遍。
    var inheritTargets = [
        ['events', 'EventEmitter'],
        ['stream', 'Stream'],
        ['stream', 'Readable'],
        ['stream', 'Transform'],
        ['zlib', 'Zlib'],
        ['zlib', 'Deflate'],
        ['zlib', 'Inflate'],
        ['zlib', 'Gzip'],
        ['zlib', 'Gunzip'],
        ['zlib', 'DeflateRaw'],
        ['zlib', 'InflateRaw'],
        ['zlib', 'Unzip'],
        ['assert', 'AssertionError'],
        ['string_decoder', 'StringDecoder'],
        ['fs', 'Stats'],
        ['http', 'IncomingMessage'],
        ['http', 'ClientRequest']
    ];
    var brokenTargets = [];
    inheritTargets.forEach(function (pair) {
        var mod = onj[pair[0]];
        var target = mod === undefined ? undefined : mod[pair[1]];
        if (typeof target !== 'function') {
            brokenTargets.push(pair[0] + '.' + pair[1] + ' 是 ' + typeof target);
            return;
        }
        try {
            onj.util.inherits(function Probe() {}, target);
        } catch (error) {
            brokenTargets.push(pair[0] + '.' + pair[1] + ' 不能作为继承目标：' + error.message);
        }
    });
    h.deepEqual(brokenTargets, [], '所有常见继承目标都存在且可用');

    h.section('常被取值使用的成员');
    // onj.buffer 是 index 的聚合命名空间，不是模块本身；
    // 包在运行时 require('buffer') 拿到的是模块，所以按模块查。
    var bufferModuleForCheck = require('../dist/buffer.js');
    var memberChecks = [
        ['fs', 'promises', 'object'],
        ['fs', 'readFileSync', 'function'],
        ['bufferModule', 'SlowBuffer', 'function'],
        ['crypto', 'webcrypto', 'object'],
        ['crypto', 'webcrypto.getRandomValues', 'function'],
        ['util', 'types.isAnyArrayBuffer', 'function'],
        ['util/types', 'isAnyArrayBuffer', 'function']
    ];
    var missingMembers = [];
    memberChecks.forEach(function (check) {
        var names = check[1].split('.');
        var value = check[0] === 'bufferModule' ? bufferModuleForCheck : onj[check[0]];
        for (var i = 0; i < names.length && value !== undefined && value !== null; i += 1) {
            value = value[names[i]];
        }
        if (typeof value !== check[2]) {
            missingMembers.push(check[0] + '.' + check[1] + ' 是 ' + typeof value + '，期望 ' + check[2]);
        }
    });
    h.deepEqual(missingMembers, [], '常用成员齐备');
    h.equal(onj.fs.promises.readFile === require('../dist/fs/promises.js').readFile, true, 'fs.promises 与 fs/promises 是同一套实现');
    h.section('大文件读取必须分块搬运');
    // 真机故障：readFile 读 1039KB 文件爆栈。原因是 Files.readAllBytes 一次性把
    // 整个文件变成 ~106 万个元素的 JS 数组 + 几 MB 的 JSON 字符串，
    // 传输链路上任何一次 apply / 展开 / 递归转换都会炸。
    // 这里直接打 bridge backend（而不是注入 driver），才能覆盖真正的 Java driver。
    var bridgeForDriver = require('../dist/lib/bridge.js');
    var fsDriverModule = require('../dist/lib/fs-driver.js');
    var bigSize = 1039 * 1024;
    var maxTransfer = 0;
    var transfers = 0;
    var fakeBytes = new Uint8Array(bigSize);
    for (var bi = 0; bi < bigSize; bi += 1) { fakeBytes[bi] = bi & 0xff; }
    var handles = { length: bigSize, channel: {} };
    bridgeForDriver.setBackend({
        classExists: function () { return true; },
        callStatic: function (className, methodName, args) {
            if (className === 'java.nio.ByteBuffer' && methodName === 'allocate') {
                var size = Number(args[0]);
                maxTransfer = Math.max(maxTransfer, size);
                transfers += 1;
                return { allocated: size };
            }
            return null;
        },
        callInstance: function (instance, methodName, args) {
            if (methodName === 'getChannel') { return handles.channel; }
            if (methodName === 'length') { return bigSize; }
            if (methodName === 'read') {
                var buffer = args[0];
                var position = Number(args[1]);
                var want = Math.min(Number(buffer.allocated), bigSize - position);
                buffer.bytes = fakeBytes.subarray(position, position + want);
                return want;
            }
            if (methodName === 'array') {
                return Array.prototype.slice.call(instance.bytes);
            }
            return null;
        },
        newInstance: function () { return {}; },
        getStaticField: function () { return null; },
        setStaticField: function () { return null; },
        getInstanceField: function () { return null; },
        setInstanceField: function () { return null; },
        getApplicationContext: function () { return null; },
        getCurrentActivity: function () { return null; },
        setEnv: function () { return undefined; }
    });
    fsDriverModule.setDriver(null); // 强制用 backend 重建 Java driver
    var bigRead = null;
    var bigError = null;
    try {
        bigRead = require('../dist/fs.js').readFileSync('/big.bin');
    } catch (error) {
        bigError = error;
    }
    h.equal(bigError, null, '1MB 读取不抛错' + (bigError === null ? '' : '：' + bigError.message));
    h.equal(bigRead === null ? -1 : bigRead.length, bigSize, '1MB 内容读全');
    h.ok(maxTransfer <= 64 * 1024, '单次搬运不超过 64KB（实际 ' + maxTransfer + '，共 ' + transfers + ' 次）');
    h.equal(bigRead === null ? -1 : bigRead[bigSize - 1], (bigSize - 1) & 0xff, '末尾字节正确');
    bridgeForDriver.setBackend(null);
    fsDriverModule.setDriver(null);

    h.section('老式继承：不用 new 直接调用父类');
    // 真实故障：pngjs 写 util.inherits(PNG, Stream) + Stream.call(this)，
    // 在 Node 上合法（Stream 是普通函数），class 写法则抛
    // "class constructors must be invoked with 'new'"（QuickJS 措辞）。
    var legacyBroken = [];
    [
        ['events', 'EventEmitter'],
        ['stream', 'Stream'],
        ['stream', 'Readable'],
        ['stream', 'Writable'],
        ['stream', 'Duplex'],
        ['stream', 'Transform'],
        ['stream', 'PassThrough'],
        ['zlib', 'Zlib'],
        ['zlib', 'Gzip'],
        ['zlib', 'Deflate'],
        ['string_decoder', 'StringDecoder']
    ].forEach(function (pair) {
        var parent = onj[pair[0]][pair[1]];
        try {
            parent.call({});
        } catch (error) {
            legacyBroken.push(pair.join('.') + ' -> ' + error.message);
        }
    });
    h.deepEqual(legacyBroken, [], '父类可以被 .call(this) 调用');

    var LegacyEmitter = function LegacyEmitter() { onj.events.EventEmitter.call(this); };
    onj.util.inherits(LegacyEmitter, onj.events.EventEmitter);
    var legacyInstance = new LegacyEmitter();
    var pinged = 0;
    legacyInstance.on('ping', function () { pinged += 1; });
    legacyInstance.emit('ping');
    h.equal(pinged, 1, 'util.inherits + 父类 .call 之后事件系统可用');

    var LegacyStream = function LegacyStream() { onj.stream.Stream.call(this); };
    onj.util.inherits(LegacyStream, onj.stream.Stream);
    h.equal(typeof new LegacyStream().on, 'function', '老式继承 stream.Stream 后拿到 EventEmitter 方法');

    // Readable/Writable 的构造体还要搬 options，且类字段（readable/writable = true）
    // 也是构造的一部分 —— 抽初始化时最容易漏的就是这些，所以按真实用法验一遍。
    var LegacyTransform = function LegacyTransform(options) { onj.stream.Transform.call(this, options); };
    onj.util.inherits(LegacyTransform, onj.stream.Transform);
    var legacyTransform = new LegacyTransform({
        transform: function (chunk, encoding, callback) { callback(null, chunk); }
    });
    h.equal(legacyTransform.readable, true, '老式继承的 Transform 具备可读侧');
    h.equal(legacyTransform.writable, true, '老式继承的 Transform 具备可写侧');
    h.equal(typeof legacyTransform.write, 'function', '老式继承的 Transform 有 write 方法');
    h.equal(typeof legacyTransform._transform, 'function', 'options.transform 被搬到 _transform');

    // getRandomValues 的真随机源来自宿主（Java 的 UUID.randomUUID）。
    // 桌面环境下宿主不可用，这里断言**它显式拒绝**而不是静默填零 ——
    // 静默返回全零的随机数是最危险的失败方式。
    var rand = new Uint8Array(16);
    var randomError = null;
    try {
        onj.crypto.webcrypto.getRandomValues(rand);
    } catch (error) {
        randomError = error;
    }
    h.ok(randomError !== null, '无宿主时 getRandomValues 显式抛错');
    h.equal(randomError === null ? '' : randomError.code, 'ONJ_MISSING_HOST', '抛的是 ONJ_MISSING_HOST');

module.exports = { run: run };
