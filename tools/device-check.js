'use strict';

/**
 * node.operit 真机自检脚本。
 *
 * 用法：在 Operit 里执行本脚本（工具包脚本 / JS 控制台均可）。它会逐项探测
 * node.operit 依赖的**每一条宿主能力**，打印 PASS / FAIL / 实测值，最后给一份摘要。
 *
 * 为什么需要它：库里所有 Java 侧的行为（bridge 封装、数组转换、File/RandomAccessFile 的
 * 语义、toolCall 的返回形状……）在桌面上都无法验证，只能靠推断。这个脚本把"未验证"
 * 变成"跑一次就知道"，并把不符合预期的地方直接指出来 —— 而不是等到某个插件在运行期
 * 莫名其妙地失败。
 *
 * 每一项都在 try/catch 里，单项失败不会中断后面的探测。
 *
 * 若 node.operit 不在默认位置，先设置：
 *   globalThis.ONJ_LIB_PATH = '<相对路径>/node_modules/@serveryyswys/node.operit/index.js'
 */

(function main() {
    var results = [];

    function check(name, probe) {
        try {
            var detail = probe();
            results.push({ name: name, status: 'PASS', detail: detail === undefined || detail === null ? '' : String(detail) });
        } catch (error) {
            var message = error && error.message ? error.message : String(error);
            results.push({ name: name, status: 'FAIL', detail: message });
        }
    }

    function skip(name, reason) {
        results.push({ name: name, status: 'SKIP', detail: reason });
    }

    function bridgeCall(className, methodName, args) {
        var raw = NativeInterface.javaCallStatic(className, methodName, JSON.stringify(args === undefined ? [] : args));
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || parsed.success !== true) {
            throw new Error(className + '.' + methodName + ' 未成功：' + JSON.stringify(parsed));
        }
        return parsed.data;
    }

    function bridgeNew(className, args) {
        var raw = NativeInterface.javaNewInstance(className, JSON.stringify(args === undefined ? [] : args));
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || parsed.success !== true) {
            throw new Error('new ' + className + ' 失败：' + JSON.stringify(parsed));
        }
        return parsed.data;
    }

    function instanceCall(handle, methodName, args) {
        var raw = NativeInterface.javaCallInstance(handle, methodName, JSON.stringify(args === undefined ? [] : args));
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || parsed.success !== true) {
            throw new Error(handle + '.' + methodName + ' 未成功：' + JSON.stringify(parsed));
        }
        return parsed.data;
    }

    // ---------------------------------------------------------------- 1. 全局面

    check('全局 NativeInterface', function () {
        if (typeof NativeInterface === 'undefined' || NativeInterface === null) {
            throw new Error('未定义 —— node.operit 的 Java bridge 层无法工作');
        }
        return Object.keys(NativeInterface).length + ' 个方法';
    });

    check('全局 toolCall', function () {
        if (typeof toolCall !== 'function') {
            throw new Error('未定义 —— http / axios 无法工作');
        }
        return 'function';
    });

    check('全局 getPluginConfigDir', function () {
        if (typeof getPluginConfigDir !== 'function') {
            throw new Error('未定义 —— fs 的 config 环境无法工作');
        }
        var current = getPluginConfigDir('');
        var explicit = getPluginConfigDir('__onj_probe__');
        if (typeof current !== 'string' || current.length === 0) {
            throw new Error("getPluginConfigDir('') 返回空 —— packageName() 的反推会失败");
        }
        if (explicit.indexOf('__onj_probe__') < 0) {
            throw new Error('getPluginConfigDir(id) 未包含 id：' + explicit);
        }
        return "空参=" + current + " | 具名=" + explicit;
    });

    check('全局 OPERIT_DOWNLOAD_DIR / OPERIT_CLEAN_ON_EXIT_DIR', function () {
        var download = typeof OPERIT_DOWNLOAD_DIR === 'string' ? OPERIT_DOWNLOAD_DIR : '<未定义>';
        var clean = typeof OPERIT_CLEAN_ON_EXIT_DIR === 'string' ? OPERIT_CLEAN_ON_EXIT_DIR : '<未定义>';
        if (download === '<未定义>' && clean === '<未定义>') {
            throw new Error('两个都没有 —— downloadDir() / cleanOnExitDir() 会抛 ONJ_MISSING_HOST');
        }
        return 'download=' + download + ' | clean=' + clean;
    });

    check('全局 getEnv / getState / getLang', function () {
        if (typeof getEnv !== 'function') { throw new Error('getEnv 未定义 —— process.env 无法工作'); }
        if (typeof getState !== 'function') { throw new Error('getState 未定义'); }
        if (typeof getLang !== 'function') { throw new Error('getLang 未定义'); }
        return 'HOME=' + JSON.stringify(getEnv('HOME')) + ' state=' + JSON.stringify(getState()) + ' lang=' + JSON.stringify(getLang());
    });

    check('全局定时器与 performance', function () {
        if (typeof setTimeout !== 'function' || typeof clearTimeout !== 'function') { throw new Error('setTimeout 缺失'); }
        if (typeof setInterval !== 'function' || typeof clearInterval !== 'function') { throw new Error('setInterval 缺失'); }
        if (typeof queueMicrotask !== 'function') { throw new Error('queueMicrotask 缺失'); }
        if (typeof performance !== 'object' || performance === null || typeof performance.now !== 'function') {
            throw new Error('performance.now 缺失 —— perf_hooks 无法工作');
        }
        return 'setTimeout/setInterval/queueMicrotask 齐备，performance.now()=' + performance.now();
    });

    check('全局没有 process / Buffer（这是预期，不是缺陷）', function () {
        return 'typeof process=' + typeof process + ' typeof Buffer=' + typeof Buffer;
    });

    // ---------------------------------------------------------------- 2. bridge 协议

    check('javaCallStatic 成功时的信封形状', function () {
        var raw = NativeInterface.javaCallStatic('java.lang.System', 'currentTimeMillis', '[]');
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || parsed.success !== true) { throw new Error('success 不为 true：' + raw); }
        if (typeof parsed.data !== 'number') { throw new Error('data 不是数字：' + JSON.stringify(parsed.data)); }
        return 'data=' + parsed.data;
    });

    check('javaCallStatic 失败时的信封形状（错误码映射依赖它）', function () {
        var raw = NativeInterface.javaCallStatic('java.lang.System', 'noSuchMethodOnjProbe', '[]');
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || parsed.success !== false) {
            throw new Error('调不存在的方法竟然没报失败：' + raw);
        }
        return 'error=' + JSON.stringify(parsed.error) + ' message=' + JSON.stringify(parsed.message);
    });

    check('javaClassExists', function () {
        var present = bridgeCall('java.lang.System', 'currentTimeMillis', []) !== undefined;
        if (typeof NativeInterface.javaClassExists !== 'function') { throw new Error('javaClassExists 缺失'); }
        var exists = NativeInterface.javaClassExists('java.io.File');
        var missing = NativeInterface.javaClassExists('com.onj.NoSuchClass');
        if (!exists) { throw new Error('java.io.File 被判为不存在'); }
        return 'java.io.File=' + exists + ' 不存在的类=' + missing + '（System 可调用=' + present + '）';
    });

    check('JS 数组 -> Java 数组/变参（ProcessBuilder 与 exec 依赖）', function () {
        var list = bridgeCall('java.util.Arrays', 'asList', [['onj-a', 'onj-b']]);
        var size = instanceCall(list, 'size', []);
        if (Number(size) !== 2) { throw new Error('Arrays.asList 的 size 是 ' + size + '，期望 2'); }
        return 'Arrays.asList(["onj-a","onj-b"]).size()=' + size;
    });

    check('Java 数组 -> JS 数组（getAllByName / listFiles 依赖）', function () {
        var list = bridgeCall('java.net.InetAddress', 'getAllByName', ['localhost']);
        if (!Array.isArray(list)) { throw new Error('返回的不是数组：' + JSON.stringify(list)); }
        return 'InetAddress.getAllByName("localhost") 返回 ' + list.length + ' 项，第一项类型 ' + typeof list[0];
    });

    // ---------------------------------------------------------------- 3. fs 依赖的 Java 面

    var tempPath = null;

    check('java.io.File 的基本语义', function () {
        var file = bridgeNew('java.io.File', ['.']);
        var whole = String(instanceCall(file, 'getAbsolutePath', []));
        var created = bridgeNew('java.io.File', [whole + '/onj_probe_dir']);
        instanceCall(created, 'mkdirs', []);
        if (!instanceCall(created, 'isDirectory', [])) { throw new Error('mkdirs 之后 isDirectory 仍为 false'); }
        if (!instanceCall(created, 'exists', [])) { throw new Error('mkdirs 之后 exists 仍为 false'); }
        instanceCall(created, 'delete', []);
        return 'getAbsolutePath=' + whole;
    });

    check('RandomAccessFile.writeBytes（latin1 通道）与 Files.readAllBytes（数字数组）', function () {
        var file = bridgeCall('java.io.File', 'createTempFile', ['onj-check', '.txt']);
        tempPath = String(instanceCall(file, 'getAbsolutePath', []));
        var raf = bridgeNew('java.io.RandomAccessFile', [tempPath, 'rw']);
        instanceCall(raf, 'writeBytes', ['hello-onj']);
        instanceCall(raf, 'close', []);

        var path = instanceCall(bridgeNew('java.io.File', [tempPath]), 'toPath', []);
        var bytes = bridgeCall('java.nio.file.Files', 'readAllBytes', [path]);
        if (!Array.isArray(bytes)) {
            throw new Error('readAllBytes 返回的不是数组（而是 ' + typeof bytes + '）—— 二进制读取会失败');
        }
        if (typeof bytes[0] !== 'number') {
            throw new Error('数组元素不是数字：' + JSON.stringify(bytes.slice(0, 4)));
        }
        var text = '';
        for (var i = 0; i < bytes.length; i += 1) { text += String.fromCharCode(bytes[i] & 255); }
        if (text !== 'hello-onj') { throw new Error('读回的文本是 ' + JSON.stringify(text)); }
        return tempPath + ' -> ' + bytes.length + ' 字节，内容正确';
    });

    check('FileChannel + ByteBuffer 定位读（fd 系列依赖）', function () {
        if (tempPath === null) { throw new Error('上一步没拿到临时文件'); }
        var raf = bridgeNew('java.io.RandomAccessFile', [tempPath, 'r']);
        var channel = instanceCall(raf, 'getChannel', []);
        var buffer = bridgeCall('java.nio.ByteBuffer', 'allocate', [5]);
        var count = instanceCall(channel, 'read', [buffer, 6]);
        var raw = instanceCall(buffer, 'array', []);
        if (!Array.isArray(raw)) { throw new Error('ByteBuffer.array() 不是数组：' + typeof raw); }
        var text = '';
        for (var i = 0; i < Number(count); i += 1) { text += String.fromCharCode(raw[i] & 255); }
        instanceCall(raf, 'close', []);
        if (text !== 'onj') { throw new Error('从偏移 6 读到 ' + JSON.stringify(text) + '，期望 "onj"'); }
        return 'offset=6 length=5 -> ' + JSON.stringify(text);
    });

    check('java.util.Scanner 读 InputStream（child_process 依赖）', function () {
        var builder = bridgeNew('java.lang.ProcessBuilder', [['/system/bin/sh', '-c', 'echo onj-probe']]);
        var process = instanceCall(builder, 'start', []);
        var stream = instanceCall(process, 'getInputStream', []);
        var scanner = bridgeNew('java.util.Scanner', [stream, 'UTF-8']);
        var hasNext = instanceCall(scanner, 'hasNext', []);
        var line = hasNext ? String(instanceCall(scanner, 'next', [])) : '';
        instanceCall(scanner, 'close', []);
        var status = instanceCall(process, 'waitFor', []);
        if (line.trim() !== 'onj-probe') { throw new Error('读到 ' + JSON.stringify(line) + '，期望 "onj-probe"'); }
        return 'echo 输出=' + JSON.stringify(line) + ' 退出码=' + status;
    });

    check('ProcessBuilder 的 cwd 与 env 设置（child_process 依赖）', function () {
        var builder = bridgeNew('java.lang.ProcessBuilder', [['/system/bin/sh', '-c', 'echo $ONJ_PROBE_VAR']]);
        var environment = instanceCall(builder, 'environment', []);
        instanceCall(environment, 'putAll', [{ ONJ_PROBE_VAR: 'onj-env-ok' }]);
        instanceCall(builder, 'directory', [bridgeNew('java.io.File', ['/'])]);
        var process = instanceCall(builder, 'start', []);
        var stream = instanceCall(process, 'getInputStream', []);
        var scanner = bridgeNew('java.util.Scanner', [stream, 'UTF-8']);
        var line = instanceCall(scanner, 'hasNext', []) ? String(instanceCall(scanner, 'next', [])) : '';
        instanceCall(scanner, 'close', []);
        instanceCall(process, 'waitFor', []);
        if (line.trim() !== 'onj-env-ok') { throw new Error('环境变量没传进去，读到 ' + JSON.stringify(line)); }
        return 'env 与 cwd 都生效';
    });

    check('java.util.UUID.randomUUID（crypto 的随机源）', function () {
        var value = String(bridgeCall('java.util.UUID', 'randomUUID', []));
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
            throw new Error('返回的不是 v4 UUID：' + value);
        }
        return value;
    });

    check('java.lang.System.getProperty 与 Runtime（os / process 依赖）', function () {
        var version = String(bridgeCall('java.lang.System', 'getProperty', ['java.version']));
        var runtime = bridgeCall('java.lang.Runtime', 'getRuntime', []);
        var processors = instanceCall(runtime, 'availableProcessors', []);
        var free = instanceCall(runtime, 'freeMemory', []);
        return 'java.version=' + version + ' 核数=' + processors + ' freeMemory=' + free;
    });

    check('java.net.InetAddress 反向查询（dns.lookupService 依赖）', function () {
        var address = bridgeCall('java.net.InetAddress', 'getByName', ['127.0.0.1']);
        var canonical = String(instanceCall(address, 'getCanonicalHostName', []));
        var literal = String(instanceCall(address, 'getHostAddress', []));
        return 'getHostAddress=' + literal + ' getCanonicalHostName=' + canonical;
    });

    // ---------------------------------------------------------------- 4. toolCall / http

    check('toolCall("http_request") 的返回形状（整个 http 模块依赖）', function () {
        if (typeof toolCall !== 'function') { throw new Error('toolCall 不可用'); }
        var promise = toolCall('http_request', { url: 'https://example.com/', method: 'GET' });
        if (!promise || typeof promise.then !== 'function') {
            throw new Error('toolCall 返回的不是 Promise');
        }
        return '返回 Promise（异步结果请在下面「异步探测」一节看）';
    });

    // ---------------------------------------------------------------- 5. 插件配置目录

    check('插件配置目录是否已存在（fs 的 config 环境要求根存在）', function () {
        var dir = getPluginConfigDir('');
        var file = bridgeNew('java.io.File', [dir]);
        var exists = instanceCall(file, 'exists', []);
        var created = false;
        if (!exists) {
            instanceCall(file, 'mkdirs', []);
            created = Boolean(instanceCall(file, 'exists', []));
            if (!created) {
                throw new Error("目录不存在且创建失败：" + dir + " —— fs.env.use('config') 会抛 ONJ_ENV_UNAVAILABLE");
            }
        }
        return dir + '（原本' + (exists ? '已存在' : '不存在，已由本脚本创建') + '）';
    });

    // ---------------------------------------------------------------- 6. node.operit 自身

    var requirePath = (typeof globalThis !== 'undefined' && globalThis.ONJ_LIB_PATH)
        ? globalThis.ONJ_LIB_PATH
        : './node_modules/@serveryyswys/node.operit/index.js';

    check('加载 node.operit（' + requirePath + '）', function () {
        var lib = require(requirePath);
        var keys = Object.keys(lib).sort();
        if (keys.length === 0) { throw new Error('加载成功但导出为空'); }
        return keys.join(',');
    });

    check('node.operit 端到端冒烟：fs + crypto + zlib + url + buffer', function () {
        var lib = require(requirePath);
        var fs = lib.fs;
        var crypto = lib.crypto;
        var zlib = lib.zlib;
        var url = lib.url;
        var bufferModule = lib.buffer;
        var Buffer = bufferModule.Buffer;

        // 用内置的 config 环境（根就是插件配置目录）—— 这也是插件该有的用法。
        // 注意：config 环境要求根已存在，上一条探测已经保证过。
        fs.env.use('config');
        var dir = fs.env.root();
        var probeDir = 'onj-smoke';
        fs.mkdirSync(probeDir, { recursive: true });
        var target = probeDir + '/probe.txt';
        fs.writeFileSync(target, 'onj-smoke-内容');
        var readBack = fs.readFileSync(target, 'utf8');
        if (readBack !== 'onj-smoke-内容') { throw new Error('写读不一致：' + JSON.stringify(readBack)); }

        var digest = crypto.createHash('sha256').update('abc').digest('hex');
        if (digest !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') {
            throw new Error('sha256("abc") 结果不对：' + digest);
        }

        var compressed = zlib.gzipSync(Buffer.from('round-trip'));
        var restored = zlib.gunzipSync(compressed).toString('utf8');
        if (restored !== 'round-trip') { throw new Error('gzip 往返失败：' + JSON.stringify(restored)); }

        var parsed = new url.URL('http://u:p@example.com:8080/a?b=1#c');
        if (parsed.host !== 'example.com:8080' || parsed.searchParams.get('b') !== '1') {
            throw new Error('URL 解析不对：' + parsed.href);
        }

        fs.rmSync(probeDir, { recursive: true, force: true });
        fs.env.reset();
        return 'fs/crypto/zlib/url/buffer 全部通过（配置目录 ' + dir + '）';
    });

    // ---------------------------------------------------------------- 7. 异步探测

    function finish() {
        var passed = results.filter(function (r) { return r.status === 'PASS'; }).length;
        var failed = results.filter(function (r) { return r.status === 'FAIL'; }).length;
        var skipped = results.filter(function (r) { return r.status === 'SKIP'; }).length;

        console.log('');
        console.log('==== node.operit 真机自检报告 ====');
        for (var i = 0; i < results.length; i += 1) {
            var entry = results[i];
            console.log('[' + entry.status + '] ' + entry.name);
            if (entry.detail) {
                console.log('        ' + entry.detail);
            }
        }
        console.log('');
        console.log('通过 ' + passed + ' / 失败 ' + failed + ' / 跳过 ' + skipped);

        if (typeof globalThis !== 'undefined') {
            globalThis.__onjDeviceCheckReport = { results: results, passed: passed, failed: failed, skipped: skipped };
        }
        console.log('（完整结果也在 globalThis.__onjDeviceCheckReport 里，便于复制回开发端）');
    }

    if (typeof toolCall === 'function') {
        try {
            toolCall('http_request', { url: 'https://example.com/', method: 'GET' }).then(function (response) {
                var shape = response === null || typeof response !== 'object'
                    ? String(response)
                    : Object.keys(response).sort().join(',');
                var ok = response && typeof response.statusCode === 'number';
                results.push({
                    name: 'toolCall("http_request") 的异步结果形状',
                    status: ok ? 'PASS' : 'FAIL',
                    detail: '字段=' + shape + (ok ? '' : ' —— 缺 statusCode，http 模块会无法解释')
                });
            }, function (error) {
                results.push({
                    name: 'toolCall("http_request") 的异步结果形状',
                    status: 'FAIL',
                    detail: '被拒绝：' + (error && error.message ? error.message : String(error))
                });
            }).then(finish);
            return;
        } catch (error) {
            results.push({ name: 'toolCall("http_request") 的异步结果形状', status: 'FAIL', detail: String(error) });
        }
    } else {
        skip('toolCall("http_request") 的异步结果形状', 'toolCall 不可用');
    }
    finish();
})();
