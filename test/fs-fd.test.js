'use strict';

/**
 * fd 系列对拍：openSync/readSync/writeSync/closeSync/fstatSync/ftruncateSync/fsyncSync
 * 以及它们的回调形式与 fs/promises 版本，与 Node 的 fs 比语义结果。
 *
 * 两侧各一个临时目录；本库走相对路径（cwd 由 fs 环境状态机设为该目录）。
 * fd 的具体数值不做比较（两侧编号空间不同），只比较行为与错误码。
 */

var nodeFs = require('fs');
var nodeOs = require('os');
var nodePath = require('path');

var h = require('./harness.js');
var myFs = require('../dist/fs.js');
var myPromises = require('../dist/fs/promises.js');
var drivers = require('../dist/lib/fs-driver.js');
var createNodeDriver = require('./node-fs-driver.js').createNodeDriver;

function makeRoot(label) {
    return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'onj-fd-' + label + '-'));
}

function text(value) {
    return value === null || value === undefined ? '<none>' : Buffer.from(value).toString('utf8');
}

function capture(operation) {
    try {
        return { value: operation() };
    } catch (error) {
        return { code: error && error.code ? error.code : String(error) };
    }
}

async function scenario(fsImpl, root, useRelative, promises) {
    var out = {};
    function full(rel) {
        return useRelative ? rel : nodePath.join(root, rel);
    }

    // ---- 写：open('w') -> writeSync(string) -> close
    var writeFd = fsImpl.openSync(full('a.txt'), 'w');
    out.openReturnsNumber = typeof writeFd === 'number' && writeFd >= 3;
    out.writeString = capture(function () { return fsImpl.writeSync(writeFd, 'hello world'); }).value;
    fsImpl.closeSync(writeFd);
    out.afterWrite = nodeFs.readFileSync(nodePath.join(root, 'a.txt'), 'utf8');

    // ---- 读：定位读、顺序读、定位读不移动指针
    var readFd = fsImpl.openSync(full('a.txt'), 'r');
    var first = Buffer.alloc(5);
    out.positionedReadCount = fsImpl.readSync(readFd, first, 0, 5, 0);
    out.positionedReadData = first.toString('utf8');
    var second = Buffer.alloc(5);
    out.sequentialReadCount = fsImpl.readSync(readFd, second, 0, 5, null);
    out.sequentialReadData = second.toString('utf8');
    var third = Buffer.alloc(5);
    out.repeatAtZero = fsImpl.readSync(readFd, third, 0, 5, 0);
    out.repeatAtZeroData = third.toString('utf8');
    var fourth = Buffer.alloc(5);
    out.afterPositionedRead = fsImpl.readSync(readFd, fourth, 0, 5, null);
    out.afterPositionedReadData = fourth.toString('utf8');

    // ---- fstat / ftruncate / fsync
    out.fstatSize = fsImpl.fstatSync(readFd).size;
    out.fstatIsFile = fsImpl.fstatSync(readFd).isFile();
    out.fsyncResult = capture(function () { return fsImpl.fsyncSync(readFd); }).value;
    out.ftruncateResult = capture(function () { return fsImpl.ftruncateSync(readFd, 5); }).value;
    out.sizeAfterTruncate = fsImpl.fstatSync(readFd).size;
    fsImpl.closeSync(readFd);

    // ---- 关闭后使用 -> EBADF
    out.closedRead = capture(function () { return fsImpl.readSync(readFd, Buffer.alloc(1), 0, 1, 0); }).code;
    out.closedClose = capture(function () { return fsImpl.closeSync(readFd); }).code;

    // ---- 错误路径
    out.missingOpen = capture(function () { return fsImpl.openSync(full('nope.txt'), 'r'); }).code;
    var exclusiveFd = fsImpl.openSync(full('b.txt'), 'w');
    fsImpl.closeSync(exclusiveFd);
    out.exclusiveOpen = capture(function () { return fsImpl.openSync(full('b.txt'), 'wx'); }).code;

    // ---- 带 offset/length/position 的写
    var bufferFd = fsImpl.openSync(full('c.txt'), 'w');
    fsImpl.writeSync(bufferFd, Buffer.from('0123456789'));
    out.bufferWriteCount = fsImpl.writeSync(bufferFd, Buffer.from('XYZW'), 1, 2, 4);
    out.stringWriteWithPosition = fsImpl.writeSync(bufferFd, 'ab', 0, 'utf8');
    fsImpl.closeSync(bufferFd);
    out.bufferWriteResult = nodeFs.readFileSync(nodePath.join(root, 'c.txt'), 'utf8');

    // ---- 'a' 追加
    var appendFd = fsImpl.openSync(full('a.txt'), 'a');
    fsImpl.writeSync(appendFd, '!');
    fsImpl.closeSync(appendFd);
    out.appended = nodeFs.readFileSync(nodePath.join(root, 'a.txt'), 'utf8');

    // ---- 回调形式
    out.callbackOpen = await new Promise(function (resolve) {
        fsImpl.open(full('cb.txt'), 'w', function (error, descriptor) {
            if (error !== null && error !== undefined) {
                resolve('error:' + error.code);
                return;
            }
            resolve('opened:' + (typeof descriptor === 'number'));
        });
    });
    var callbackFd = fsImpl.openSync(full('cb.txt'), 'r');
    out.callbackFstat = await new Promise(function (resolve) {
        fsImpl.fstat(callbackFd, function (error, stats) {
            resolve(error ? 'error' : 'size:' + stats.size);
        });
    });
    out.callbackRead = await new Promise(function (resolve) {
        var buffer = Buffer.alloc(4);
        fsImpl.read(callbackFd, buffer, 0, 4, 0, function (error, count) {
            resolve(error ? 'error' : count + ':' + buffer.toString('utf8'));
        });
    });
    out.callbackClose = await new Promise(function (resolve) {
        fsImpl.close(callbackFd, function (error) {
            resolve(error ? 'error' : 'closed');
        });
    });
    out.callbackExists = await new Promise(function (resolve) {
        fsImpl.exists(full('a.txt'), function (value) { resolve(value); });
    });
    out.callbackReadFile = await new Promise(function (resolve) {
        fsImpl.readFile(full('a.txt'), 'utf8', function (error, data) {
            resolve(error ? 'error' : text(data));
        });
    });

    // ---- fs/promises（Node 的 open 返回 FileHandle，不是裸 fd）
    var writeHandle = await promises.open(full('p.txt'), 'w');
    out.handleShape = typeof writeHandle === 'object' && typeof writeHandle.fd === 'number';
    var writeResult = await writeHandle.write('promised');
    out.handleWrite = [writeResult.bytesWritten, writeResult.buffer];
    await writeHandle.close();
    out.promisesContent = nodeFs.readFileSync(nodePath.join(root, 'p.txt'), 'utf8');

    var readHandle = await promises.open(full('p.txt'), 'r');
    out.handleReadFile = await readHandle.readFile('utf8');
    out.handleStatSize = (await readHandle.stat()).size;
    var handleBuffer = Buffer.alloc(4);
    var readResult = await readHandle.read(handleBuffer, 0, 4, 0);
    out.handleReadCount = readResult.bytesRead;
    out.handleReadData = Buffer.from(readResult.buffer).toString('utf8');
    out.handleDoubleClose = await readHandle.close().then(function () { return 'ok'; }, function (error) { return error.code; });
    out.handleReadAfterClose = await readHandle.read(Buffer.alloc(1), 0, 1, 0).then(function () { return 'read'; }, function (error) { return error.code; });
    out.promisesReadFile = await promises.readFile(full('p.txt'), 'utf8');
    out.handleClass = typeof promises.FileHandle;

    return out;
}

