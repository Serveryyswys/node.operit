'use strict';

/**
 * WHATWG URL 语料对拍：逐属性与 Node 的 URL 比对。
 *
 * 比对字段：抛错与否、href / origin / protocol / username / password / host /
 * hostname / port / pathname / search / hash / searchParams。
 * 另有相对引用、setter、canParse / parse、searchParams 活视图、file URL 与 urlToHttpOptions。
 */

var nodeUrl = require('url');
var h = require('./harness.js');
var myUrl = require('../dist/url.js');

var URLS = [
    'http://example.com',
    'http://example.com/',
    'HTTP://EXAMPLE.COM/Path',
    'http://user:pass@example.com:8080/p/a?q=1#f',
    'http://example.com:80/',
    'https://example.com:443/',
    'http://example.com:/',
    'http://example.com/a b',
    'http://example.com/a%20b',
    'http://example.com/a/./b/../c',
    'http://example.com//a//b',
    'http://example.com/?a=1&b=2',
    'http://example.com/?a=1&a=2',
    'http://example.com/#frag',
    'http://example.com/?q=a b',
    'http://example.com/?q=a+b',
    'http://example.com/中文',
    'http://例え.jp/',
    'http://[::1]:8080/x',
    'http://[2001:db8::1]/',
    'http://[2001:db8:0:0:0:0:0:1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://192.168.1.1/',
    'http://127.1/',
    'http://example.com./',
    'file:///sdcard/a.txt',
    'file://localhost/sdcard/a.txt',
    'file:///sdcard/a b.txt',
    'ftp://ftp.example.com/x',
    'ws://example.com/socket',
    'wss://example.com:443/socket',
    'mailto:someone@example.com',
    'data:text/plain,hello',
    'about:blank',
    'custom://host/path',
    'custom:opaque/path',
    'javascript:alert(1)',
    'http://example.com/?',
    'http://example.com/#',
    'http://example.com/?a=1#b=2',
    'http://example.com/a%2Fb',
    'http://example.com/<>"{}',
    'http://example.com/?`',
    'http://EXAMPLE.com:8080/',
    'not a url',
    '/just/a/path',
    '',
    'http://',
    'http:///path',
    'https://user@example.com/',
    'http://user:@example.com/',
    'http://@example.com/',
    'http://example.com/a?b#c?d'
];

