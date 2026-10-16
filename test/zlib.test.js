'use strict';

/**
 * zlib 双向对拍。
 *
 * 单向验证没有意义：只测"我们能解 Node 的"会漏掉压缩侧错误，
 * 只测"Node 能解我们的"会漏掉解压侧错误。两边都测。
 */

var nodeZlib = require('zlib');
var h = require('./harness.js');
var myZlib = require('../dist/zlib.js');

function lcg(seed) {
    var value = seed >>> 0;
    return function () {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 4294967296;
    };
}

function randomBytes(length, seed) {
    var random = lcg(seed);
    var out = Buffer.alloc(length);
    for (var i = 0; i < length; i += 1) {
        out[i] = Math.floor(random() * 256);
    }
    return out;
}

function repetitive(length, seed) {
    var random = lcg(seed);
    var words = ['alpha ', 'beta ', 'gamma ', 'delta ', '中文 ', 'operit '];
    var out = '';
    while (Buffer.byteLength(out, 'utf8') < length) {
        out += words[Math.floor(random() * words.length)];
    }
    return Buffer.from(out, 'utf8').subarray(0, length);
}

function samples() {
    var out = [];
    var lengths = [0, 1, 2, 3, 63, 64, 65, 255, 256, 1000, 4097, 20000, 70000];
    for (var i = 0; i < lengths.length; i += 1) {
        out.push({ name: 'random(' + lengths[i] + ')', data: randomBytes(lengths[i], 100 + i) });
        out.push({ name: 'repetitive(' + lengths[i] + ')', data: repetitive(lengths[i], 200 + i) });
    }
    out.push({ name: 'text', data: Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(200), 'utf8') });
    out.push({ name: 'zeros-100k', data: Buffer.alloc(100000) });
    return out;
}

function same(mine, theirs, label) {
    var mineHex = Buffer.from(mine).toString('hex');
    var theirsHex = Buffer.from(theirs).toString('hex');
    h.equal(mineHex.length, theirsHex.length, label + ' 长度');
    h.equal(mineHex === theirsHex, true, label);
}