async function run() {
    var myRoot = makeRoot('mine');
    var nodeRoot = makeRoot('node');

    drivers.setDriver(createNodeDriver());
    myFs.env.reset();
    myFs.env.define('fd-test', { root: myRoot });
    myFs.env.use('fd-test');

    h.section('fd 系列对拍（本库 vs Node）');
    var mine = await scenario(myFs, myRoot, true, myPromises);
    var theirs = await scenario(nodeFs, nodeRoot, false, nodeFs.promises);

    var keys = Object.keys(theirs).sort();
    for (var i = 0; i < keys.length; i += 1) {
        h.equal(JSON.stringify(mine[keys[i]]), JSON.stringify(theirs[keys[i]]), keys[i]);
    }

    h.section('fd 相关结构与未实现项');
    h.equal(typeof myFs.openSync, 'function', 'openSync');
    h.equal(typeof myFs.readSync, 'function', 'readSync');
    h.equal(typeof myFs.writeSync, 'function', 'writeSync');
    h.equal(typeof myFs.closeSync, 'function', 'closeSync');
    h.equal(typeof myFs.fstatSync, 'function', 'fstatSync');
    h.equal(typeof myFs.ftruncateSync, 'function', 'ftruncateSync');
    h.equal(typeof myFs.fsyncSync, 'function', 'fsyncSync');
    h.equal(typeof myFs.readFile, 'function', 'readFile（回调形式）');
    h.equal(typeof myFs.exists, 'function', 'exists（回调形式）');
    h.equal(typeof myPromises.open, 'function', 'fs/promises.open');

    drivers.setDriver(null);
    myFs.env.reset();
    try {
        nodeFs.rmSync(myRoot, { recursive: true, force: true });
        nodeFs.rmSync(nodeRoot, { recursive: true, force: true });
    } catch (ignored) {
        // 清理失败不影响结论
    }
}

module.exports = { run: run };
