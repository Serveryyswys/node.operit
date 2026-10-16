'use strict';

/**
 * fs 对拍：node.operit/fs（Node 语义层 + 测试用 Node 驱动）vs Node 自己的 fs。
 *
 * 两侧各用一个临时目录，跑同一套操作序列，比较返回值与错误码。
 * 本库 side 一律用相对路径 —— 其 cwd 由 fs 环境状态机设为测试根，
 * 于是"环境决定路径基准"这条也被一并验证了。
 */

var nodeFs = require('fs');
var nodeOs = require('os');
var nodePath = require('path');

var h = require('./harness.js');
var myFs = require('../dist/fs.js');
var myBuffer = require('../dist/buffer.js').Buffer;
var drivers = require('../dist/lib/fs-driver.js');
var createNodeDriver = require('./node-fs-driver.js').createNodeDriver;

function makeRoot(label) {
    return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'onj-' + label + '-'));
}

function normalizeValue(value, root) {
    var rootSlash = root.split('\\').join('/');
    function walk(input) {
        if (typeof input === 'string') {
            return input.split('\\').join('/').split(rootSlash).join('<ROOT>');
        }
        if (Array.isArray(input)) {
            return input.map(walk);
        }
        if (input instanceof Uint8Array) {
            return 'bytes:' + myBuffer.from(input).toString('hex');
        }
        if (input === undefined) {
            return '<undefined>';
        }
        return input;
    }
    return JSON.stringify(walk(value));
}

function scenario(fsImpl, root, useRelative) {
    var records = [];
    function full(rel) {
        return useRelative ? rel : nodePath.join(root, rel);
    }
    function step(name, body) {
        try {
            records.push(name + ' => ' + normalizeValue(body(), root));
        } catch (error) {
            records.push(name + ' !! ' + (error && error.code ? error.code : String(error)));
        }
    }

    step('exists-missing', function () { return fsImpl.existsSync(full('nope.txt')); });
    step('read-missing', function () { return fsImpl.readFileSync(full('nope.txt'), 'utf8'); });
    step('mkdir-recursive', function () { return fsImpl.mkdirSync(full('d1/d2'), { recursive: true }); });
    step('exists-dir', function () { return fsImpl.existsSync(full('d1/d2')); });
    step('mkdir-existing-nonrecursive', function () { return fsImpl.mkdirSync(full('d1/d2')); });
    step('write-string', function () { return fsImpl.writeFileSync(full('d1/d2/a.txt'), 'hello'); });
    step('read-string', function () { return fsImpl.readFileSync(full('d1/d2/a.txt'), 'utf8'); });
    step('read-buffer-hex', function () { return fsImpl.readFileSync(full('d1/d2/a.txt')).toString('hex'); });
    step('read-base64', function () { return fsImpl.readFileSync(full('d1/d2/a.txt'), 'base64'); });
    step('stat-isFile', function () { return fsImpl.statSync(full('d1/d2/a.txt')).isFile(); });
    step('stat-size', function () { return fsImpl.statSync(full('d1/d2/a.txt')).size; });
    step('stat-isDirectory', function () { return fsImpl.statSync(full('d1/d2')).isDirectory(); });
    step('stat-throwIfNoEntry-false', function () { return fsImpl.statSync(full('nope'), { throwIfNoEntry: false }); });
    step('stat-missing', function () { return fsImpl.statSync(full('nope')); });
    step('append', function () { fsImpl.appendFileSync(full('d1/d2/a.txt'), ' world'); return fsImpl.readFileSync(full('d1/d2/a.txt'), 'utf8'); });
    step('readdir', function () { return fsImpl.readdirSync(full('d1/d2')).slice().sort(); });
    step('readdir-dirents', function () {
        return fsImpl.readdirSync(full('d1/d2'), { withFileTypes: true })
            .map(function (entry) { return entry.name + ':' + entry.isFile() + ':' + entry.isDirectory(); })
            .sort();
    });
    step('readdir-on-file', function () { return fsImpl.readdirSync(full('d1/d2/a.txt')); });
    step('rmdir-nonempty', function () { return fsImpl.rmdirSync(full('d1')); });
    step('unlink-missing', function () { return fsImpl.unlinkSync(full('nope.txt')); });
    step('copy', function () { fsImpl.copyFileSync(full('d1/d2/a.txt'), full('d1/d2/b.txt')); return fsImpl.readFileSync(full('d1/d2/b.txt'), 'utf8'); });
    step('rename', function () { fsImpl.renameSync(full('d1/d2/b.txt'), full('d1/d2/c.txt')); return fsImpl.existsSync(full('d1/d2/c.txt')); });
    step('rename-missing', function () { return fsImpl.renameSync(full('nope'), full('other')); });
    step('write-bytes', function () { fsImpl.writeFileSync(full('bin.dat'), myBuffer.from([0, 1, 2, 255])); return fsImpl.readFileSync(full('bin.dat')).toString('hex'); });
    step('write-exclusive', function () { return fsImpl.writeFileSync(full('wx.txt'), 'first', { flag: 'wx' }); });
    step('write-exclusive-conflict', function () { return fsImpl.writeFileSync(full('wx.txt'), 'second', { flag: 'wx' }); });
    step('write-rplus', function () { fsImpl.writeFileSync(full('wx.txt'), 'XY', { flag: 'r+' }); return fsImpl.readFileSync(full('wx.txt'), 'utf8'); });
    step('write-append-flag', function () { fsImpl.writeFileSync(full('wx.txt'), 'Z', { flag: 'a' }); return fsImpl.readFileSync(full('wx.txt'), 'utf8'); });
    step('truncate', function () { fsImpl.truncateSync(full('d1/d2/a.txt'), 5); return fsImpl.readFileSync(full('d1/d2/a.txt'), 'utf8'); });
    step('access-ok', function () { return fsImpl.accessSync(full('wx.txt')); });
    step('access-missing', function () { return fsImpl.accessSync(full('nope')); });
    step('realpath', function () { return fsImpl.realpathSync(full('wx.txt')); });
    step('lstat', function () { return fsImpl.lstatSync(full('wx.txt')).isFile(); });
    step('mkdir-absolute-missing-parent', function () { return fsImpl.mkdirSync(full('p1/p2')); });
    step('rm-recursive', function () { fsImpl.rmSync(full('d1'), { recursive: true }); return fsImpl.existsSync(full('d1')); });
    step('rm-force-missing', function () { return fsImpl.rmSync(full('gone'), { force: true }); });
    step('mkdtemp', function () { return fsImpl.mkdtempSync(full('tmp-')) ? '<created>' : '<none>'; });

    return records;
}

