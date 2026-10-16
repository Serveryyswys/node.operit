'use strict';

/**
 * events / querystring / string_decoder / util 对拍：本库实现 vs Node 自带实现。
 */

var h = require('./harness.js');
var nodeEvents = require('events');
var nodeQs = require('querystring');
var nodeStringDecoder = require('string_decoder').StringDecoder;
var nodeUtil = require('util');

var myEvents = require('../dist/events.js');
var myQs = require('../dist/querystring.js');
var myStringDecoder = require('../dist/string_decoder.js').StringDecoder;
var myUtil = require('../dist/util.js');

function sortedStringify(value) {
    function walk(input) {
        if (Array.isArray(input)) {
            return input.map(walk);
        }
        if (input !== null && typeof input === 'object' && !(input instanceof Uint8Array)) {
            var out = {};
            Object.keys(input).sort().forEach(function (key) {
                out[key] = walk(input[key]);
            });
            return out;
        }
        if (input instanceof Uint8Array) {
            return 'bytes:' + Buffer.from(input).toString('hex');
        }
        return input;
    }
    return JSON.stringify(walk(value));
}

// ------------------------------------------------------------------ events

function exerciseEvents(EventEmitter) {
    var log = [];
    var emitter = new EventEmitter();
    function a() { log.push('a'); }
    function b() { log.push('b'); }

    log.push('chain=' + (emitter.on('x', a) === emitter));
    emitter.on('x', b);
    log.push('count=' + emitter.listenerCount('x'));
    log.push('emit=' + emitter.emit('x'));
    log.push('names=' + emitter.eventNames().join(','));
    log.push('emit-missing=' + emitter.emit('nope'));

    emitter.once('y', function () { log.push('once'); });
    log.push('once-listeners=' + emitter.listeners('y').length);
    log.push('once-raw-has-listener=' + (typeof emitter.rawListeners('y')[0].listener === 'function'));
    emitter.emit('y');
    emitter.emit('y');
    log.push('count-after-once=' + emitter.listenerCount('y'));
    log.push('names-after-once=' + emitter.eventNames().join(','));

    emitter.prependListener('x', function () { log.push('p'); });
    emitter.emit('x');
    emitter.removeListener('x', a);
    log.push('after-remove=' + emitter.listenerCount('x'));
    emitter.off('x', b);
    log.push('after-off=' + emitter.listenerCount('x'));

    var late = function () { log.push('late'); };
    emitter.on('z', function () { emitter.on('z', late); });
    emitter.emit('z');
    log.push('late-called=' + (log.indexOf('late') >= 0));
    emitter.emit('z');
    log.push('late-called-twice=' + (log.lastIndexOf('late') !== log.indexOf('late')));

    try {
        emitter.emit('error', new Error('boom'));
    } catch (error) {
        log.push('error-threw=' + error.message);
    }
    var handled = false;
    emitter.on('error', function () { handled = true; });
    log.push('error-handled=' + emitter.emit('error', new Error('ignored')) + ':' + handled);

    log.push('max-default=' + emitter.getMaxListeners());
    emitter.setMaxListeners(3);
    log.push('max-set=' + emitter.getMaxListeners());
    log.push('default-static=' + EventEmitter.defaultMaxListeners);
    log.push('static-count=' + EventEmitter.listenerCount(emitter, 'x'));
    log.push('static-get=' + EventEmitter.getEventListeners(emitter, 'x').length);
    emitter.removeAllListeners();
    log.push('cleared=' + emitter.eventNames().length);

    emitter.once('q', function (value) { log.push('promise:' + value); });
    var promiseWorked = false;
    EventEmitter.once(emitter, 'q').then(function () { promiseWorked = true; });
    emitter.emit('q', 7);
    return { text: log.join(' | '), promisePending: promiseWorked };
}

// ------------------------------------------------------------------ querystring

var QS_STRINGS = [
    '', 'a=1', 'a=1&b=2', 'a=1&a=2', 'a', 'a=', '=b', 'a=b=c',
    'a%20b=c%20d', 'a+b=c+d', 'a=%E4%B8%AD%E6%96%87', 'x=%FF', 'y=%2', 'z=%zz',
    '%%=%25', 'a=1&', '&a=1', 'k[]=1&k[]=2', 'a=%3D%26', 'empty=&=',
    'a=1;b=2'
];