async function run() {
    var corpus = samples();

    h.section('解压：Node 压 -> 我们解');
    for (var i = 0; i < corpus.length; i += 1) {
        var item = corpus[i];
        same(myZlib.inflateRawSync(nodeZlib.deflateRawSync(item.data)), item.data, 'inflateRaw ' + item.name);
        same(myZlib.inflateSync(nodeZlib.deflateSync(item.data)), item.data, 'inflate(zlib) ' + item.name);
        same(myZlib.gunzipSync(nodeZlib.gzipSync(item.data)), item.data, 'gunzip ' + item.name);
    }

    h.section('压缩：我们压 -> Node 解（含各级别）');
    var levels = [0, 1, 6, 9];
    for (var j = 0; j < corpus.length; j += 1) {
        var sample = corpus[j];
        for (var l = 0; l < levels.length; l += 1) {
            var level = levels[l];
            same(nodeZlib.inflateRawSync(myZlib.deflateRawSync(sample.data, { level: level })), sample.data,
                'level' + level + ' deflateRaw->node inflateRaw ' + sample.name);
            same(nodeZlib.inflateSync(myZlib.deflateSync(sample.data, { level: level })), sample.data,
                'level' + level + ' deflate->node inflate ' + sample.name);
            same(nodeZlib.gunzipSync(myZlib.gzipSync(sample.data, { level: level })), sample.data,
                'level' + level + ' gzip->node gunzip ' + sample.name);
        }
    }

    h.section('Node 各级别的输出我们都要能解');
    for (var k = 0; k <= 9; k += 1) {
        var payload = repetitive(30000, 300 + k);
        same(myZlib.inflateRawSync(nodeZlib.deflateRawSync(payload, { level: k })), payload, 'node level ' + k);
    }

    h.section('unzip 自动识别');
    var auto = repetitive(5000, 7);
    same(myZlib.unzipSync(nodeZlib.gzipSync(auto)), auto, 'unzip 识别 gzip');
    same(myZlib.unzipSync(nodeZlib.deflateSync(auto)), auto, 'unzip 识别 zlib');

    h.section('压缩确实压缩了');
    var compressible = Buffer.from('abcabcabc'.repeat(5000), 'utf8');
    var compressed = myZlib.deflateRawSync(compressible, { level: 6 });
    h.equal(compressed.length < compressible.length / 10, true,
        '重复数据被压缩到 1/10 以下（实际 ' + compressed.length + '/' + compressible.length + '）');
    var incompressible = randomBytes(50000, 99);
    var stored = myZlib.deflateRawSync(incompressible, { level: 0 });
    h.equal(nodeZlib.inflateRawSync(stored).length, incompressible.length, 'level 0 走 stored 块且可解');

    h.section('gzip 头部与可选字段');
    var withName = myZlib.gzipSync(Buffer.from('hello'));
    h.equal(withName[0] === 0x1f && withName[1] === 0x8b && withName[2] === 8, true, 'gzip 魔数与 CM');

    var body = nodeZlib.deflateRawSync(Buffer.from('named payload'));
    var header = Buffer.from([0x1f, 0x8b, 0x08, 0x08, 0, 0, 0, 0, 0, 0xff]);
    var nameBytes = Buffer.from('file.txt\u0000', 'latin1');
    var inflated = Buffer.from('named payload');
    var trailer = Buffer.alloc(8);
    trailer.writeUInt32LE(crc32Of(inflated), 0);
    trailer.writeUInt32LE(inflated.length, 4);
    var tricky = Buffer.concat([header, nameBytes, body, trailer]);
    same(myZlib.gunzipSync(tricky), inflated, '跳过 FNAME 字段');

    h.section('错误处理');
    var corrupted = myZlib.gzipSync(Buffer.from('data'));
    corrupted[corrupted.length - 1] ^= 0xff;
    var crcError = null;
    try {
        myZlib.gunzipSync(corrupted);
    } catch (error) {
        crcError = error;
    }
    h.equal(crcError !== null, true, 'gzip 校验和不符要抛错');
    var badZlib = null;
    try {
        myZlib.inflateSync(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    } catch (error) {
        badZlib = error;
    }
    h.equal(badZlib !== null, true, '非法 zlib 头要抛错');
    var badRaw = null;
    try {
        myZlib.inflateRawSync(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    } catch (error) {
        badRaw = error;
    }
    h.equal(badRaw !== null, true, '非法 DEFLATE 块类型要抛错');

    h.section('constants 与未实现项');
    h.equal(myZlib.constants.Z_BEST_COMPRESSION, 9, 'Z_BEST_COMPRESSION');
    h.equal(myZlib.constants.Z_DEFAULT_COMPRESSION, -1, 'Z_DEFAULT_COMPRESSION');
    h.equal(typeof myZlib.createGzip().write, 'function', 'createGzip 返回 Transform（不是抛错）');
    h.equal(typeof myZlib.createBrotliCompress, 'undefined', 'Brotli 未提供');

    h.section('回调形式（真实等待回调）');
    var asyncResult = 'pending';
    myZlib.gzip(Buffer.from('async payload'), function (error, result) {
        asyncResult = error === null ? Buffer.from(result).toString('utf8') : 'error:' + error.message;
    });
    h.equal(asyncResult, 'pending', 'gzip 回调是异步的');
    await new Promise(function (resolve) {
        myZlib.gzip(Buffer.from('async payload'), function (error, result) {
            h.equal(error, null, 'gzip 回调无错误');
            h.equal(Buffer.from(nodeZlib.gunzipSync(result)).toString('utf8'), 'async payload', 'gzip 回调结果是可解的 gzip');
            resolve();
        });
    });
    await new Promise(function (resolve) {
        myZlib.gunzip(myZlib.gzipSync(Buffer.from('roundtrip')), function (error, result) {
            h.equal(error, null, 'gunzip 回调无错误');
            h.equal(Buffer.from(result).toString('utf8'), 'roundtrip', 'gunzip 回调往返一致');
            resolve();
        });
    });
    await new Promise(function (resolve) {
        myZlib.deflate(Buffer.from('deflate payload'), { level: 9 }, function (error, result) {
            h.equal(error, null, 'deflate 回调无错误');
            h.equal(Buffer.from(nodeZlib.inflateSync(result)).toString('utf8'), 'deflate payload', 'deflate 回调结果 Node 可解');
            resolve();
        });
    });
    await new Promise(function (resolve) {
        myZlib.inflate(Buffer.from([1, 2, 3]), function (error) {
            h.equal(error !== null, true, 'inflate 回调把错误交给回调而不是抛出');
            resolve();
        });
    });
}

/** gzip 的 CRC-32，测试里用来手工构造带 FNAME 的流。 */
function crc32Of(buffer) {
    var table = [];
    for (var n = 0; n < 256; n += 1) {
        var c = n;
        for (var k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    var crc = 0xffffffff;
    for (var i = 0; i < buffer.length; i += 1) {
        crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

module.exports = { run: run };
