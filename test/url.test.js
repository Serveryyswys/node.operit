'use strict';

/**
 * url 对拍：URLSearchParams、旧版 parse/format/resolve、domainToASCII/Unicode
 * 都与 Node 的 url 比语义结果。
 *
 * pathToFileURL / fileURLToPath 单独处理：本库面向 Android，
 * 实现的是 POSIX 规则（Node 在 Linux 上的行为），而开发机是 Windows，
 * 所以那部分用写死的期望值断言，不做逐项对拍。
 */

var nodeUrl = require('url');
var h = require('./harness.js');
var myUrl = require('../dist/url.js');

var PARSE_URLS = [
    'http://user:pass@www.example.com:8080/p/a/t/h?query=string#hash',
    'http://example.com',
    'https://example.com/',
    '//example.com/path',
    '/just/a/path?x=1#h',
    'path/relative',
    '?onlyquery=1',
    '#onlyhash',
    'mailto:someone@example.com',
    'file:///sdcard/a.txt',
    'http://example.com/a b',
    'HTTP://EXAMPLE.COM/Path',
    'http://example.com/?a=1&a=2&b=',
    'http://example.com:/path',
    'ftp://x:y@host:21/p',
    'http://[::1]:8080/x',
    'a?b=c d',
    'http://example.com/p?q=1#f?notquery',
    'http://example.com/%7Euser/',
    'http://example.com/a%2Fb',
    'ws://host:9/path',
    'http://example.com/#hash with space',
    'http://example.com/?q=a+b',
    'http://example.com/?q=a%20b',
    '//foo/bar',
    '',
    '://noscheme',
    'http://',
    'a:b',
    'http://user@host/',
    'http:example.com',
    'http://host',
    'mailto:a@b/c',
    'a:/b',
    'http://host:',
    'foo://bar',
    'http://EXAMPLE.com:8080/Path?Q=1#F',
    'http://example.com/a//b///c',
    'http://example.com/../x',
    'file://host/path',
    'http://example.com/?a[]=1&a[]=2',
    'ws:host',
    'wss:host',
    'ftp:host',
    'gopher:host',
    'file:host',
    '//foo',
    'https:example.com/x'
];

var PARSE_FIELDS = ['protocol', 'slashes', 'auth', 'host', 'port', 'hostname', 'hash', 'search', 'pathname', 'path', 'href'];

function pickParse(parsed) {
    var out = {};
    for (var i = 0; i < PARSE_FIELDS.length; i += 1) {
        out[PARSE_FIELDS[i]] = parsed[PARSE_FIELDS[i]];
    }
    return out;
}

var FORMAT_OBJECTS = [
    { protocol: 'http', host: 'example.com', pathname: '/a', search: '?x=1', hash: '#h' },
    { protocol: 'http:', slashes: true, hostname: 'example.com', port: '8080', pathname: '/a', query: { b: '2', a: '1' } },
    { protocol: 'mailto', pathname: 'a@b.com' },
    { hostname: 'example.com', pathname: 'a b' },
    { protocol: 'https', hostname: 'h', port: '443', pathname: '/p', search: 'q=1', hash: 'frag' },
    { protocol: 'file', slashes: true, hostname: '', pathname: '/sdcard/x.txt' },
    { host: 'h:1', pathname: '/p' },
    { protocol: 'http', auth: 'u:p', hostname: 'h', pathname: '/p' },
    { pathname: '/only/path' },
    { protocol: 'http', hostname: '::1', port: '80', pathname: '/p' }
];

var RESOLVE_PAIRS = [
    ['http://a/b/c/d', '../e'],
    ['http://a/b/c/d', '/x'],
    ['http://a/b/c/d', 'http://z/'],
    ['http://a/b/c/d', '?q'],
    ['http://a/b/c/d', '#f'],
    ['http://a/b/c/d', 'g'],
    ['http://a/b/c/d', './g'],
    ['http://a/b/c/d', '../../../../g'],
    ['http://a/b/c/d', '//other/h'],
    ['http://a/b/c/d?old=1', 'new']
];

