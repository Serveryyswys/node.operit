'use strict';

/**
 * stream 对拍：同样的场景分别跑在本库与 Node 的 stream 上，比较**语义结果**
 * （收到的数据、终点事件集合、背压返回值、错误传播），而不是逐拍的事件时序 ——
 * 本库用 queueMicrotask 调度，与 Node 的 nextTick 同类但不必逐拍相同。
 */

var nodeStream = require('stream');
var h = require('./harness.js');
var myStream = require('../dist/stream.js');
var myZlib = require('../dist/zlib.js');
var nodeZlib = require('zlib');

function once(emitter, event) {
    return new Promise(function (resolve) {
        emitter.once(event, resolve);
    });
}

function collectText(stream) {
    var chunks = [];
    stream.on('data', function (chunk) {
        chunks.push(Buffer.from(chunk).toString('utf8'));
    });
    return chunks;
}

function normalize(value) {
    return JSON.stringify(value);
}

// ------------------------------------------------------------------ 场景

async function scenarioPassThrough(streamMod) {
    var events = [];
    var pass = new streamMod.PassThrough();
    var chunks = collectText(pass);
    pass.on('end', function () { events.push('end'); });
    pass.on('finish', function () { events.push('finish'); });
    pass.write('one');
    pass.write('two');
    pass.end('three');
    await once(pass, 'end');
    return { chunks: chunks, events: events.slice().sort() };
}

async function scenarioTransform(streamMod) {
    var upper = new streamMod.Transform({
        transform: function (chunk, encoding, callback) {
            callback(null, Buffer.from(chunk).toString('utf8').toUpperCase());
        }
    });
    var chunks = collectText(upper);
    upper.write('abc');
    upper.end('def');
    await once(upper, 'end');
    return { chunks: chunks };
}

async function scenarioPipe(streamMod) {
    var collected = [];
    var sink = new streamMod.Writable({
        write: function (chunk, encoding, callback) {
            collected.push(Buffer.from(chunk).toString('utf8'));
            callback();
        }
    });
    var source = streamMod.Readable.from(['alpha', 'beta', 'gamma']);
    source.pipe(sink);
    await once(sink, 'finish');
    return { collected: collected.join('|') };
}

async function scenarioPipelineCallback(streamMod) {
    var collected = [];
    var result = await new Promise(function (resolve) {
        streamMod.pipeline(
            streamMod.Readable.from(['x', 'y', 'z']),
            new streamMod.Transform({
                transform: function (chunk, encoding, callback) {
                    callback(null, Buffer.from(chunk).toString('utf8') + '!');
                }
            }),
            new streamMod.Writable({
                write: function (chunk, encoding, callback) {
                    collected.push(Buffer.from(chunk).toString('utf8'));
                    callback();
                }
            }),
            function (error) {
                resolve(error === null || error === undefined ? 'ok' : 'error:' + error.message);
            }
        );
    });
    return { result: result, collected: collected.join('|') };
}

async function scenarioPipelinePromise(streamMod) {
    var collected = [];
    // Promise 形式只在 stream/promises 上（Node 的 stream.pipeline 不给回调会抛）
    await streamMod.promises.pipeline(
        streamMod.Readable.from(['p', 'q']),
        new streamMod.Writable({
            write: function (chunk, encoding, callback) {
                collected.push(Buffer.from(chunk).toString('utf8'));
                callback();
            }
        })
    );
    return { collected: collected.join('|') };
}

async function scenarioError(streamMod) {
    var outcome = await new Promise(function (resolve) {
        streamMod.pipeline(
            streamMod.Readable.from(['boom']),
            new streamMod.Transform({
                transform: function (chunk, encoding, callback) {
                    callback(new Error('exploded'));
                }
            }),
            new streamMod.Writable({
                write: function (chunk, encoding, callback) { callback(); }
            }),
            function (error) {
                resolve(error === null || error === undefined ? 'no-error' : error.message);
            }
        );
    });
    return { outcome: outcome };
}

function scenarioBackpressure(streamMod) {
    var sink = new streamMod.Writable({
        highWaterMark: 4,
        write: function (chunk, encoding, callback) {
            void chunk;
            void callback;
            // 故意不回调，模拟慢速消费
        }
    });
    return { first: sink.write('aaaaaaaa') };
}

async function scenarioAsyncIterator(streamMod) {
    var seen = [];
    var readable = streamMod.Readable.from(['a', 'b', 'c']);
    for await (var chunk of readable) {
        seen.push(Buffer.from(chunk).toString('utf8'));
    }
    return { seen: seen.join('') };
}