function run() {
    var myRoot = makeRoot('mine');
    var nodeRoot = makeRoot('node');

    drivers.setDriver(createNodeDriver());
    myFs.env.reset();
    myFs.env.define('test', { root: myRoot });
    myFs.env.use('test');

    h.section('fs 环境状态机');
    h.equal(myFs.env.current(), 'test', '环境已切换到 test');
    h.equal(myFs.env.root(), myRoot, '环境根即测试根');
    var cwdModule = require('../dist/lib/cwd.js');
    h.equal(cwdModule.get(), myRoot, '切环境后 cwd 跟随环境根');
    var threw = null;
    try {
        myFs.env.use('does-not-exist');
    } catch (error) {
        threw = error;
    }
    h.equal(threw !== null && threw.code === 'ONJ_UNKNOWN_ENV', true, '未注册环境抛 ONJ_UNKNOWN_ENV');
    var asyncGuard = null;
    try {
        myFs.env.withEnvironment('test', function () {
            return Promise.resolve(1);
        });
    } catch (error) {
        asyncGuard = error;
    }
    h.equal(asyncGuard !== null && asyncGuard.code === 'ONJ_ENV_ASYNC_SCOPE', true, 'with() 返回 thenable 抛 ONJ_ENV_ASYNC_SCOPE');
    var defined = null;
    try {
        myFs.env.define('sdcard', { root: '/x', writable: true });
    } catch (error) {
        defined = error;
    }
    h.equal(defined !== null && defined.code === 'ONJ_UNKNOWN_ENV', true, '内置环境不可覆盖');

    h.section('fs 与 Node 全量对拍');
    var mine = scenario(myFs, myRoot, true);
    var theirs = scenario(nodeFs, nodeRoot, false);
    h.equal(mine.length, theirs.length, '操作数量一致');
    for (var i = 0; i < Math.max(mine.length, theirs.length); i += 1) {
        h.equal(mine[i], theirs[i], 'step#' + i);
    }

    drivers.setDriver(null);
    myFs.env.reset();
    try {
        nodeFs.rmSync(myRoot, { recursive: true, force: true });
    } catch (ignored) {
        // 清理失败不影响结论
    }
    try {
        nodeFs.rmSync(nodeRoot, { recursive: true, force: true });
    } catch (ignored) {
        // 同上
    }
}

module.exports = { run: run };