var QS_OBJECTS = [
    {},
    { a: 1 },
    { a: 'x', b: 'y' },
    { a: [1, 2] },
    { a: undefined },
    { a: null },
    { a: true },
    { a: 1.5 },
    { 'a b': 'c d' },
    { a: "!*'()" },
    { a: '中文' }
];

function runQuerystring() {
    var i;
    for (i = 0; i < QS_STRINGS.length; i += 1) {
        var input = QS_STRINGS[i];
        h.equal(sortedStringify(myQs.parse(input)), sortedStringify(nodeQs.parse(input)), 'qs.parse(' + JSON.stringify(input) + ')');
        h.equal(myQs.unescape(input), nodeQs.unescape(input), 'qs.unescape(' + JSON.stringify(input) + ')');
        h.equal(sortedStringify(myQs.parse(input, '&', '=', { maxKeys: 1 })), sortedStringify(nodeQs.parse(input, '&', '=', { maxKeys: 1 })), 'qs.parse maxKeys=1 ' + JSON.stringify(input));
    }
    for (i = 0; i < QS_OBJECTS.length; i += 1) {
        var value = QS_OBJECTS[i];
        h.equal(myQs.stringify(value), nodeQs.stringify(value), 'qs.stringify(' + JSON.stringify(value) + ')');
        h.equal(sortedStringify(myQs.parse(myQs.stringify(value))), sortedStringify(nodeQs.parse(nodeQs.stringify(value))), 'qs roundtrip(' + JSON.stringify(value) + ')');
    }
    var escapes = ['abc', 'a b', "!*'()", '中文', '%', '+', '/', 'a~b', 'a-b_c.d'];
    for (i = 0; i < escapes.length; i += 1) {
        h.equal(myQs.escape(escapes[i]), nodeQs.escape(escapes[i]), 'qs.escape(' + JSON.stringify(escapes[i]) + ')');
    }
    h.equal(myQs.stringify({ a: 1 }, ';', ':'), nodeQs.stringify({ a: 1 }, ';', ':'), 'qs.stringify 自定义分隔符');
    h.equal(sortedStringify(myQs.parse('a:1;b:2', ';', ':')), sortedStringify(nodeQs.parse('a:1;b:2', ';', ':')), 'qs.parse 自定义分隔符');
}

// ------------------------------------------------------------------ string_decoder

function exerciseDecoder(Decoder) {
    var cases = [
        { encoding: 'utf8', chunks: [[0x61], [0x62], [0x63]] },
        { encoding: 'utf8', chunks: [[0xe4, 0xb8], [0xad]] },
        { encoding: 'utf8', chunks: [[0xe4], [0xb8], [0xad]] },
        { encoding: 'utf8', chunks: [[0xf0, 0x9f, 0x9a], [0x80]] },
        { encoding: 'utf8', chunks: [[0x61, 0xe4, 0xb8]] },
        { encoding: 'latin1', chunks: [[0xff, 0x00]] },
        { encoding: 'ascii', chunks: [[0x80, 0x41]] },
        { encoding: 'utf16le', chunks: [[0x61], [0x00, 0x62]] },
        { encoding: 'hex', chunks: [[0x61, 0x62], [0x63, 0x64]] },
        { encoding: 'base64', chunks: [[0x61, 0x47, 0x56], [0x73, 0x62, 0x47, 0x38, 0x3d]] }
    ];
    var out = [];
    for (var i = 0; i < cases.length; i += 1) {
        var spec = cases[i];
        var decoder = new Decoder(spec.encoding);
        var text = '';
        var marks = [];
        for (var c = 0; c < spec.chunks.length; c += 1) {
            text += decoder.write(Buffer.from(spec.chunks[c]));
            marks.push(decoder.lastNeed + '/' + decoder.lastTotal);
        }
        text += decoder.end();
        out.push(spec.encoding + ':' + JSON.stringify(text) + ':' + marks.join(','));
    }
    return out.join(' | ');
}

