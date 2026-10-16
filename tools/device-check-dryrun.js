'use strict';

/**
 * tools/device-check.js 的桌面试跑。
 *
 * 目的不是验证 Java 行为（那只能在真机上验），而是验证**脚本本身**：
 * 每一处探测都要能跑完、JSON 信封解析要对、单项失败不能把整篇带崩、
 * 最后一定要打印报告。一个在真机上中途崩掉的自检脚本等于浪费用户一次机会。
 *
 * 桩只实现少量方法，所以大部分探测会 FAIL —— 那是预期，不是问题。
 */

var fs = require('fs');
var path = require('path');

var handles = new Map();
var counter = 0;
var calls = [];

function makeHandle(value) {
    counter += 1;
    var id = 'h' + counter;
    handles.set(id, value);
    return id;
}

function unwrap(id) {
    return handles.get(id);
}

function ok(data) {
    return JSON.stringify({ success: true, data: data === undefined ? null : data });
}

function fail(message) {
    return JSON.stringify({ success: false, error: 'java.lang.RuntimeException', message: message });
}

globalThis.NativeInterface = {
    javaClassExists: function (name) { return name !== 'com.onj.NoSuchClass'; },
    javaCallStatic: function (className, methodName, argsJson) {
        calls.push(className + '.' + methodName);
        var args = JSON.parse(argsJson);
        if (className === 'java.lang.System' && methodName === 'currentTimeMillis') { return ok(Date.now()); }
        if (className === 'java.lang.System' && methodName === 'getProperty') { return ok('17.0'); }
        if (className === 'java.lang.System') { return fail('no such method'); }
        if (className === 'java.util.UUID' && methodName === 'randomUUID') {
            return ok('4f2a1b3c-9d8e-4f7a-8b6c-1d2e3f4a5b6c');
        }
        if (className === 'java.util.Arrays' && methodName === 'asList') {
            return ok(makeHandle({ kind: 'list', items: args[0] }));
        }
        if (className === 'java.lang.Runtime' && methodName === 'getRuntime') {
            return ok(makeHandle({ kind: 'runtime' }));
        }
        if (className === 'java.lang.ProcessBuilder') { return ok(makeHandle({ kind: 'builder' })); }
        if (className === 'java.nio.file.Files' && methodName === 'readAllBytes') {
            var pathHandle = unwrap(args[0]);
            var data = fs.readFileSync(pathHandle.path);
            var numbers = [];
            for (var i = 0; i < data.length; i += 1) { numbers.push(data[i]); }
            return ok(numbers);
        }
        if (className === 'java.nio.file.Files' && methodName === 'isSymbolicLink') { return ok(false); }
        if (className === 'java.nio.ByteBuffer' && methodName === 'allocate') {
            return ok(makeHandle({ kind: 'bytebuffer', bytes: new Uint8Array(args[0]) }));
        }
        if (className === 'java.net.InetAddress') { return ok(makeHandle({ kind: 'inet', address: args[0] })); }
        return fail('桩未实现 ' + className + '.' + methodName);
    },
    javaNewInstance: function (className, argsJson) {
        calls.push('new ' + className);
        var args = JSON.parse(argsJson);
        if (className === 'java.io.File') { return ok(makeHandle({ kind: 'file', path: args[0] })); }
        if (className === 'java.io.RandomAccessFile') {
            return ok(makeHandle({ kind: 'raf', path: args[0], position: 0 }));
        }
        if (className === 'java.nio.file.Files' || className === 'java.util.Scanner') {
            return ok(makeHandle({ kind: 'opaque' }));
        }
        return fail('桩未实现 new ' + className);
    },
    javaCallInstance: function (handle, methodName, argsJson) {
        calls.push('instance.' + methodName);
        var args = JSON.parse(argsJson);
        var target = unwrap(handle);
        if (target === undefined) { return fail('未知句柄 ' + handle); }
        if (target.kind === 'list' && methodName === 'size') { return ok(target.items.length); }
        if (target.kind === 'runtime' && methodName === 'availableProcessors') { return ok(8); }
        if (target.kind === 'runtime' && methodName === 'freeMemory') { return ok(123456789); }
        if (target.kind === 'inet') {
            if (methodName === 'getHostAddress') { return ok(target.address); }
            if (methodName === 'getCanonicalHostName') { return ok('mock-host'); }
        }
        if (target.kind === 'file' && methodName === 'getAbsolutePath') { return ok(target.path); }
        if (target.kind === 'file' && methodName === 'getCanonicalPath') { return ok(target.path); }
        if (target.kind === 'file' && methodName === 'exists') { return ok(fs.existsSync(target.path)); }
        if (target.kind === 'file' && methodName === 'isDirectory') { return ok(fs.existsSync(target.path) && fs.statSync(target.path).isDirectory()); }
        if (target.kind === 'file' && methodName === 'isFile') { return ok(fs.existsSync(target.path) && fs.statSync(target.path).isFile()); }
        if (target.kind === 'file' && methodName === 'length') { return ok(fs.existsSync(target.path) ? fs.statSync(target.path).size : 0); }
        if (target.kind === 'file' && methodName === 'lastModified') { return ok(Date.now()); }
        if (target.kind === 'file' && methodName === 'toPath') { return ok(makeHandle({ kind: 'path', path: target.path })); }
        if (target.kind === 'file' && methodName === 'mkdirs') { fs.mkdirSync(target.path, { recursive: true }); return ok(true); }
        if (target.kind === 'file' && methodName === 'mkdir') { try { fs.mkdirSync(target.path); return ok(true); } catch (e) { return ok(false); } }
        if (target.kind === 'file' && methodName === 'listFiles') { return ok([]); }
        if (target.kind === 'file' && methodName === 'delete') { return ok(true); }
        if (target.kind === 'file' && methodName === 'getName') { return ok(path.basename(target.path)); }
        if (target.kind === 'file' && methodName === 'getParent') { return ok(path.dirname(target.path)); }
        if (target.kind === 'file' && methodName === 'renameTo') { return ok(false); }
        if (target.kind === 'file' && methodName === 'getChannel') { return ok(makeHandle({ kind: 'channel', path: target.path })); }
        if (target.kind === 'raf') {
            if (methodName === 'length') { return ok(fs.existsSync(target.path) ? fs.statSync(target.path).size : 0); }
            if (methodName === 'getFilePointer') { return ok(target.position); }
            if (methodName === 'seek') { target.position = Number(args[0]); return ok(null); }
            if (methodName === 'setLength') {
                if (fs.existsSync(target.path)) { fs.truncateSync(target.path, Number(args[0])); }
                else { fs.writeFileSync(target.path, ''); fs.truncateSync(target.path, Number(args[0])); }
                return ok(null);
            }
            if (methodName === 'writeBytes') {
                var text = String(args[0]);
                var buffer = Buffer.alloc(text.length);
                for (var i = 0; i < text.length; i += 1) { buffer[i] = text.charCodeAt(i) & 255; }
                var existing = fs.existsSync(target.path) ? fs.readFileSync(target.path) : Buffer.alloc(0);
                var size = Math.max(existing.length, target.position + buffer.length);
                var merged = Buffer.alloc(size);
                existing.copy(merged, 0);
                buffer.copy(merged, target.position);
                fs.writeFileSync(target.path, merged);
                target.position += buffer.length;
                return ok(null);
            }
            if (methodName === 'close') { return ok(null); }
            if (methodName === 'getFD') { return ok(makeHandle({ kind: 'opaque' })); }
        }
        if (target.kind === 'channel' && methodName === 'read') {
            var targetBuffer = unwrap(args[0]);
            var start = Number(args[1]);
            var fileData = fs.existsSync(target.path) ? fs.readFileSync(target.path) : Buffer.alloc(0);
            var count = Math.max(0, Math.min(targetBuffer.bytes.length, fileData.length - start));
            for (var j = 0; j < count; j += 1) { targetBuffer.bytes[j] = fileData[start + j]; }
            return ok(count);
        }
        if (target.kind === 'bytebuffer' && methodName === 'array') {
            return ok(Array.from(target.bytes));
        }
        if (target.kind === 'opaque' && methodName === 'sync') { return ok(null); }
        return fail('桩未实现 ' + target.kind + '.' + methodName);
    },
    javaGetApplicationContext: function () { return ok(null); },
    javaGetCurrentActivity: function () { return ok(null); }
};

