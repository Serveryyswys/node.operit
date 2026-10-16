'use strict';

var nodeBuffer = require('buffer').Buffer;
var bytes = require('../dist/lib/bytes.js');
var h = require('./harness.js');

function randomBytes(length, seed) {
    var value = seed >>> 0;
    var out = new Uint8Array(length);
    for (var i = 0; i < length; i += 1) {
        value = (value * 1664525 + 1013904223) >>> 0;
        out[i] = value & 255;
    }
    return out;
}

function run() {
    h.section('base64');
    var samples = [0, 1, 2, 3, 4, 5, 16, 255, 1000, 4097];
    for (var i = 0; i < samples.length; i += 1) {
        var data = randomBytes(samples[i], 42 + i);
        var mine = bytes.encodeBase64(data);
        var theirs = nodeBuffer.from(data).toString('base64');
        h.equal(mine, theirs, 'encodeBase64(' + samples[i] + ' bytes)');
        var roundTrip = bytes.decodeBase64(mine);
        h.equal(nodeBuffer.from(roundTrip).toString('hex'), nodeBuffer.from(data).toString('hex'),
            'decodeBase64(' + samples[i] + ' bytes)');
    }

    h.section('latin1');
    for (var j = 0; j < samples.length; j += 1) {
        var latin = randomBytes(samples[j], 900 + j);
        var text = bytes.bytesToLatin1(latin);
        h.equal(nodeBuffer.from(text, 'latin1').toString('hex'), nodeBuffer.from(latin).toString('hex'),
            'bytesToLatin1(' + samples[j] + ' bytes)');
        h.equal(nodeBuffer.from(bytes.latin1ToBytes(text)).toString('hex'), nodeBuffer.from(latin).toString('hex'),
            'latin1ToBytes(' + samples[j] + ' bytes)');
    }

    h.section('通道切换');
    var payload = randomBytes(64, 7);
    bytes.setChannel('base64');
    h.equal(bytes.getChannel(), 'base64', '默认通道为 base64');
    h.equal(bytes.decode(bytes.encode(payload)).length, payload.length, 'base64 通道往返');
    bytes.setChannel('latin1');
    h.equal(bytes.decode(bytes.encode(payload)).length, payload.length, 'latin1 通道往返');
    var threw = false;
    try {
        bytes.setChannel('utf16');
    } catch (error) {
        threw = error.code === 'ONJ_BRIDGE_PROTOCOL';
    }
    h.equal(threw, true, '未知通道抛 ONJ_BRIDGE_PROTOCOL');
    bytes.setChannel('base64');

    h.section('UTF-8');
    var strings = [
        '', 'a', 'hello world', '中文', '日本語', 'emoji 😀🚀', 'mixed 中 a 🚀',
        '\u0000\u007f', '\u0080\u07ff', '\u0800\uffff', 'lone \ud800 surrogate'
    ];
    for (var k = 0; k < strings.length; k += 1) {
        var value = strings[k];
        var encoded = bytes.utf8Encode(value);
        h.equal(nodeBuffer.from(encoded).toString('hex'), nodeBuffer.from(value, 'utf8').toString('hex'),
            'utf8Encode(' + JSON.stringify(value) + ')');
        var decoded = bytes.utf8Decode(encoded);
        h.equal(decoded, nodeBuffer.from(value, 'utf8').toString('utf8'),
            'utf8Decode(' + JSON.stringify(value) + ')');
    }

    h.section('UTF-8 非法序列');
    var bad = new Uint8Array([0xFF, 0xFE, 0xC0, 0x80, 0xE0, 0x80, 0x41]);
    h.equal(bytes.utf8Decode(bad), nodeBuffer.from(bad).toString('utf8'), '非法字节串按 U+FFFD 处理');
}

module.exports = { run: run };
