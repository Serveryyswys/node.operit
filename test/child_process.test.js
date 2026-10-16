'use strict';

/**
 * child_process 契约测试。
 *
 * 为什么用 mock 驱动而不是真跑命令：本机（DSH 沙箱）禁止带管道 stdio 起子进程，
 * Node 的 spawnSync/exec 会直接 EPERM。所以这里改为断言两件事：
 *   1. 本库交给驱动的 argv 是否正确（这就是与 Java bridge 的契约：shell 还是直连、
 *      参数有没有被正确拼接/转义）；
 *   2. Node 语义层是否正确（退出码、错误码、maxBuffer、回调参数、事件与流）。
 */

var h = require('./harness.js');

var myCp = require('../dist/child_process.js');
var drivers = require('../dist/lib/process-driver.js');

var MISSING_BINARY = 'onj-definitely-not-a-command-xyz';
var SHELL = '/system/bin/sh';
var PID = 4242;

function simulateShell(line) {
    var trimmed = String(line).trim();
    if (trimmed.indexOf('exit ') === 0) {
        return { pid: PID, status: parseInt(trimmed.slice(5), 10) || 0, stdout: '', stderr: '' };
    }
    if (trimmed.indexOf('echo ') === 0) {
        return { pid: PID, status: 0, stdout: trimmed.slice(5) + '\n', stderr: '' };
    }
    return { pid: PID, status: 0, stdout: '', stderr: '' };
}

function createMockDriver() {
    var calls = [];
    return {
        calls: calls,
        run: function (argv, options) {
            calls.push({ argv: argv.slice(), cwd: options && options.cwd, env: options && options.env });
            var file = argv[0];
            var args = argv.slice(1);
            if (file === SHELL && args[0] === '-c') {
                return simulateShell(args[1]);
            }
            if (file === MISSING_BINARY) {
                var failure = new Error('Cannot run program "' + file + '": error=2, No such file or directory');
                failure.code = 'ENOENT';
                failure.isJavaError = true;
                failure.javaClass = 'java.io.IOException';
                failure.javaMessage = failure.message;
                throw failure;
            }
            return { pid: PID, status: 0, stdout: 'direct:' + [file].concat(args).join(' '), stderr: '' };
        }
    };
}

function text(value) {
    if (value === null || value === undefined) {
        return '<none>';
    }
    return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
}

function capture(operation) {
    try {
        return { value: text(operation()) };
    } catch (error) {
        return {
            code: error && error.code ? error.code : '',
            status: error && error.status !== undefined && error.status !== null ? error.status : '',
            stderr: text(error && error.stderr)
        };
    }
}

