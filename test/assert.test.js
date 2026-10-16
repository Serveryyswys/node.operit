'use strict';

/**
 * assert / assert-strict / deep-equal 对拍。
 *
 * 分三块：
 *   1. deep-equal 语料：把一批"刁钻值"两两组合，与本库的 isDeepStrictEqual、
 *      Node 的 util.isDeepStrictEqual 逐一比对 —— 这是最硬的验证，谓词结果非黑即白；
 *   2. 宽松深比较：与 Node 的 assert.deepEqual 是否抛错比对；
 *   3. assert 各函数：比对抛出与否、错误字段，并单独统计消息文本的分歧。
 */

var nodeAssert = require('assert');
var nodeUtil = require('util');

var h = require('./harness.js');
var myAssert = require('../dist/assert.js');
var myStrict = require('../dist/assert/strict.js');
var deepEqualModule = require('../dist/lib/deep-equal.js');

// ------------------------------------------------------------------ 语料

function buildCorpus() {
    var circularA = { name: 'circular' };
    circularA.self = circularA;
    var circularB = { name: 'circular' };
    circularB.self = circularB;
    function fn() { return 1; }

    return [
        undefined, null, true, false, 0, -0, 1, -1, NaN, Infinity,
        '', 'a', 'ab', 1n, Symbol.for('sym'),
        new Number(1), new String('a'), new Boolean(true),
        new Date(0), new Date(1), /a/g, /a/i, /b/g,
        new Error('x'), new Error('y'), new TypeError('x'),
        [], [1], [1, 2], [1, undefined], new Array(2), [1, , 2],
        {}, { a: 1 }, { a: 1, b: 2 }, { a: '1' }, { b: 1, a: 1 },
        Object.create(null), { z: 1 },
        new Map(), new Map([[1, 2]]), new Map([[1, 3]]), new Map([['1', 2]]),
        new Set(), new Set([1, 2]), new Set([2, 1]),
        new Uint8Array([1, 2]), new Uint8Array([1, 3]), new Uint8Array([1]),
        new Int8Array([1, 2]), new Uint8ClampedArray([1, 2]),
        new ArrayBuffer(2), new ArrayBuffer(3),
        Buffer.from([1, 2]), Buffer.from([1, 3]),
        { a: 1, [Symbol.for('k')]: 1 }, { a: 1 },
        circularA, circularB,
        { a: { b: { c: 1 } } }, { a: { b: { c: 2 } } },
        fn, fn,
        Object.assign(Object.create({ inherited: 1 }), { own: 2 }),
        { own: 2 }
    ];
}

function looseThrows(assertModule, a, b) {
    try {
        assertModule.deepEqual(a, b);
        return false;
    } catch (error) {
        if (error && error.code === 'ERR_ASSERTION') {
            return true;
        }
        throw error;
    }
}

// ------------------------------------------------------------------ assert 场景

function outcome(assertModule, operation) {
    try {
        operation(assertModule);
        return { threw: false };
    } catch (error) {
        return {
            threw: true,
            name: error.name,
            code: error.code,
            operator: error.operator,
            generatedMessage: error.generatedMessage,
            message: error.message
        };
    }
}

