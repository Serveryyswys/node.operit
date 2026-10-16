'use strict';

/**
 * fs 流式接口对拍：createReadStream / createWriteStream 与 Node 的 fs 比语义结果。
 *
 * 两侧各用一个临时目录（本库走相对路径，cwd 由 fs 环境状态机设为该目录），
 * 跑同一套场景后比较：读到的内容、分块数、错误码、写出的文件内容、管道结果。
 */

var nodeFs = require('fs');
var nodeOs = require('os');
var nodePath = require('path');

var h = require('./harness.js');
var myFs = require('../dist/fs.js');
var drivers = require('../dist/lib/fs-driver.js');
var createNodeDriver = require('./node-fs-driver.js').createNodeDriver;

function makeRoot(label) {
    return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'onj-fss-' + label + '-'));
}

function readAll(stream) {
    return new Promise(function (resolve, reject) {
        var chunks = [];
        stream.on('data', function (chunk) { chunks.push(Buffer.from(chunk).toString('utf8')); });
        stream.on('end', function () { resolve({ text: chunks.join('|'), count: chunks.length }); });
        stream.on('error', reject);
    });
}

function readErrorOf(stream) {
    return new Promise(function (resolve) {
        stream.on('data', function () { /* 需要流动起来才会触发读取 */ });
        stream.on('error', function (error) { resolve(error && error.code ? error.code : 'error'); });
        stream.on('end', function () { resolve('no-error'); });
    });
}

function writeAll(stream, chunks) {
    return new Promise(function (resolve, reject) {
        stream.on('finish', function () { resolve('finished'); });
        stream.on('error', reject);
        for (var i = 0; i < chunks.length; i += 1) {
            stream.write(chunks[i]);
        }
        stream.end();
    });
}

function pipeThrough(source, destination) {
    return new Promise(function (resolve, reject) {
        destination.on('finish', function () { resolve('piped'); });
        destination.on('error', reject);
        source.on('error', reject);
        source.pipe(destination);
    });
}

async function scenario(fsImpl, root, useRelative) {
    var out = {};
    function full(rel) {
        return useRelative ? rel : nodePath.join(root, rel);
    }
    // 两侧各自准备同一份源文件
    nodeFs.writeFileSync(nodePath.join(root, 'src.txt'), 'hello stream world');

    var whole = await readAll(fsImpl.createReadStream(full('src.txt')));
    out.whole = whole.text;

    var range = await readAll(fsImpl.createReadStream(full('src.txt'), { start: 6, end: 11 }));
    out.range = range.text;

    var encoded = await readAll(fsImpl.createReadStream(full('src.txt'), { encoding: 'utf8' }));
    out.encoded = encoded.text;

    var chunked = await readAll(fsImpl.createReadStream(full('src.txt'), { highWaterMark: 4 }));
    out.chunkedText = chunked.text;
    out.chunkedCount = chunked.count;

    out.missing = await readErrorOf(fsImpl.createReadStream(full('nope.txt')));

    out.writeResult = await writeAll(fsImpl.createWriteStream(full('out.txt')), ['alpha', 'beta', 'gamma']);
    out.writtenContent = nodeFs.readFileSync(nodePath.join(root, 'out.txt'), 'utf8');

    out.pipeResult = await pipeThrough(
        fsImpl.createReadStream(full('src.txt')),
        fsImpl.createWriteStream(full('copy.txt'))
    );
    out.copiedContent = nodeFs.readFileSync(nodePath.join(root, 'copy.txt'), 'utf8');

    out.emptyResult = await writeAll(fsImpl.createWriteStream(full('empty.txt')), []);
    out.emptyExists = nodeFs.existsSync(nodePath.join(root, 'empty.txt'));
    out.emptySize = out.emptyExists ? nodeFs.statSync(nodePath.join(root, 'empty.txt')).size : -1;

    out.appendResult = await writeAll(fsImpl.createWriteStream(full('append.txt'), { flags: 'a' }), ['x']);
    out.appendResult2 = await writeAll(fsImpl.createWriteStream(full('append.txt'), { flags: 'a' }), ['y']);
    out.appendContent = nodeFs.readFileSync(nodePath.join(root, 'append.txt'), 'utf8');

    return out;
}

async function run() {
    var myRoot = makeRoot('mine');
    var nodeRoot = makeRoot('node');

    drivers.setDriver(createNodeDriver());
    myFs.env.reset();
    myFs.env.define('fs-stream-test', { root: myRoot });
    myFs.env.use('fs-stream-test');

    h.section('fs 流式接口对拍（本库 vs Node）');
    var mine = await scenario(myFs, myRoot, true);
    var theirs = await scenario(nodeFs, nodeRoot, false);

    var keys = Object.keys(theirs).sort();
    for (var i = 0; i < keys.length; i += 1) {
        h.equal(JSON.stringify(mine[keys[i]]), JSON.stringify(theirs[keys[i]]), keys[i]);
    }

    h.section('结构');
    h.equal(typeof myFs.createReadStream, 'function', 'createReadStream 存在');
    h.equal(typeof myFs.createWriteStream, 'function', 'createWriteStream 存在');
    var opened = await new Promise(function (resolve) {
        var stream = myFs.createReadStream('src.txt');
        stream.on('open', function (fd) { resolve(fd === null ? 'null-fd' : typeof fd); });
        stream.on('error', function () { resolve('error'); });
    });
    h.equal(opened, 'null-fd', "'open' 事件如实给出 null（本库没有真实 fd）");

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
