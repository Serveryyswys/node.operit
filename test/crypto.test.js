'use strict';

/**
 * crypto 对拍：本库实现 vs Node 自带 crypto。
 *
 * 哈希是纯 JS 实现，所以可以逐字节比对；随机数走 Java，用 mock backend 提供
 * UUID 源后只验证形状与取值域。
 */

var nodeCrypto = require('crypto');
var h = require('./harness.js');
var bridge = require('../dist/lib/bridge.js');
var myCrypto = require('../dist/crypto.js');

var ALGORITHMS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];
var LENGTHS = [0, 1, 2, 3, 7, 31, 54, 55, 56, 57, 63, 64, 65, 100, 111, 112, 127, 128, 129, 200, 1000, 4097];

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

function mockBackend() {
    return {
        classExists: function () { return false; },
        callStatic: function (className, methodName) {
            if (className === 'java.util.UUID' && methodName === 'randomUUID') {
                return { __javaHandle: 'uuid', __javaClass: 'java.util.UUID' };
            }
            return null;
        },
        callInstance: function (instance, methodName) {
            if (methodName === 'toString') {
                return nodeCrypto.randomUUID();
            }
            return null;
        },
        newInstance: function (className) { return { __javaHandle: 'new', __javaClass: className }; },
        getStaticField: function () { return null; },
        setStaticField: function () { return undefined; },
        getInstanceField: function () { return null; },
        setInstanceField: function () { return undefined; },
        getApplicationContext: function () { return null; },
        getCurrentActivity: function () { return null; },
        setEnv: function () { return undefined; }
    };
}