async function scenarioFinished(streamMod) {
    var pass = new streamMod.PassThrough();
    // 必须先附着 data 监听器：否则可读侧停在暂停态，'end' 本来就不会发（Node 亦然）
    var chunks = collectText(pass);
    var finishedResult = new Promise(function (resolve) {
        streamMod.finished(pass, function (error) {
            resolve(error === null || error === undefined ? 'done' : 'error');
        });
    });
    pass.end('data');
    await once(pass, 'end');
    return { finished: await finishedResult, chunks: chunks.join('') };
}

async function scenarioZlibStreaming() {
    var source = 'The quick brown fox. '.repeat(50);
    var gzipped = [];
    await myStream.promises.pipeline(
        myStream.Readable.from([source]),
        myZlib.createGzip(),
        new myStream.Writable({
            write: function (chunk, encoding, callback) {
                gzipped.push(Buffer.from(chunk));
                callback();
            }
        })
    );
    var buffer = Buffer.concat(gzipped);
    var viaNode = nodeZlib.gunzipSync(buffer).toString('utf8');
    var viaMine = myZlib.gunzipSync(buffer).toString('utf8');

    var inflated = [];
    await myStream.promises.pipeline(
        myStream.Readable.from([nodeZlib.gzipSync(Buffer.from(source))]),
        myZlib.createGunzip(),
        new myStream.Writable({
            write: function (chunk, encoding, callback) {
                inflated.push(Buffer.from(chunk));
                callback();
            }
        })
    );
    return {
        gzipSize: buffer.length < Buffer.byteLength(source) ? 'smaller' : 'not-smaller',
        viaNode: viaNode === source ? 'ok' : 'mismatch',
        viaMine: viaMine === source ? 'ok' : 'mismatch',
        inflated: Buffer.concat(inflated).toString('utf8') === source ? 'ok' : 'mismatch'
    };
}

// ------------------------------------------------------------------ 运行

async function run() {
    var scenarios = [
        ['PassThrough', scenarioPassThrough],
        ['Transform', scenarioTransform],
        ['pipe', scenarioPipe],
        ['pipeline(callback)', scenarioPipelineCallback],
        ['pipeline(promise)', scenarioPipelinePromise],
        ['error 传播', scenarioError],
        ['backpressure', scenarioBackpressure],
        ['asyncIterator', scenarioAsyncIterator],
        ['finished', scenarioFinished]
    ];

    h.section('stream 场景对拍（本库 vs Node）');
    for (var i = 0; i < scenarios.length; i += 1) {
        var name = scenarios[i][0];
        var scenario = scenarios[i][1];
        var mine;
        var theirs;
        try {
            mine = await scenario(myStream);
        } catch (error) {
            mine = { threw: String(error && error.message ? error.message : error) };
        }
        try {
            theirs = await scenario(nodeStream);
        } catch (error) {
            theirs = { threw: String(error && error.message ? error.message : error) };
        }
        h.equal(normalize(mine), normalize(theirs), name);
    }

    h.section('zlib 流式接口');
    var zlibResult = await scenarioZlibStreaming();
    h.equal(zlibResult.gzipSize, 'smaller', 'createGzip 的输出确实变小');
    h.equal(zlibResult.viaNode, 'ok', 'createGzip 的输出 Node 能解');
    h.equal(zlibResult.viaMine, 'ok', 'createGzip 的输出我们能解');
    h.equal(zlibResult.inflated, 'ok', 'createGunzip 能解 Node 的输出');

    h.section('结构与未实现项');
    h.equal(typeof myStream.Readable, 'function', 'Readable 存在');
    h.equal(typeof myStream.Writable, 'function', 'Writable 存在');
    h.equal(typeof myStream.Duplex, 'function', 'Duplex 存在');
    h.equal(typeof myStream.Transform, 'function', 'Transform 存在');
    h.equal(typeof myStream.PassThrough, 'function', 'PassThrough 存在');
    h.equal(typeof myStream.pipeline, 'function', 'pipeline 存在');
    h.equal(typeof myStream.finished, 'function', 'finished 存在');
    h.equal(typeof myStream.promises.pipeline, 'function', 'stream.promises.pipeline 存在');
    h.equal(typeof require('../dist/stream/promises.js').pipeline, 'function', 'stream/promises 子路径');
    h.equal(myStream.isReadable(new myStream.Readable()), true, 'isReadable');
    h.equal(myStream.isWritable(new myStream.Writable()), true, 'isWritable');
    var duplicate = new streamDuplicate();
    h.equal(duplicate.ok, true, 'Transform 同时具备读写两侧');
}

function streamDuplicate() {
    var transform = new myStream.Transform({
        transform: function (chunk, encoding, callback) { callback(null, chunk); }
    });
    this.ok = transform.writable === true && transform.readable === true;
}

module.exports = { run: run };