function paramsScenario(Mod) {
    var out = [];
    function push(value) { out.push(String(value)); }
    var p = new Mod('a=1&b=2&a=3&c=%E4%B8%AD%E6%96%87&d=x+y&e=&f');
    push(p.toString());
    push(p.size);
    push(JSON.stringify(p.getAll('a')));
    push(JSON.stringify(p.get('d')));
    push(JSON.stringify(p.get('missing')));
    push(p.has('a'));
    push(p.has('a', '3'));
    push(p.has('a', 'nope'));
    push(JSON.stringify(p.get('e')));
    push(JSON.stringify(p.get('f')));
    push(JSON.stringify(p.get('c')));
    p.append('a', '4');
    p.set('b', '9');
    p.delete('c');
    push(p.toString());
    p.sort();
    push(p.toString());
    push(JSON.stringify(Array.from(p.entries())));
    push(JSON.stringify(Array.from(p.keys())));
    push(JSON.stringify(Array.from(p.values())));
    var record = {};
    p.forEach(function (value, name) {
        record[name] = (record[name] || []).concat(value);
    });
    push(JSON.stringify(record));
    push(JSON.stringify(Array.from(p)));
    push(new Mod({ x: 1, y: 'z' }).toString());
    push(new Mod([['k', 'v'], ['k2', 'v 2']]).toString());
    push(new Mod('').toString());
    push(new Mod('?lead=1').toString());
    push(new Mod('a=1&a=1&a=1').toString());
    var p2 = new Mod('a=1&a=1&a=2');
    p2.delete('a', '1');
    push(p2.toString());
    push(new Mod('x=%E4%B8%AD&y=~!*\'()').toString());
    push(new Mod('a').toString());
    push(new Mod('=').toString());
    push(new Mod('a=1&&b=2').toString());
    push(new Mod('a=1&').toString());
    return out.join(' | ');
}