function run() {
    bridge.setBackend(mockBackend());

    h.section('createHash：每个算法 × 每种长度');
    for (var a = 0; a < ALGORITHMS.length; a += 1) {
        var algorithm = ALGORITHMS[a];
        for (var l = 0; l < LENGTHS.length; l += 1) {
            var length = LENGTHS[l];
            var data = randomBytes(length, 20261004 + a * 100 + l);
            var mine = myCrypto.createHash(algorithm).update(data).digest('hex');
            var theirs = nodeCrypto.createHash(algorithm).update(data).digest('hex');
            h.equal(mine, theirs, algorithm + '(' + length + ' bytes)');
        }
    }

    h.section('createHash：字符串输入与编码');
    var textCases = [
        ['', 'utf8'], ['a', 'utf8'], ['hello world', 'utf8'], ['中文🚀', 'utf8'],
        ['616263', 'hex'], ['aGVsbG8=', 'base64'], ['ÿþ', 'latin1']
    ];
    for (var t = 0; t < textCases.length; t += 1) {
        var text = textCases[t][0];
        var encoding = textCases[t][1];
        h.equal(
            myCrypto.createHash('sha256').update(text, encoding).digest('hex'),
            nodeCrypto.createHash('sha256').update(text, encoding).digest('hex'),
            'sha256(' + JSON.stringify(text) + ', ' + encoding + ')'
        );
    }

    h.section('createHash：分块 update 与一次性等价');
    var payload = randomBytes(1000, 7);
    var chunked = myCrypto.createHash('sha512');
    for (var offset = 0; offset < payload.length; offset += 37) {
        chunked.update(payload.subarray(offset, Math.min(offset + 37, payload.length)));
    }
    h.equal(chunked.digest('hex'), nodeCrypto.createHash('sha512').update(payload).digest('hex'), '分块 update');

    h.section('createHash：算法别名与错误');
    h.equal(myCrypto.createHash('sha-256').update('x').digest('hex'), nodeCrypto.createHash('sha-256').update('x').digest('hex'), 'sha-256 别名');
    h.equal(myCrypto.createHash('SHA256').update('x').digest('hex'), nodeCrypto.createHash('SHA256').update('x').digest('hex'), '大写别名');
    var badDigest = null;
    try {
        myCrypto.createHash('sha3-256');
    } catch (error) {
        badDigest = error;
    }
    h.equal(badDigest !== null && badDigest.code === 'ERR_CRYPTO_INVALID_DIGEST', true, '未知算法抛 ERR_CRYPTO_INVALID_DIGEST');
    var twice = myCrypto.createHash('sha256').update('x');
    twice.digest('hex');
    var second = null;
    try {
        twice.digest('hex');
    } catch (error) {
        second = error;
    }
    h.equal(second !== null, true, 'digest 只能调用一次');
    h.equal(myCrypto.createHash('md5').update('x').digest() instanceof Uint8Array, true, '不带编码时返回 Buffer');

    h.section('createHmac：各种密钥长度');
    var keyLengths = [0, 1, 15, 16, 63, 64, 65, 127, 128, 129, 300];
    for (var k = 0; k < keyLengths.length; k += 1) {
        for (var hh = 0; hh < ALGORITHMS.length; hh += 1) {
            var key = randomBytes(keyLengths[k], 500 + k);
            var message = randomBytes(77, 900 + hh);
            h.equal(
                myCrypto.createHmac(ALGORITHMS[hh], key).update(message).digest('hex'),
                nodeCrypto.createHmac(ALGORITHMS[hh], key).update(message).digest('hex'),
                'hmac-' + ALGORITHMS[hh] + '(key=' + keyLengths[k] + ')'
            );
        }
    }

    h.section('pbkdf2Sync');
    var pbkdf2Cases = [
        ['password', 'salt', 1, 32, 'sha256'],
        ['password', 'salt', 1000, 32, 'sha256'],
        ['密码', '盐', 100, 20, 'sha1'],
        ['p', 's', 10, 64, 'sha512'],
        ['p', 's', 5, 16, 'md5'],
        ['p', 's', 3, 100, 'sha384']
    ];
    for (var p = 0; p < pbkdf2Cases.length; p += 1) {
        var spec = pbkdf2Cases[p];
        h.equal(
            myCrypto.pbkdf2Sync(spec[0], spec[1], spec[2], spec[3], spec[4]).toString('hex'),
            nodeCrypto.pbkdf2Sync(spec[0], spec[1], spec[2], spec[3], spec[4]).toString('hex'),
            'pbkdf2(' + spec[4] + ',' + spec[2] + ',' + spec[3] + ')'
        );
    }

    h.section('timingSafeEqual');
    h.equal(myCrypto.timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')), true, '相等');
    h.equal(myCrypto.timingSafeEqual(Buffer.from('abc'), Buffer.from('abd')), false, '不等');
    var lengthError = null;
    try {
        myCrypto.timingSafeEqual(Buffer.from('abc'), Buffer.from('ab'));
    } catch (error) {
        lengthError = error;
    }
    h.equal(lengthError !== null && lengthError.code === 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', true, '长度不等抛错');

    h.section('getHashes / 未实现项');
    var listed = myCrypto.getHashes().slice().sort();
    for (var g = 0; g < ALGORITHMS.length; g += 1) {
        h.equal(listed.indexOf(ALGORITHMS[g]) >= 0, true, 'getHashes 含 ' + ALGORITHMS[g]);
    }
    h.equal(myCrypto.getCiphers().length, 0, 'getCiphers 如实为空');
    var stub = null;
    try {
        myCrypto.createCipheriv('aes-256-cbc', Buffer.alloc(32), Buffer.alloc(16));
    } catch (error) {
        stub = error;
    }
    h.equal(stub !== null && stub.code === 'ONJ_UNSUPPORTED', true, 'createCipheriv 显式抛 ONJ_UNSUPPORTED');

    h.section('随机数（mock UUID 源）');
    h.equal(myCrypto.randomBytes(16).length, 16, 'randomBytes 长度');
    h.equal(myCrypto.randomBytes(37).length, 37, 'randomBytes 跨 16 字节边界');
    h.equal(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(myCrypto.randomUUID()), true, 'randomUUID 格式');
    var inRange = true;
    for (var r = 0; r < 200; r += 1) {
        var value = myCrypto.randomInt(5, 10);
        if (value < 5 || value >= 10 || Math.floor(value) !== value) {
            inRange = false;
        }
    }
    h.equal(inRange, true, 'randomInt(5,10) 落在 [5,10)');
    var single = myCrypto.randomInt(3);
    h.equal(single >= 0 && single < 3, true, 'randomInt(3) 落在 [0,3)');
    var target = Buffer.alloc(8);
    h.equal(myCrypto.randomFillSync(target) === target, true, 'randomFillSync 返回原缓冲');

    bridge.setBackend(null);
}

module.exports = { run: run };
