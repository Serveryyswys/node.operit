'use strict';

/**
 * path 对拍。
 *
 * - posix：硬契约，与 Node 的 path.posix 全量比对，一字不差才算过。
 * - win32：真实场景硬断言 + 全量"分歧普查"。node.operit 的 win32 在冒号歧义与
 *   UNC 根这两类边缘上与 Node 有偏差，BUILTINS.json 里把 path/win32 标为 partial。
 *   普查用于防止偏差扩大（超过预算即失败）。
 */

var nodePath = require('path');
var myPath = require('../dist/path.js');
var cwd = require('../dist/lib/cwd.js');
var h = require('./harness.js');

var WIN32_DIVERGENCE_BUDGET = 0.06;

var CORPUS = [
    '', '.', '..', '/', '//', '///', 'a', 'a/b', 'a/b/', '/a', '/a/', '/a/b', '/a/b/',
    'a//b', 'a/./b', 'a/../b', '../a', 'a/..', 'a/../..', './a', '.hidden', 'a/.hidden',
    'a/b.txt', 'a/b.tar.gz', '.bashrc', '..bashrc', 'a.', 'a..', '...', 'a/...',
    '/a/b/../../c', '/..', '/../a', 'a/b/c/../../d', '/foo/bar//baz/asdf/quux/..',
    'foo/bar//baz/asdf/quux/..', 'a b/c d', '文件/路径.txt', '日本語/テスト/あ.js',
    'C:\\temp', 'C:/temp', '\\\\server\\share\\file', '\\\\?\\C:\\x',
    'a\\b', '..\\a', 'c:', 'C:', 'C:\\', '\\\\.\\x', 'a\\..\\b',
    '/sdcard/Download/Operit', '/sdcard///x/', 'x/', 'x//', '/x//'
];

/** win32 的真实场景：日常会遇到的形态，必须全部与 Node 一致。 */
var WIN32_REALISTIC = [
    'C:\\Users\\a\\file.txt', 'C:\\Users\\a\\', 'C:', 'C:\\',
    'D:\\a\\b\\c.tar.gz', 'a\\b\\c.txt', 'a/b/c.txt', '..\\..\\x',
    '\\server\\share', '\\server\\share\\', '\\server\\share\\dir\\file.js',
    '.\\rel\\file', 'file.txt', '.gitignore', 'dir\\', 'dir/', '',
    'C:\\a b\\c d.txt', '文件\\路径.txt', '\\?\\C:\\x\\y'
];

function lcg(seed) {
    var value = seed >>> 0;
    return function () {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 4294967296;
    };
}

function fuzzCorpus(count, seed) {
    var alphabet = ['a', 'b', 'Z', '/', '\\', '.', ':', ' ', '9'];
    var random = lcg(seed);
    var out = [];
    for (var i = 0; i < count; i += 1) {
        var length = Math.floor(random() * 14);
        var text = '';
        for (var j = 0; j < length; j += 1) {
            text += alphabet[Math.floor(random() * alphabet.length)];
        }
        out.push(text);
    }
    return out;
}

function call(fn, args) {
    try {
        return { ok: true, value: fn.apply(null, args) };
    } catch (error) {
        return { ok: false, value: 'THREW:' + error.constructor.name };
    }
}

function compareUnary(name, mine, theirs, inputs) {
    for (var i = 0; i < inputs.length; i += 1) {
        var input = inputs[i];
        h.deepEqual(
            call(mine, [input]).value,
            call(theirs, [input]).value,
            name + '(' + JSON.stringify(input) + ')'
        );
    }
}

function compareBinary(name, mine, theirs, left, right) {
    h.deepEqual(
        call(mine, [left, right]).value,
        call(theirs, [left, right]).value,
        name + '(' + JSON.stringify(left) + ', ' + JSON.stringify(right) + ')'
    );
}

function census(name, mine, theirs, pairs) {
    var diverged = 0;
    for (var i = 0; i < pairs.length; i += 1) {
        var mineResult = call(mine, pairs[i]);
        var theirsResult = call(theirs, pairs[i]);
        if (JSON.stringify(mineResult.value) !== JSON.stringify(theirsResult.value)) {
            diverged += 1;
        }
    }
    return { name: name, total: pairs.length, diverged: diverged };
}