var FIELDS = ['href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];

function snapshot(ctor, input, base) {
    try {
        var instance = base === undefined ? new ctor(input) : new ctor(input, base);
        var out = {};
        FIELDS.forEach(function (field) { out[field] = instance[field]; });
        out.searchParams = instance.searchParams.toString();
        return out;
    } catch (error) {
        return { threw: true };
    }
}

function diff(mine, theirs) {
    if (mine.threw === true || theirs.threw === true) {
        return mine.threw === theirs.threw ? null : '抛错与否不同（本库 ' + (mine.threw === true) + ' Node ' + (theirs.threw === true) + '）';
    }
    var keys = Object.keys(theirs);
    var problems = [];
    keys.forEach(function (key) {
        if (mine[key] !== theirs[key]) {
            problems.push(key + ': 本库 ' + JSON.stringify(mine[key]) + ' Node ' + JSON.stringify(theirs[key]));
        }
    });
    return problems.length === 0 ? null : problems.join('; ');
}

var RELATIVE = [
    ['../x', 'http://a/b/c/d'],
    ['/x', 'http://a/b/c/d'],
    ['x', 'http://a/b/c/d'],
    ['?q', 'http://a/b/c/d'],
    ['#f', 'http://a/b/c/d'],
    ['//other/h', 'http://a/b/c/d'],
    ['http://z/', 'http://a/b/c/d'],
    ['', 'http://a/b/c/d'],
    ['./', 'http://a/b/c/d'],
    ['../../../../g', 'http://a/b/c/d'],
    ['x', 'file:///sdcard/dir/'],
    ['x/y/../z', 'https://h:8443/a/b/']
];

var SETTERS = [
    ['protocol', 'https:'],
    ['host', 'other.example:9090'],
    ['hostname', 'other.example'],
    ['port', '1234'],
    ['pathname', '/new/path'],
    ['search', '?x=1&y=2'],
    ['hash', '#newfrag'],
    ['username', 'alice'],
    ['password', 'secret']
];

function run() {
    h.section('WHATWG URL 语料（绝对）');
    var failures = [];
    URLS.forEach(function (input) {
        var problem = diff(snapshot(myUrl.URL, input), snapshot(nodeUrl.URL, input));
        if (problem !== null) {
            failures.push(JSON.stringify(input) + '\n      ' + problem);
        }
    });
    h.equal(failures.length, 0, '绝对 URL 零分歧（共 ' + URLS.length + ' 条）'
        + (failures.length > 0 ? '\n    ' + failures.join('\n    ') : ''));

    h.section('WHATWG URL 相对引用');
    var relativeFailures = [];
    RELATIVE.forEach(function (pair) {
        var problem = diff(snapshot(myUrl.URL, pair[0], pair[1]), snapshot(nodeUrl.URL, pair[0], pair[1]));
        if (problem !== null) {
            relativeFailures.push(JSON.stringify(pair) + '\n      ' + problem);
        }
    });
    h.equal(relativeFailures.length, 0, '相对引用零分歧（共 ' + RELATIVE.length + ' 条）'
        + (relativeFailures.length > 0 ? '\n    ' + relativeFailures.join('\n    ') : ''));

    h.section('setter 对拍');
    var setterFailures = [];
    SETTERS.forEach(function (pair) {
        var mine = new myUrl.URL('http://user:pass@example.com:8080/p/a?q=1#f');
        var theirs = new nodeUrl.URL('http://user:pass@example.com:8080/p/a?q=1#f');
        mine[pair[0]] = pair[1];
        theirs[pair[0]] = pair[1];
        if (mine.href !== theirs.href) {
            setterFailures.push(pair[0] + ' = ' + JSON.stringify(pair[1]) + '\n      本库 ' + JSON.stringify(mine.href) + '\n      Node ' + JSON.stringify(theirs.href));
        }
    });
    h.equal(setterFailures.length, 0, 'setter 零分歧'
        + (setterFailures.length > 0 ? '\n    ' + setterFailures.join('\n    ') : ''));

    h.section('searchParams 活视图');
    var mineLive = new myUrl.URL('http://example.com/?a=1');
    var theirsLive = new nodeUrl.URL('http://example.com/?a=1');
    mineLive.searchParams.append('b', '2');
    theirsLive.searchParams.append('b', '2');
    h.equal(mineLive.href, theirsLive.href, 'searchParams.append 反映到 href');
    mineLive.searchParams.set('a', '9');
    theirsLive.searchParams.set('a', '9');
    h.equal(mineLive.href, theirsLive.href, 'searchParams.set 反映到 href');
    mineLive.searchParams.delete('a');
    theirsLive.searchParams.delete('a');
    h.equal(mineLive.href, theirsLive.href, 'searchParams.delete 反映到 href');
    mineLive.search = '?z=1';
    theirsLive.search = '?z=1';
    h.equal(mineLive.searchParams.toString(), theirsLive.searchParams.toString(), 'search 赋值后 searchParams 同步');

    h.section('canParse / parse');
    h.equal(myUrl.URL.canParse('http://example.com/'), nodeUrl.URL.canParse('http://example.com/'), 'canParse 合法');
    h.equal(myUrl.URL.canParse('not a url'), nodeUrl.URL.canParse('not a url'), 'canParse 非法');
    h.equal(myUrl.URL.parse('http://example.com/') !== null, nodeUrl.URL.parse('http://example.com/') !== null, 'parse 合法');
    h.equal(myUrl.URL.parse('not a url'), nodeUrl.URL.parse('not a url'), 'parse 非法返回 null');

    h.section('file URL 与 urlToHttpOptions');
    // pathToFileURL 走 POSIX 规则（面向 Android）。Node 在 Windows 上会带上盘符
    // （file:///D:/sdcard/...），那是平台差异不是分歧，所以这里写死期望值。
    h.equal(myUrl.pathToFileURL('/sdcard/a b.txt').href, 'file:///sdcard/a%20b.txt', 'pathToFileURL 空格（POSIX）');
    h.equal(myUrl.pathToFileURL('/sdcard/中文.txt').href, 'file:///sdcard/%E4%B8%AD%E6%96%87.txt', 'pathToFileURL 非 ASCII（POSIX）');
    h.equal(myUrl.pathToFileURL('/sdcard/x.txt') instanceof myUrl.URL, true, 'pathToFileURL 返回 URL 实例');
    h.equal(myUrl.fileURLToPath('file:///sdcard/a%20b.txt'), '/sdcard/a b.txt', 'fileURLToPath');
    h.deepEqual(myUrl.urlToHttpOptions(new myUrl.URL('http://u:p@example.com:8080/a?b=1')),
        nodeUrl.urlToHttpOptions(new nodeUrl.URL('http://u:p@example.com:8080/a?b=1')), 'urlToHttpOptions');
}

module.exports = { run: run };
