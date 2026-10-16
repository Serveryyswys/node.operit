'use strict';

/**
 * os / process 的宿主契约测试。
 *
 * 这两个模块的取值来自 Android，无法与桌面 Node 比数值；能验证的是：
 *   1. 调用的 Java 方法与参数是否正确（用 mock backend 记录）
 *   2. 转换逻辑是否正确（arch 映射、Enumeration 展开、Proxy 环境变量等）
 *   3. 对外暴露的名字是否是 Node 也有的名字（不发明新名字）
 */

var h = require('./harness.js');
var nodeOs = require('os');
var nodePath = require('path');
var nodeFs = require('fs');

var bridge = require('../dist/lib/bridge.js');

// --------------------------------------------------------------- mock backend

var recorded = [];
var enumState = {};

function mockBackend() {
    return {
        classExists: function () { return false; },
        callStatic: function (className, methodName, args) {
            recorded.push('static:' + className + '#' + methodName);
            if (className === 'java.lang.Runtime' && methodName === 'getRuntime') {
                return { __javaHandle: 'runtime', __javaClass: 'java.lang.Runtime' };
            }
            if (className === 'java.lang.System' && methodName === 'getProperty') {
                return args[0] === 'os.arch' ? 'aarch64' : (args[0] === 'user.name' ? 'operit' : 'Android 14');
            }
            if (className === 'android.os.SystemClock' && methodName === 'elapsedRealtime') {
                return 1234567;
            }
            if (className === 'android.os.Process' && methodName === 'myPid') {
                return 4321;
            }
            if (className === 'java.net.InetAddress' && methodName === 'getLocalHost') {
                return { __javaHandle: 'localhost', __javaClass: 'java.net.InetAddress' };
            }
            if (className === 'java.net.NetworkInterface' && methodName === 'getNetworkInterfaces') {
                return { __javaHandle: 'nis', __javaClass: 'java.util.Collections$3' };
            }
            return null;
        },
        callInstance: function (instance, methodName, args) {
            var handle = typeof instance === 'string' ? instance : instance.__javaHandle;
            recorded.push('instance:' + handle + '#' + methodName);
            if (handle === 'runtime') {
                if (methodName === 'availableProcessors') { return 6; }
                if (methodName === 'maxMemory') { return 268435456; }
                if (methodName === 'freeMemory') { return 134217728; }
            }
            if (handle === 'localhost' && methodName === 'getHostName') { return 'operit-host'; }
            if (handle === 'nis') {
                enumState.nis = enumState.nis === undefined ? 1 : enumState.nis;
                if (methodName === 'hasMoreElements') {
                    var more = enumState.nis > 0;
                    enumState.nis -= 1;
                    return more;
                }
                if (methodName === 'nextElement') {
                    return { __javaHandle: 'ni1', __javaClass: 'java.net.NetworkInterface' };
                }
            }
            if (handle === 'ni1') {
                if (methodName === 'getName') { return 'wlan0'; }
                if (methodName === 'getInetAddresses') { return { __javaHandle: 'addrs', __javaClass: 'java.util.Collections$3' }; }
            }
            if (handle === 'addrs') {
                enumState.addrs = enumState.addrs === undefined ? 1 : enumState.addrs;
                if (methodName === 'hasMoreElements') {
                    var more2 = enumState.addrs > 0;
                    enumState.addrs -= 1;
                    return more2;
                }
                if (methodName === 'nextElement') {
                    return { __javaHandle: 'addr1', __javaClass: 'java.net.Inet4Address' };
                }
            }
            if (handle === 'addr1') {
                if (methodName === 'getHostAddress') { return '192.168.1.5'; }
                if (methodName === 'isLoopbackAddress') { return false; }
            }
            if (handle === 'ctx' && methodName === 'getCacheDir') {
                return { __javaHandle: 'cachedir', __javaClass: 'java.io.File' };
            }
            if (handle === 'cachedir' && methodName === 'getAbsolutePath') {
                return '/data/user/0/com.ai.assistance.operit/cache';
            }
            return null;
        },
        newInstance: function (className, args) { return { __javaHandle: 'new', __javaClass: className }; },
        getStaticField: function (className, fieldName) {
            recorded.push('field:' + className + '#' + fieldName);
            if (className === 'android.os.Build$VERSION' && fieldName === 'RELEASE') { return '14'; }
            return null;
        },
        setStaticField: function () { return undefined; },
        getInstanceField: function () { return null; },
        setInstanceField: function () { return undefined; },
        getApplicationContext: function () {
            return { __javaHandle: 'ctx', __javaClass: 'android.content.Context' };
        },
        getCurrentActivity: function () { return null; },
        setEnv: function (key, value) { recorded.push('setEnv:' + key + '=' + String(value)); }
    };
}