var CASES = [
    ['strictEqual 数字', function (a) { a.strictEqual(1, 2); }],
    ['strictEqual 字符串', function (a) { a.strictEqual('a', 'b'); }],
    ['strictEqual 对象', function (a) { a.strictEqual({ a: 1 }, { a: 2 }); }],
    ['strictEqual 通过', function (a) { a.strictEqual(1, 1); }],
    ['strictEqual null', function (a) { a.strictEqual(null, 1); }],
    ['equal 数字', function (a) { a.equal(1, 2); }],
    ['equal 宽松通过', function (a) { a.equal('1', 1); }],
    ['notEqual', function (a) { a.notEqual(1, 1); }],
    ['notStrictEqual', function (a) { a.notStrictEqual(1, 1); }],
    ['deepStrictEqual 对象', function (a) { a.deepStrictEqual({ a: 1 }, { a: 2 }); }],
    ['deepStrictEqual 数组', function (a) { a.deepStrictEqual([1], [2]); }],
    ['deepStrictEqual Map', function (a) { a.deepStrictEqual(new Map([[1, 2]]), new Map([[1, 3]])); }],
    ['notDeepStrictEqual', function (a) { a.notDeepStrictEqual({ a: 1 }, { a: 1 }); }],
    ['deepEqual 对象', function (a) { a.deepEqual({ a: 1 }, { a: 2 }); }],
    ['deepEqual 宽松通过', function (a) { a.deepEqual({ a: 1 }, { a: '1' }); }],
    ['notDeepEqual', function (a) { a.notDeepEqual({ a: 1 }, { a: 1 }); }],
    ['ok false', function (a) { a.ok(false); }],
    ['ok 0', function (a) { a.ok(0); }],
    ['ok false 带消息', function (a) { a.ok(false, '自定义'); }],
    ['fail 字符串', function (a) { a.fail('boom'); }],
    ['fail 无参', function (a) { a.fail(); }],
    ['fail Error', function (a) { a.fail(new Error('e')); }],
    ['ifError Error', function (a) { a.ifError(new Error('x')); }],
    ['ifError null 通过', function (a) { a.ifError(null); }],
    ['ifError 字符串', function (a) { a.ifError('str'); }],
    ['match 不匹配', function (a) { a.match('abc', /z/); }],
    ['match 通过', function (a) { a.match('abc', /b/); }],
    ['doesNotMatch 匹配', function (a) { a.doesNotMatch('abc', /b/); }],
    ['throws 未抛', function (a) { a.throws(function () {}); }],
    ['throws 类型不符', function (a) { a.throws(function () { throw new TypeError('t'); }, RangeError); }],
    ['throws 正则不符', function (a) { a.throws(function () { throw new Error('t'); }, /x/); }],
    ['throws 正则通过', function (a) { a.throws(function () { throw new Error('t'); }, /t/); }],
    ['throws 任意', function (a) { a.throws(function () { throw new Error('t'); }); }],
    ['throws 对象匹配', function (a) { a.throws(function () { throw new Error('t'); }, { message: 't' }); }],
    ['doesNotThrow 通过', function (a) { a.doesNotThrow(function () {}); }],
    ['doesNotThrow 抛了', function (a) { a.doesNotThrow(function () { throw new Error('x'); }); }],
    ['strict.equal 用严格', function (a) { a.equal(1, '1'); }],
    ['strict.deepEqual 用严格', function (a) { a.deepEqual({ a: 1 }, { a: '1' }); }]
];

async function rejectCase(assertModule, name) {
    try {
        if (name === 'rejects 未拒绝') {
            await assertModule.rejects(async function () { return 1; });
        } else if (name === 'rejects 类型不符') {
            await assertModule.rejects(async function () { throw new TypeError('t'); }, RangeError);
        } else if (name === 'rejects 通过') {
            await assertModule.rejects(async function () { throw new Error('t'); }, /t/);
        } else if (name === 'doesNotReject 拒绝了') {
            await assertModule.doesNotReject(async function () { throw new Error('x'); });
        } else if (name === 'doesNotReject 通过') {
            await assertModule.doesNotReject(async function () { return 1; });
        }
        return { threw: false };
    } catch (error) {
        return { threw: true, name: error.name, code: error.code, operator: error.operator, generatedMessage: error.generatedMessage, message: error.message };
    }
}

