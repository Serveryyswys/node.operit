'use strict';

/**
 * Buffer 对拍：本库实现 vs Node 自带 Buffer。
 * 覆盖编解码、切片视图语义、比较、数字读写与序列化。
 */

var nodeBuffer = require('buffer').Buffer;
var myModule = require('../dist/buffer.js');
var MyBuffer = myModule.Buffer;
var h = require('./harness.js');

var ENCODINGS = ['utf8', 'hex', 'base64', 'latin1', 'ascii', 'utf16le'];
var STRINGS = [
    '',
    'a',
    'hello world',
    '中文',
    '\u{1F680} emoji',
    '\u0000\u007f\u0080\u07ff\u0800\uffff',
    'abc123',
    'AB cd 12',
    'deadbeef',
    'aGVsbG8='
];

function hexOf(value) {
    return nodeBuffer.from(value).toString('hex');
}

function lcg(seed) {
    var value = seed >>> 0;
    return function () {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 4294967296;
    };
}

function randomBytes(length, seed) {
    var random = lcg(seed);
    var out = new Uint8Array(length);
    for (var i = 0; i < length; i += 1) {
        out[i] = Math.floor(random() * 256);
    }
    return out;
}

function run() {
    h.section('Buffer.from / toString 全编码');
    for (var e = 0; e < ENCODINGS.length; e += 1) {
        var encoding = ENCODINGS[e];
        for (var s = 0; s < STRINGS.length; s += 1) {
            var value = STRINGS[s];
            var mine;
            var theirs;
            try {
                mine = MyBuffer.from(value, encoding).toString('hex');
            } catch (error) {
                mine = 'THREW:' + error.constructor.name;
            }
            try {
                theirs = nodeBuffer.from(value, encoding).toString('hex');
            } catch (error) {
                theirs = 'THREW:' + error.constructor.name;
            }
            h.equal(mine, theirs, 'from(' + JSON.stringify(value) + ', ' + encoding + ').hex');
        }
    }

    h.section('toString 全编码');
    var payload = randomBytes(64, 20261004);
    for (var t = 0; t < ENCODINGS.length; t += 1) {
        var enc = ENCODINGS[t];
        h.equal(MyBuffer.from(payload).toString(enc), nodeBuffer.from(payload).toString(enc), 'toString(' + enc + ')');
    }
    h.equal(MyBuffer.from(payload).toString('utf8', 3, 20), nodeBuffer.from(payload).toString('utf8', 3, 20), 'toString 带区间');
    h.equal(MyBuffer.from(payload).toString('base64', 0, 5), nodeBuffer.from(payload).toString('base64', 0, 5), 'toString base64 带区间');

    h.section('alloc / concat / byteLength');
    h.equal(hexOf(MyBuffer.alloc(8, 7)), hexOf(nodeBuffer.alloc(8, 7)), 'alloc(8, 7)');
    h.equal(hexOf(MyBuffer.alloc(4, 'ab')), hexOf(nodeBuffer.alloc(4, 'ab')), "alloc(4, 'ab')");
    h.equal(hexOf(MyBuffer.alloc(0)), hexOf(nodeBuffer.alloc(0)), 'alloc(0)');
    h.equal(MyBuffer.byteLength('中文', 'utf8'), nodeBuffer.byteLength('中文', 'utf8'), 'byteLength utf8');
    h.equal(MyBuffer.byteLength('aGVsbG8=', 'base64'), nodeBuffer.byteLength('aGVsbG8=', 'base64'), 'byteLength base64');
    var parts = [randomBytes(5, 1), randomBytes(9, 2), randomBytes(3, 3)];
    h.equal(
        hexOf(MyBuffer.concat(parts.map(function (p) { return MyBuffer.from(p); }))),
        hexOf(nodeBuffer.concat(parts.map(function (p) { return nodeBuffer.from(p); }))),
        'concat 全部'
    );
    h.equal(
        hexOf(MyBuffer.concat(parts.map(function (p) { return MyBuffer.from(p); }), 6)),
        hexOf(nodeBuffer.concat(parts.map(function (p) { return nodeBuffer.from(p); }), 6)),
        'concat 截断到 6'
    );

    h.section('slice / subarray 视图语义');
    var base = MyBuffer.from(payload);
    var view = base.slice(4, 12);
    var nodeView = nodeBuffer.from(payload).slice(4, 12);
    h.equal(view.length, nodeView.length, 'slice 长度');
    view[0] = 255;
    var nodeBase = nodeBuffer.from(payload);
    var nodeView2 = nodeBase.slice(4, 12);
    nodeView2[0] = 255;
    h.equal(base[4], nodeBase[4], 'slice 是视图：改视图影响原缓冲');
    h.equal(MyBuffer.isBuffer(view), true, 'slice 返回 Buffer');
    h.equal(view instanceof Uint8Array, true, 'Buffer 也是 Uint8Array');
    h.equal(base.subarray(2, 6).length, nodeBuffer.from(payload).subarray(2, 6).length, 'subarray 长度');

    h.section('搜索 / 比较 / 拷贝');
    var haystack = MyBuffer.from('hello world hello');
    var nodeHaystack = nodeBuffer.from('hello world hello');
    h.equal(haystack.indexOf('hello'), nodeHaystack.indexOf('hello'), "indexOf('hello')");
    h.equal(haystack.indexOf('hello', 1), nodeHaystack.indexOf('hello', 1), "indexOf('hello', 1)");
    h.equal(haystack.lastIndexOf('hello'), nodeHaystack.lastIndexOf('hello'), "lastIndexOf('hello')");
    h.equal(haystack.indexOf(0x6f), nodeHaystack.indexOf(0x6f), 'indexOf(0x6f)');
    h.equal(haystack.includes('world'), nodeHaystack.includes('world'), "includes('world')");
    h.equal(haystack.includes('zzz'), nodeHaystack.includes('zzz'), "includes('zzz')");
    h.equal(MyBuffer.from('abc').equals(nodeBuffer.from('abc')), true, 'equals 自身类型');
    h.equal(MyBuffer.from('abc').equals(MyBuffer.from('abd')), false, 'equals 不等');
    h.equal(MyBuffer.compare(MyBuffer.from('abc'), MyBuffer.from('abd')), nodeBuffer.compare(nodeBuffer.from('abc'), nodeBuffer.from('abd')), 'compare abc/abd');
    h.equal(MyBuffer.compare(MyBuffer.from('abc'), MyBuffer.from('abc')), 0, 'compare 相等');
    var copyTarget = MyBuffer.alloc(10);
    var nodeCopyTarget = nodeBuffer.alloc(10);
    var copied = copyTarget.copy(MyBuffer.from('xyz'), 2, 0, 3);
    var nodeCopied = nodeCopyTarget.copy(nodeBuffer.from('xyz'), 2, 0, 3);
    h.equal(copied, nodeCopied, 'copy 返回值');
    h.equal(hexOf(copyTarget), hexOf(nodeCopyTarget), 'copy 结果');
    h.equal(hexOf(MyBuffer.from('abc').fill(120, 1, 3)), hexOf(nodeBuffer.from('abc').fill(120, 1, 3)), 'fill 区间');

    h.section('数字读写');
    var numeric = MyBuffer.alloc(16);
    var nodeNumeric = nodeBuffer.alloc(16);
    numeric.writeUInt8(200, 0);
    nodeNumeric.writeUInt8(200, 0);
    numeric.writeUInt16LE(513, 1);
    nodeNumeric.writeUInt16LE(513, 1);
    numeric.writeUInt16BE(513, 3);
    nodeNumeric.writeUInt16BE(513, 3);
    numeric.writeUInt32LE(4000000000, 5);
    nodeNumeric.writeUInt32LE(4000000000, 5);
    numeric.writeUInt32BE(4000000000, 9);
    nodeNumeric.writeUInt32BE(4000000000, 9);
    numeric.writeInt8(-1, 13);
    nodeNumeric.writeInt8(-1, 13);
    numeric.writeInt16LE(-300, 14);
    nodeNumeric.writeInt16LE(-300, 14);
    h.equal(hexOf(numeric), hexOf(nodeNumeric), '写入结果一致');
    h.equal(numeric.readUInt8(0), nodeNumeric.readUInt8(0), 'readUInt8');
    h.equal(numeric.readUInt16LE(1), nodeNumeric.readUInt16LE(1), 'readUInt16LE');
    h.equal(numeric.readUInt16BE(3), nodeNumeric.readUInt16BE(3), 'readUInt16BE');
    h.equal(numeric.readUInt32LE(5), nodeNumeric.readUInt32LE(5), 'readUInt32LE');
    h.equal(numeric.readUInt32BE(9), nodeNumeric.readUInt32BE(9), 'readUInt32BE');
    h.equal(numeric.readInt8(13), nodeNumeric.readInt8(13), 'readInt8');
    h.equal(numeric.readInt16LE(14), nodeNumeric.readInt16LE(14), 'readInt16LE');
    h.equal(numeric.writeUInt8(1, 0), nodeNumeric.writeUInt8(1, 0), 'writeUInt8 返回下一个偏移');

    h.section('write / toJSON / 边界');
    var writable = MyBuffer.alloc(8);
    var nodeWritable = nodeBuffer.alloc(8);
    h.equal(writable.write('ab', 1), nodeWritable.write('ab', 1), 'write 返回写入字节数');
    h.equal(hexOf(writable), hexOf(nodeWritable), 'write 结果');
    h.equal(writable.write('abcdef', 0, 3), nodeWritable.write('abcdef', 0, 3), 'write 带长度');
    h.deepEqual(MyBuffer.from([1, 2, 300]).toJSON(), nodeBuffer.from([1, 2, 300]).toJSON(), 'toJSON');
    h.equal(hexOf(MyBuffer.from([1, 2, 300])), hexOf(nodeBuffer.from([1, 2, 300])), 'from 数组按 255 截断');
    h.equal(MyBuffer.isBuffer(MyBuffer.alloc(1)), true, 'isBuffer');
    h.equal(MyBuffer.isBuffer(new Uint8Array(1)), false, 'isBuffer 对普通 Uint8Array 为假');
    h.equal(MyBuffer.isEncoding('utf8'), true, 'isEncoding utf8');
    h.equal(MyBuffer.isEncoding('nope'), false, 'isEncoding nope');
    h.equal(myModule.constants.MAX_LENGTH, require('buffer').constants.MAX_LENGTH, 'constants.MAX_LENGTH');

    var threw = false;
    try {
        MyBuffer.from('x', 'nope');
    } catch (error) {
        threw = error instanceof TypeError;
    }
    h.equal(threw, true, '未知编码抛 TypeError');
    threw = false;
    try {
        MyBuffer.alloc(-1);
    } catch (error) {
        threw = error instanceof RangeError;
    }
    h.equal(threw, true, 'alloc 负数抛 RangeError');
}

module.exports = { run: run };
