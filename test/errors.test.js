'use strict';

var errors = require('../dist/lib/errors.js');
var bridge = require('../dist/lib/bridge.js');
var h = require('./harness.js');

function run() {
    h.section('Node 错误形状');
    var missing = errors.createError('ENOENT', 'open', '/sdcard/nope.txt');
    h.equal(missing.code, 'ENOENT', 'code');
    h.equal(missing.errno, -2, 'errno');
    h.equal(missing.syscall, 'open', 'syscall');
    h.equal(missing.path, '/sdcard/nope.txt', 'path');
    h.equal(missing.message, "ENOENT: no such file or directory, open '/sdcard/nope.txt'", 'message');

    var rename = errors.createError('EEXIST', 'rename', '/a', '/b');
    h.equal(rename.dest, '/b', 'dest');
    h.equal(rename.message, "EEXIST: file already exists, rename '/a' -> '/b'", 'rename message');

    h.section('Java 异常映射');
    var cases = [
        ['java.io.FileNotFoundException: /sdcard/x', 'ENOENT'],
        ['java.nio.file.NoSuchFileException: /sdcard/x', 'ENOENT'],
        ['java.nio.file.AccessDeniedException: /sdcard/x', 'EACCES'],
        ['java.lang.SecurityException: denied', 'EACCES'],
        ['java.nio.file.FileAlreadyExistsException: /x', 'EEXIST'],
        ['java.nio.file.NotDirectoryException: /x', 'ENOTDIR'],
        ['java.nio.file.DirectoryNotEmptyException: /x', 'ENOTEMPTY'],
        ['java.io.IOException: No space left on device', 'ENOSPC'],
        ['java.io.IOException: Read-only file system', 'EROFS'],
        ['java.io.IOException: something odd', 'EIO'],
        ['com.example.WeirdThing: huh', 'EIO']
    ];
    for (var i = 0; i < cases.length; i += 1) {
        var parsed = errors.parseJavaError(cases[i][0]);
        h.equal(errors.codeForJavaException(parsed.className, parsed.message), cases[i][1],
            'map ' + cases[i][0]);
    }

    var wrapped = errors.withContext(errors.javaError('java.io.FileNotFoundException: /x'), 'stat', '/x');
    h.equal(wrapped.code, 'ENOENT', 'withContext 保留 code');
    h.equal(wrapped.syscall, 'stat', 'withContext 补 syscall');
    h.equal(wrapped.javaClass, 'java.io.FileNotFoundException', 'withContext 保留 javaClass');

    h.section('bridge 解包');
    h.equal(bridge.unwrap('{"success":true,"data":42}', 'test'), 42, 'data 直通');
    h.equal(bridge.unwrap('{"success":true}', 'test') === undefined, false, '无 data 时返回对象');
    h.equal(bridge.normalizeBoolean('true'), true, "normalizeBoolean('true')");
    h.equal(bridge.normalizeBoolean('false'), false, "normalizeBoolean('false')");

    var threw = null;
    try {
        bridge.unwrap('{"success":false,"error":"java.io.FileNotFoundException: /x"}', 'javaCallStatic');
    } catch (error) {
        threw = error;
    }
    h.equal(threw !== null, true, 'success=false 抛错');
    h.equal(threw.code, 'ENOENT', '失败结果映射成 ENOENT');
    h.equal(threw.isJavaError, true, '带 isJavaError 标记');

    threw = null;
    try {
        bridge.unwrap('not json', 'javaCallStatic');
    } catch (error) {
        threw = error;
    }
    h.equal(threw !== null && threw.code === 'ONJ_BRIDGE_PROTOCOL', true, '非 JSON 抛 ONJ_BRIDGE_PROTOCOL');

    h.section('bridge 句柄');
    h.equal(bridge.handleOf({ __javaHandle: 'h1', __javaClass: 'java.io.File' }), 'h1', '从对象取句柄');
    h.equal(bridge.handleOf('h2'), 'h2', '字符串句柄直通');
    threw = null;
    try {
        bridge.handleOf(null);
    } catch (error) {
        threw = error;
    }
    h.equal(threw !== null && threw.code === 'EINVAL', true, '无效实例抛 EINVAL');

    h.section('mock backend 贯通');
    var calls = [];
    bridge.setBackend({
        classExists: function (name) { calls.push(['classExists', name]); return name === 'java.io.File'; },
        callStatic: function (className, methodName, args) {
            calls.push(['callStatic', className, methodName, args]);
            return '/sdcard/app';
        },
        callInstance: function (instance, methodName, args) {
            calls.push(['callInstance', instance, methodName, args]);
            return 'ok';
        },
        newInstance: function (className, args) { return { __javaHandle: 'new', __javaClass: className }; },
        getStaticField: function () { return 1; },
        setStaticField: function () { return undefined; },
        getInstanceField: function () { return 1; },
        setInstanceField: function () { return undefined; },
        getApplicationContext: function () { return { __javaHandle: 'ctx', __javaClass: 'android.content.Context' }; },
        getCurrentActivity: function () { return null; },
        setEnv: function () { return undefined; }
    });
    var paths = require('../dist/lib/paths.js');
    h.equal(paths.filesDir(), 'ok', 'mock 下 filesDir 走 callInstance');
    h.equal(bridge.classExists('java.io.File'), true, 'mock 下 classExists');
    h.equal(bridge.classExists('java.util.List'), false, 'mock 下 classExists 假值');
    bridge.setBackend(null);
}

module.exports = { run: run };