function run() {
    var fuzz = fuzzCorpus(4000, 20261004);
    var inputs = CORPUS.concat(fuzz);

    // ---------------------------------------------------------- posix 硬契约
    h.section('path.posix 一字不差（硬契约）');
    var P = nodePath.posix;
    var M = myPath.posix;
    compareUnary('posix.normalize', M.normalize, P.normalize, inputs);
    compareUnary('posix.dirname', M.dirname, P.dirname, inputs);
    compareUnary('posix.basename', M.basename, P.basename, inputs);
    compareUnary('posix.extname', M.extname, P.extname, inputs);
    compareUnary('posix.parse', M.parse, P.parse, inputs);
    compareUnary('posix.isAbsolute', M.isAbsolute, P.isAbsolute, inputs);
    compareUnary('posix.toNamespacedPath', M.toNamespacedPath, P.toNamespacedPath, inputs);

    var random = lcg(7);
    for (var i = 0; i < inputs.length; i += 1) {
        var left = inputs[i];
        var right = inputs[Math.floor(random() * inputs.length)];
        if (M.isAbsolute(right) || M.isAbsolute(left)) {
            compareBinary('posix.resolve', M.resolve, P.resolve, left, right);
        }
        if (M.isAbsolute(left) && M.isAbsolute(right)) {
            compareBinary('posix.relative', M.relative, P.relative, left, right);
        }
        compareBinary('posix.join', M.join, P.join, left, right);
    }

    // ---------------------------------------------------------- win32 真实场景
    h.section('path.win32 真实场景（硬断言）');
    cwd.set(process.cwd());
    var WP = nodePath.win32;
    var WM = myPath.win32;
    compareUnary('win32.normalize', WM.normalize, WP.normalize, WIN32_REALISTIC);
    compareUnary('win32.basename', WM.basename, WP.basename, WIN32_REALISTIC);
    compareUnary('win32.extname', WM.extname, WP.extname, WIN32_REALISTIC);
    compareUnary('win32.parse', WM.parse, WP.parse, WIN32_REALISTIC);
    compareUnary('win32.isAbsolute', WM.isAbsolute, WP.isAbsolute, WIN32_REALISTIC);
    compareUnary('win32.dirname', WM.dirname, WP.dirname, WIN32_REALISTIC);
    for (var k = 0; k < WIN32_REALISTIC.length; k += 1) {
        var a = WIN32_REALISTIC[k];
        var b = 'x';
        compareBinary('win32.join', WM.join, WP.join, a, b);
        compareBinary('win32.resolve', WM.resolve, WP.resolve, process.cwd(), a);
    }

    // ---------------------------------------------------------- win32 分歧普查
    h.section('path.win32 分歧普查（防扩大，非零容忍）');
    var unaryPairs = inputs.map(function (item) { return [item]; });
    var binaryPairs = [];
    var fuzzRandom = lcg(11);
    for (var n = 0; n < inputs.length; n += 1) {
        binaryPairs.push([inputs[n], inputs[Math.floor(fuzzRandom() * inputs.length)]]);
    }

    var reports = [
        census('win32.normalize', WM.normalize, WP.normalize, unaryPairs),
        census('win32.dirname', WM.dirname, WP.dirname, unaryPairs),
        census('win32.basename', WM.basename, WP.basename, unaryPairs),
        census('win32.extname', WM.extname, WP.extname, unaryPairs),
        census('win32.parse', WM.parse, WP.parse, unaryPairs),
        census('win32.isAbsolute', WM.isAbsolute, WP.isAbsolute, unaryPairs),
        census('win32.join', WM.join, WP.join, binaryPairs),
        census('win32.resolve', WM.resolve, WP.resolve, binaryPairs)
    ];

    var totalCases = 0;
    var totalDiverged = 0;
    process.stdout.write('  函数                    用例     分歧     比率\n');
    reports.forEach(function (item) {
        totalCases += item.total;
        totalDiverged += item.diverged;
        var ratio = item.total === 0 ? 0 : item.diverged / item.total;
        process.stdout.write('  ' + item.name.padEnd(22) + String(item.total).padStart(6) +
            String(item.diverged).padStart(9) + '   ' + (ratio * 100).toFixed(2) + '%\n');
    });
    var overall = totalCases === 0 ? 0 : totalDiverged / totalCases;
    process.stdout.write('  ' + '合计'.padEnd(22) + String(totalCases).padStart(6) +
        String(totalDiverged).padStart(9) + '   ' + (overall * 100).toFixed(2) + '%\n');
    h.ok(overall < WIN32_DIVERGENCE_BUDGET,
        'win32 分歧率 ' + (overall * 100).toFixed(2) + '% < 预算 ' + (WIN32_DIVERGENCE_BUDGET * 100) + '%');

    // ---------------------------------------------------------- 结构与行为
    h.section('结构与默认导出');
    h.equal(myPath.sep, '/', 'path.sep 为 posix');
    h.equal(myPath.delimiter, ':', 'path.delimiter 为 posix');
    h.equal(myPath.win32.sep, '\\', 'path.win32.sep');
    h.equal(myPath.win32.delimiter, ';', 'path.win32.delimiter');
    h.equal(myPath.posix.posix === myPath.posix, true, 'path.posix.posix 自指');
    h.equal(myPath.posix.win32 === myPath.win32, true, 'path.posix.win32 指向 win32');
    h.equal(myPath.win32.posix === myPath.posix, true, 'path.win32.posix 指向 posix');
    h.equal(myPath.win32.win32 === myPath.win32, true, 'path.win32.win32 自指');

    h.section('cwd 注入（Operit 上 cwd 由 fs 环境决定）');
    cwd.set('/sdcard');
    h.equal(myPath.resolve('a', 'b'), '/sdcard/a/b', "cwd=/sdcard 时 resolve('a','b')");
    h.equal(myPath.resolve('..'), '/', "cwd=/sdcard 时 resolve('..')");
    cwd.set('/');

    h.section('异常行为');
    var threw = false;
    try {
        myPath.join(1);
    } catch (error) {
        threw = error instanceof TypeError;
    }
    h.equal(threw, true, 'join(1) 抛 TypeError');
    threw = false;
    try {
        myPath.basename('a', 1);
    } catch (error) {
        threw = error instanceof TypeError;
    }
    h.equal(threw, true, 'basename(a, 1) 抛 TypeError');
}

module.exports = { run: run };