async function run() {
    h.section('deep-equal 语料对拍（本库 vs Node util.isDeepStrictEqual）');
    var corpus = buildCorpus();
    var strictMismatch = 0;
    var looseMismatch = 0;
    var strictExamples = [];
    var looseExamples = [];
    for (var i = 0; i < corpus.length; i += 1) {
        for (var j = 0; j < corpus.length; j += 1) {
            var mineStrict = deepEqualModule.isDeepStrictEqual(corpus[i], corpus[j]);
            var nodeStrict = nodeUtil.isDeepStrictEqual(corpus[i], corpus[j]);
            if (mineStrict !== nodeStrict) {
                strictMismatch += 1;
                if (strictExamples.length < 5) {
                    strictExamples.push('#' + i + ' vs #' + j + ' 本库=' + mineStrict + ' Node=' + nodeStrict);
                }
            }
            var mineLoose = deepEqualModule.isDeepEqual(corpus[i], corpus[j]);
            var nodeLoose = !looseThrows(nodeAssert, corpus[i], corpus[j]);
            if (mineLoose !== nodeLoose) {
                looseMismatch += 1;
                if (looseExamples.length < 5) {
                    looseExamples.push('#' + i + ' vs #' + j + ' 本库=' + mineLoose + ' Node=' + nodeLoose);
                }
            }
        }
    }
    h.equal(strictMismatch, 0, '严格深比较全部一致（共 ' + (corpus.length * corpus.length) + ' 对）'
        + (strictExamples.length > 0 ? ' | 例: ' + strictExamples.join(' ; ') : ''));
    h.equal(looseMismatch, 0, '宽松深比较全部一致'
        + (looseExamples.length > 0 ? ' | 例: ' + looseExamples.join(' ; ') : ''));

    h.section('assert 各函数的字段对拍');
    var messageMismatch = [];
    for (var k = 0; k < CASES.length; k += 1) {
        var name = CASES[k][0];
        var operation = CASES[k][1];
        var mine = outcome(myAssert, operation);
        var theirs = outcome(nodeAssert, operation);
        var mineFields = JSON.stringify([mine.threw, mine.name, mine.code, mine.operator, mine.generatedMessage]);
        var theirFields = JSON.stringify([theirs.threw, theirs.name, theirs.code, theirs.operator, theirs.generatedMessage]);
        h.equal(mineFields, theirFields, name + ' 的字段');
        if (mine.threw && theirs.threw && mine.message !== theirs.message) {
            messageMismatch.push(name + '\n      本库: ' + JSON.stringify(mine.message) + '\n      Node: ' + JSON.stringify(theirs.message));
        }
    }

    h.section('assert 异步形式');
    var rejectNames = ['rejects 未拒绝', 'rejects 类型不符', 'rejects 通过', 'doesNotReject 拒绝了', 'doesNotReject 通过'];
    for (var m = 0; m < rejectNames.length; m += 1) {
        var mineAsync = await rejectCase(myAssert, rejectNames[m]);
        var theirAsync = await rejectCase(nodeAssert, rejectNames[m]);
        h.equal(
            JSON.stringify([mineAsync.threw, mineAsync.code, mineAsync.operator]),
            JSON.stringify([theirAsync.threw, theirAsync.code, theirAsync.operator]),
            rejectNames[m] + ' 的字段'
        );
    }

    h.section('assert/strict 与结构');
    h.equal(typeof myStrict, 'function', 'assert/strict 本身可调用');
    h.equal(myStrict.equal, myStrict.strictEqual, 'strict.equal 就是 strictEqual');
    h.equal(myStrict.deepEqual, myStrict.deepStrictEqual, 'strict.deepEqual 就是 deepStrictEqual');
    h.equal(myAssert.strict, myStrict, 'assert.strict 与子路径是同一对象');
    h.equal(typeof myAssert.AssertionError, 'function', 'AssertionError');
    h.equal(new myAssert.AssertionError({ message: 'x' }).code, 'ERR_ASSERTION', 'AssertionError 带 code');
    h.equal(typeof myAssert.rejects, 'function', 'rejects');
    h.equal(typeof myAssert.doesNotReject, 'function', 'doesNotReject');
    h.equal(typeof myAssert.match, 'function', 'match');
    h.equal(typeof myAssert.doesNotMatch, 'function', 'doesNotMatch');
    h.equal(typeof myAssert.ifError, 'function', 'ifError');
    h.equal(typeof myAssert.fail, 'function', 'fail');
    h.equal(typeof myAssert.throws, 'function', 'throws');
    h.equal(typeof myAssert.doesNotThrow, 'function', 'doesNotThrow');
    h.equal(typeof myAssert.deepStrictEqual, 'function', 'deepStrictEqual');

    h.section('消息文本分歧清单（仅供参考，不计入失败）');
    if (messageMismatch.length === 0) {
        console.log('  （无分歧）');
    } else {
        for (var n = 0; n < messageMismatch.length; n += 1) {
            console.log('  - ' + messageMismatch[n]);
        }
    }
    console.log('  消息分歧数: ' + messageMismatch.length + ' / ' + CASES.length);
}

module.exports = { run: run };