globalThis.toolCall = function (name) {
    return Promise.resolve({ url: 'https://example.com/', statusCode: 200, statusMessage: 'OK', headers: {}, content: '', contentBase64: null, size: 0 });
};
// 假配置目录放在工作区内，否则文件操作会被沙箱拦掉，冒烟测试就验不出来
var fakeRoot = path.join(__dirname, '..', '.device-check-demo');
globalThis.getPluginConfigDir = function (id) { return path.join(fakeRoot, id === '' ? 'demo' : id); };
globalThis.OPERIT_DOWNLOAD_DIR = path.join(fakeRoot, 'download');
globalThis.OPERIT_CLEAN_ON_EXIT_DIR = path.join(fakeRoot, 'clean');
globalThis.getEnv = function (key) { return undefined; };
globalThis.getState = function () { return 'idle'; };
globalThis.getLang = function () { return 'zh'; };

// 入口路径指向本机的 dist，让「加载 node.operit」那一项在桌面也能跑
globalThis.ONJ_LIB_PATH = path.join(__dirname, '..', 'dist', 'index.js');

var logs = [];
var originalLog = console.log;
console.log = function () {
    logs.push(Array.prototype.slice.call(arguments).join(' '));
};

require('./device-check.js');

setTimeout(function () {
    console.log = originalLog;
    var text = logs.join('\n');
    var hasReport = text.indexOf('真机自检报告') >= 0;
    var summaryMatch = /通过 (\d+) \/ 失败 (\d+) \/ 跳过 (\d+)/.exec(text);
    var total = summaryMatch === null ? 0 : Number(summaryMatch[1]) + Number(summaryMatch[2]) + Number(summaryMatch[3]);

    originalLog('--- device-check 桌面试跑 ---');
    originalLog('打印了报告: ' + hasReport);
    originalLog('触发探测数: ' + total + (summaryMatch === null ? '' : '（通过 ' + summaryMatch[1] + ' 失败 ' + summaryMatch[2] + ' 跳过 ' + summaryMatch[3] + '）'));
    originalLog('桥接调用数: ' + calls.length);
    originalLog('');
    originalLog(text);

    var failed = Number(summaryMatch === null ? 1 : summaryMatch[2]);
    if (!hasReport || total < 15) {
        originalLog('');
        originalLog('结果: FAIL（脚本没跑完或探测数太少）');
        process.exitCode = 1;
        return;
    }
    originalLog('');
    originalLog('结果: 脚本流程 OK（' + failed + ' 项失败属于桩的局限，不是脚本问题）');
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (ignored) { /* 清理失败不影响结论 */ }
}, 200);