async function run() {
    var mock = createMockDriver();
    drivers.setDriver(mock);

    h.section('execSync 的线格式与返回值');
    h.equal(text(myCp.execSync('echo hello')), 'hello\n', 'execSync 默认返回 Buffer');
    h.equal(myCp.execSync('echo hello') instanceof Uint8Array, true, '默认返回值是 Buffer');
    h.equal(myCp.execSync('echo hello', { encoding: 'utf8' }), 'hello\n', 'encoding 时返回字符串');
    h.deepEqual(mock.calls[0].argv, [SHELL, '-c', 'echo hello'], 'exec 走 shell 且整条命令作为一个参数');

    h.section('退出码与错误形态');
    var failed = capture(function () { return myCp.execSync('exit 3'); });
    h.equal(failed.status, 3, '非零退出码体现在 error.status');
    h.equal(failed.code, '', '非零退出码不设 code');
    var missing = capture(function () { return myCp.execFileSync(MISSING_BINARY, []); });
    h.equal(missing.code, 'ENOENT', '可执行文件不存在 -> ENOENT');
    var overflow = capture(function () { return myCp.execSync('echo ' + 'x'.repeat(200), { maxBuffer: 8 }); });
    h.equal(overflow.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'maxBuffer 超出');

    h.section('execFile 不走 shell');
    h.equal(myCp.execFileSync('echo', ['a', 'b'], { encoding: 'utf8' }), 'direct:echo a b', 'execFileSync 直连可执行文件');
    var directCall = mock.calls[mock.calls.length - 1];
    h.deepEqual(directCall.argv, ['echo', 'a', 'b'], 'execFile 的 argv 不含 shell');

    h.section('shell 选项');
    var syncResult = myCp.spawnSync('echo', ['sync'], { shell: true, encoding: 'utf8' });
    h.equal(syncResult.status, 0, 'spawnSync status');
    h.equal(syncResult.stdout, 'sync\n', 'spawnSync stdout');
    h.deepEqual(syncResult.output.length, 3, 'output 长度为 3');
    h.deepEqual(mock.calls[mock.calls.length - 1].argv, [SHELL, '-c', 'echo sync'], 'shell:true 时拼接后交给 shell');
    var noShell = myCp.spawnSync('echo', ['direct'], { encoding: 'utf8' });
    h.deepEqual(mock.calls[mock.calls.length - 1].argv, ['echo', 'direct'], '不给 shell 时直连');
    h.equal(noShell.stdout, 'direct:echo direct', '直连结果');

    h.section('spawnSync 启动失败');
    var spawnMissing = myCp.spawnSync(MISSING_BINARY, []);
    h.equal(spawnMissing.error && spawnMissing.error.code, 'ENOENT', 'spawnSync 不抛错，错误放在 .error');
    h.equal(spawnMissing.status, null, '启动失败时 status 为 null');
    h.equal(spawnMissing.pid, 0, '启动失败时 pid 为 0');

    h.section('exec 回调');
    var execResult = await new Promise(function (resolve) {
        myCp.exec('echo callback-path', function (error, stdout, stderr) {
            resolve({ error: error === null ? 'none' : 'error', stdout: text(stdout), stderr: text(stderr) });
        });
    });
    h.deepEqual(execResult, { error: 'none', stdout: 'callback-path\n', stderr: '' }, 'exec 回调参数');

    h.section('spawn 事件与流');
    var spawned = await new Promise(function (resolve, reject) {
        var child = myCp.spawn('echo', ['hi'], { shell: true });
        var events = [];
        var out = '';
        child.on('spawn', function () { events.push('spawn'); });
        child.on('exit', function (code) { events.push('exit:' + code); });
        child.on('close', function (code) { events.push('close:' + code); });
        child.on('error', reject);
        child.stdout.on('data', function (chunk) { out += text(chunk); });
        child.stdout.on('end', function () {
            setTimeout(function () {
                resolve({ events: events.slice().sort(), out: out, exitCode: child.exitCode, pid: child.pid });
            }, 10);
        });
    });
    h.deepEqual(spawned.events, ['close:0', 'exit:0', 'spawn'], 'spawn 事件集合');
    h.equal(spawned.out, 'hi\n', 'ChildProcess.stdout 收到输出');
    h.equal(spawned.exitCode, 0, 'exitCode');
    h.equal(spawned.pid, PID, 'pid 来自驱动');
    h.deepEqual(mock.calls[mock.calls.length - 1].argv, [SHELL, '-c', 'echo hi'], 'spawn 走 shell');

    h.section('cwd / env 透传与未实现项');
    myCp.execSync('echo passthrough', { cwd: '/sdcard/work', env: { ONJ: '1' } });
    var passthrough = mock.calls[mock.calls.length - 1];
    h.equal(passthrough.cwd, '/sdcard/work', 'cwd 透传给驱动');
    h.deepEqual(passthrough.env, { ONJ: '1' }, 'env 透传给驱动');
    var forkError = null;
    try {
        myCp.fork('anything');
    } catch (error) {
        forkError = error;
    }
    h.equal(forkError !== null && forkError.code === 'ONJ_UNSUPPORTED', true, 'fork 显式抛 ONJ_UNSUPPORTED');
    h.equal(typeof myCp.ChildProcess, 'function', 'ChildProcess 类存在');
    var okable = myCp.spawn('echo', ['x'], { shell: true });
    h.equal(okable.kill(), false, '进程已跑完，kill 返回 false');

    drivers.setDriver(null);
}

module.exports = { run: run };