bridge.setBackend(mockBackend());
globalThis.getEnv = function (key) {
    if (key === 'HOME') { return '/sdcard'; }
    if (key === 'EMPTY') { return ''; }
    return '';
};

var myOs = require('../dist/os.js');
var myProcess = require('../dist/process.js');
var drivers = require('../dist/lib/fs-driver.js');
var createNodeDriver = require('./node-fs-driver.js').createNodeDriver;

function run() {
    h.section('os：Java 契约与转换');
    h.equal(myOs.platform(), 'android', 'platform');
    h.equal(myOs.arch(), 'arm64', "arch 把 aarch64 映射为 arm64");
    h.equal(myOs.EOL, '\n', 'EOL');
    h.equal(myOs.type(), 'Linux', 'type');
    h.equal(myOs.release(), '14', 'release 读 Build.VERSION.RELEASE');
    h.equal(myOs.hostname(), 'operit-host', 'hostname');
    h.equal(myOs.endianness(), 'LE', 'endianness');
    h.equal(myOs.devNull, '/dev/null', 'devNull');
    h.equal(myOs.homedir(), '/sdcard', 'homedir');
    h.equal(myOs.tmpdir(), '/data/user/0/com.ai.assistance.operit/cache', 'tmpdir 走 Context.getCacheDir');
    h.equal(myOs.availableParallelism(), 6, 'availableParallelism');
    h.equal(myOs.cpus().length, 6, 'cpus 数量');
    h.equal(myOs.cpus()[0].model, 'aarch64', 'cpus model');
    h.equal(myOs.totalmem(), 268435456, 'totalmem');
    h.equal(myOs.freemem(), 134217728, 'freemem');
    h.deepEqual(myOs.loadavg(), [0, 0, 0], 'loadavg');
    h.equal(myOs.uptime(), 1234, 'uptime 取 elapsedRealtime');
    h.equal(myOs.userInfo().username, 'operit', 'userInfo.username');
    h.deepEqual(myOs.networkInterfaces(), {
        wlan0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }]
    }, 'networkInterfaces 展开 Enumeration');
    h.equal(myOs.constants.signals.SIGTERM, 15, 'constants.signals');
    h.equal(myOs.constants.errno.ENOENT, 2, 'constants.errno 用正数');
    h.equal(myOs.getPriority !== undefined, true, 'getPriority 存在');

    var unsupported = null;
    try {
        myOs.getPriority();
    } catch (error) {
        unsupported = error;
    }
    h.equal(unsupported !== null && unsupported.code === 'ONJ_UNSUPPORTED', true, 'getPriority 抛 ONJ_UNSUPPORTED');

    h.section('os：不发明 Node 没有的名字');
    var osKeys = Object.keys(myOs).sort();
    var missing = osKeys.filter(function (key) { return !(key in nodeOs); });
    h.deepEqual(missing, [], 'os 的所有导出名 Node 也有');

    h.section('process：形状与行为');
    h.equal(myProcess.platform, 'android', 'process.platform');
    h.equal(myProcess.arch, 'arm64', 'process.arch');
    h.equal(myProcess.pid, 4321, 'process.pid');
    h.equal(typeof myProcess.nextTick, 'function', 'nextTick');
    h.equal(myProcess.cwd(), require('../dist/lib/cwd.js').get(), 'cwd 与 lib/cwd 一致');
    h.equal(myProcess.env.HOME, '/sdcard', 'env 读取走 getEnv');
    h.equal(myProcess.env.EMPTY, undefined, '空串与未设置都表现为 undefined');
    h.equal('HOME' in myProcess.env, true, 'in 运算符走 has');
    h.equal('NOPE' in myProcess.env, false, '未设置的键 in 为 false');
    myProcess.env.NEW_KEY = 'value';
    h.equal(recorded.indexOf('setEnv:NEW_KEY=value') >= 0, true, 'env 写入走 NativeInterface.setEnv');
    delete myProcess.env.HOME;
    h.equal(recorded.indexOf('setEnv:HOME=null') >= 0, true, 'delete 写 null');
    h.deepEqual(myProcess.hrtime().length, 2, 'hrtime 返回两元素数组');
    h.equal(typeof myProcess.hrtime.bigint(), 'bigint', 'hrtime.bigint');
    h.equal(myProcess.uptime(), 1234, 'process.uptime 委托 os.uptime');

    var order = [];
    myProcess.nextTick(function (value) { order.push('tick:' + value); }, 1);
    myProcess.nextTick(function () { order.push('tick2'); });
    h.deepEqual(order, [], 'nextTick 是异步的');
    myProcess.emitWarning('careful');
    h.equal(myProcess.listenerCount('warning'), 0, 'emitWarning 不抛错');

    var exitError = null;
    try {
        myProcess.exit(1);
    } catch (error) {
        exitError = error;
    }
    h.equal(exitError !== null && exitError.code === 'ONJ_UNSUPPORTED', true, 'exit 抛 ONJ_UNSUPPORTED');

    h.section('process：EventEmitter 能力');
    var seen = null;
    myProcess.on('custom', function (value) { seen = value; });
    h.equal(myProcess.emit('custom', 'x'), true, 'process 可 emit');
    h.equal(seen, 'x', 'process 的监听器被调用');
    h.equal(myProcess instanceof require('../dist/events.js'), true, 'process 是 EventEmitter 实例');

    h.section('process：不发明 Node 没有的名字');
    var processKeys = Object.keys(myProcess);
    var unknown = processKeys.filter(function (key) { return !(key in process); });
    h.deepEqual(unknown, [], 'process 的自有属性名 Node 也有');

    h.section('process.chdir');
    var tempRoot = nodeFs.mkdtempSync(nodePath.join(require('os').tmpdir(), 'onj-host-'));
    drivers.setDriver(createNodeDriver());
    var myFs = require('../dist/fs.js');
    myFs.env.reset();
    myFs.env.define('host-test', { root: tempRoot });
    myFs.env.use('host-test');
    var cwdModule = require('../dist/lib/cwd.js');
    var previous = cwdModule.get();
    nodeFs.mkdirSync(nodePath.join(tempRoot, 'sub'));
    // 用相对路径：本库走 posix 语义，本机却是 Windows 绝对路径，两者不能混用
    myProcess.chdir('sub');
    h.equal(myProcess.cwd(), tempRoot + '/sub', 'chdir 存的是解析后的绝对路径');
    h.equal(cwdModule.get(), tempRoot + '/sub', 'chdir 改的是 lib/cwd');
    var chdirError = null;
    try {
        myProcess.chdir('missing');
    } catch (error) {
        chdirError = error;
    }
    h.equal(chdirError !== null && chdirError.code === 'ENOENT', true, 'chdir 到不存在目录抛 ENOENT');
    cwdModule.set(previous);
    drivers.setDriver(null);
    bridge.setBackend(null);
    try {
        nodeFs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (ignored) {
        // 清理失败不影响结论
    }
}

module.exports = { run: run };