// ------------------------------------------------------------------ util

function runUtil() {
    var formatCases = [
        ['%s', 'x'],
        ['%s', 1],
        ['%s', undefined],
        ['%s', null],
        ['%d', 1.5],
        ['%d', 'x'],
        ['%i', '42px'],
        ['%i', 3.9],
        ['%f', '1.5px'],
        ['%j', { a: 1 }],
        ['%%'],
        ['%s %s', 'a'],
        ['%s', 'a', 'b'],
        ['a', 'b'],
        ['a', { x: 1 }],
        [1, 2],
        ['%o', { a: 1 }],
        ['%O', { a: 1 }],
        ['%c', 'x'],
        ['%s%%%d', 'a', 2],
        ['no specifiers'],
        [{ a: 1 }, 'x']
    ];
    for (var i = 0; i < formatCases.length; i += 1) {
        var args = formatCases[i];
        var mine;
        var theirs;
        try {
            mine = myUtil.format.apply(null, args);
        } catch (error) {
            mine = 'THREW:' + error.constructor.name;
        }
        try {
            theirs = nodeUtil.format.apply(null, args);
        } catch (error) {
            theirs = 'THREW:' + error.constructor.name;
        }
        h.equal(mine, theirs, 'util.format(' + JSON.stringify(args) + ')');
    }

    var inspectCases = [
        'x', 1, true, null, undefined, NaN, Infinity,
        [], [1, 2, 3], {}, { a: 1 }, { a: { b: 2 } },
        new Date(0), /ab/g, [[1], [2]]
    ];
    for (var j = 0; j < inspectCases.length; j += 1) {
        h.equal(myUtil.inspect(inspectCases[j]), nodeUtil.inspect(inspectCases[j]), 'util.inspect#' + j);
    }

    h.equal(myUtil.isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }), true, 'isDeepStrictEqual 相等');
    h.equal(myUtil.isDeepStrictEqual({ a: 1 }, { a: 2 }), false, 'isDeepStrictEqual 不等');
    h.equal(myUtil.inspect.custom, nodeUtil.inspect.custom, 'inspect.custom 是同一个 symbol');
    h.equal(myUtil.promisify.custom, nodeUtil.promisify.custom, 'promisify.custom 是同一个 symbol');
    h.equal(myUtil.types.isDate(new Date()), true, 'types.isDate');
    h.equal(myUtil.types.isRegExp(/x/), true, 'types.isRegExp');
    h.equal(myUtil.types.isNativeError(new Error('x')), true, 'types.isNativeError');

    var encoder = new myUtil.TextEncoder();
    var nodeEncoder = new nodeUtil.TextEncoder();
    h.equal(Buffer.from(encoder.encode('中文🚀')).toString('hex'), Buffer.from(nodeEncoder.encode('中文🚀')).toString('hex'), 'TextEncoder.encode');
    var decoder = new myUtil.TextDecoder();
    h.equal(decoder.decode(Buffer.from('中文🚀', 'utf8')), '中文🚀', 'TextDecoder.decode');

    function legacy(a, cb) { cb(null, a * 2); }
    function failing(cb) { cb(new Error('nope')); }
    var promisified = myUtil.promisify(legacy);
    var nodePromisified = nodeUtil.promisify(legacy);
    h.equal(typeof promisified, 'function', 'promisify 返回函数');
    h.equal(promisified(21) instanceof Promise, true, 'promisify 返回 Promise');
    void nodePromisified;
    void failing;
}

function run() {
    h.section('events 对拍');
    var mineEvents = exerciseEvents(myEvents);
    var theirsEvents = exerciseEvents(nodeEvents);
    h.equal(mineEvents.text, theirsEvents.text, 'events 行为序列');

    h.section('querystring 对拍');
    runQuerystring();

    h.section('string_decoder 对拍');
    h.equal(exerciseDecoder(myStringDecoder), exerciseDecoder(nodeStringDecoder), 'string_decoder 行为序列');

    h.section('util 对拍');
    runUtil();
}

module.exports = { run: run };