function run() {
    h.section('URLSearchParams 对拍');
    h.equal(paramsScenario(myUrl.URLSearchParams), paramsScenario(nodeUrl.URLSearchParams), 'URLSearchParams 场景');

    h.section('旧版 parse 对拍（字段）');
    var parseDivergences = [];
    for (var i = 0; i < PARSE_URLS.length; i += 1) {
        var input = PARSE_URLS[i];
        var mine = pickParse(myUrl.parse(input));
        var theirs = pickParse(nodeUrl.parse(input));
        if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
            parseDivergences.push(JSON.stringify(input) +
                '\n      本库: ' + JSON.stringify(mine) +
                '\n      Node: ' + JSON.stringify(theirs));
        }
    }
    h.equal(parseDivergences.length, 0, 'parse 字段零分歧' + (parseDivergences.length > 0 ? '\n    ' + parseDivergences.join('\n    ') : ''));

    h.section('parse(..., true) 的 query 对象');
    var queryDivergences = [];
    for (var j = 0; j < PARSE_URLS.length; j += 1) {
        var qInput = PARSE_URLS[j];
        var mineQ = myUrl.parse(qInput, true);
        var theirsQ = nodeUrl.parse(qInput, true);
        var mineShape = JSON.stringify(mineQ.query) + '|' + (mineQ.query === null ? 'null' : String(Object.getPrototypeOf(mineQ.query)));
        var theirShape = JSON.stringify(theirsQ.query) + '|' + (theirsQ.query === null ? 'null' : String(Object.getPrototypeOf(theirsQ.query)));
        if (mineShape !== theirShape) {
            queryDivergences.push(JSON.stringify(qInput) + ' 本库: ' + mineShape + ' Node: ' + theirShape);
        }
    }
    h.equal(queryDivergences.length, 0, 'query 对象零分歧' + (queryDivergences.length > 0 ? '\n    ' + queryDivergences.join('\n    ') : ''));

    h.section('slashesDenoteHost');
    h.equal(JSON.stringify(pickParse(myUrl.parse('//foo/bar', false, true))),
        JSON.stringify(pickParse(nodeUrl.parse('//foo/bar', false, true))), '//foo/bar slashesDenoteHost=true');
    h.equal(JSON.stringify(pickParse(myUrl.parse('//foo/bar', false, false))),
        JSON.stringify(pickParse(nodeUrl.parse('//foo/bar', false, false))), '//foo/bar slashesDenoteHost=false');
    h.equal(JSON.stringify(pickParse(myUrl.parse('foo/bar', false, true))),
        JSON.stringify(pickParse(nodeUrl.parse('foo/bar', false, true))), 'foo/bar slashesDenoteHost=true');

    h.section('format 对拍');
    var formatDivergences = [];
    for (var k = 0; k < FORMAT_OBJECTS.length; k += 1) {
        var source = FORMAT_OBJECTS[k];
        var mineFormatted = myUrl.format(source);
        var theirsFormatted = nodeUrl.format(source);
        if (mineFormatted !== theirsFormatted) {
            formatDivergences.push(JSON.stringify(source) + ' 本库: ' + JSON.stringify(mineFormatted) + ' Node: ' + JSON.stringify(theirsFormatted));
        }
    }
    h.equal(formatDivergences.length, 0, 'format 零分歧' + (formatDivergences.length > 0 ? '\n    ' + formatDivergences.join('\n    ') : ''));

    h.section('format(parse(x)) 往返');
    var roundDivergences = [];
    for (var m = 0; m < PARSE_URLS.length; m += 1) {
        var roundInput = PARSE_URLS[m];
        var mineRound = myUrl.format(myUrl.parse(roundInput));
        var theirsRound = nodeUrl.format(nodeUrl.parse(roundInput));
        if (mineRound !== theirsRound) {
            roundDivergences.push(JSON.stringify(roundInput) + ' 本库: ' + JSON.stringify(mineRound) + ' Node: ' + JSON.stringify(theirsRound));
        }
    }
    h.equal(roundDivergences.length, 0, '往返零分歧' + (roundDivergences.length > 0 ? '\n    ' + roundDivergences.join('\n    ') : ''));

    h.section('resolve 对拍');
    var resolveDivergences = [];
    for (var n = 0; n < RESOLVE_PAIRS.length; n += 1) {
        var from = RESOLVE_PAIRS[n][0];
        var to = RESOLVE_PAIRS[n][1];
        var mineResolved = myUrl.resolve(from, to);
        var theirsResolved = nodeUrl.resolve(from, to);
        if (mineResolved !== theirsResolved) {
            resolveDivergences.push(JSON.stringify([from, to]) + ' 本库: ' + JSON.stringify(mineResolved) + ' Node: ' + JSON.stringify(theirsResolved));
        }
    }
    h.equal(resolveDivergences.length, 0, 'resolve 零分歧' + (resolveDivergences.length > 0 ? '\n    ' + resolveDivergences.join('\n    ') : ''));

    h.section('pathToFileURL / fileURLToPath（POSIX 规则，写死期望值）');
    h.equal(myUrl.pathToFileURL('/sdcard/a b.txt').href, 'file:///sdcard/a%20b.txt', 'pathToFileURL 空格编码');
    h.equal(myUrl.pathToFileURL('/sdcard/x.txt').href, 'file:///sdcard/x.txt', 'pathToFileURL 普通路径');
    h.equal(myUrl.pathToFileURL('/sdcard/中文.txt').href, 'file:///sdcard/%E4%B8%AD%E6%96%87.txt', 'pathToFileURL 非 ASCII');
    h.equal(myUrl.fileURLToPath('file:///sdcard/a%20b.txt'), '/sdcard/a b.txt', 'fileURLToPath 解码');
    h.equal(myUrl.fileURLToPath('file:///sdcard/中文.txt'), '/sdcard/中文.txt', 'fileURLToPath 非 ASCII');
    h.equal(myUrl.fileURLToPath('file://localhost/sdcard/x'), '/sdcard/x', 'fileURLToPath 允许 localhost');
    var hostError = null;
    try { myUrl.fileURLToPath('file://otherhost/x'); } catch (error) { hostError = error; }
    h.equal(hostError !== null, true, 'fileURLToPath 拒绝非 localhost 主机');

    h.section('结构与未实现项');
    h.equal(typeof myUrl.URLSearchParams, 'function', 'URLSearchParams');
    h.equal(typeof myUrl.parse, 'function', 'parse');
    h.equal(typeof myUrl.format, 'function', 'format');
    h.equal(typeof myUrl.resolve, 'function', 'resolve');
    h.equal(typeof myUrl.pathToFileURL, 'function', 'pathToFileURL');
    h.equal(typeof myUrl.fileURLToPath, 'function', 'fileURLToPath');
    h.equal(typeof myUrl.domainToASCII, 'function', 'domainToASCII');
    h.equal(typeof myUrl.domainToUnicode, 'function', 'domainToUnicode');
    h.equal(typeof myUrl.URL, 'function', 'WHATWG URL 已实现（语料见 url-whatwg.test.js）');
    h.equal(typeof myUrl.urlToHttpOptions, 'function', 'urlToHttpOptions 已实现');
}

module.exports = { run: run };
