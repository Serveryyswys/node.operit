'use strict';

/**
 * 从 JS 源码里找出真正的 require('x') 调用点。
 *
 * 为什么不能直接上正则：注释与字符串里的 require 会被误伤。
 * 实测中 node.operit 自己的文档注释（require('<项目>/node_modules/@serveryyswys/node.operit/index.js')）
 * 就被正则当成了真依赖 —— 打包期如果照着改写，会把注释改坏并误报依赖。
 *
 * 所以这里做一个够用的词法扫描：跳过注释、字符串、模板串与正则字面量，
 * 只在"代码位置"识别 require 标识符后跟字符串字面量的形式。
 * 只认字符串字面量，require(someVar) 这类动态调用不重写（也无法在打包期重写）。
 */

var IDENT_START = /[A-Za-z_$]/;
var IDENT_PART = /[A-Za-z0-9_$]/;

/** 关键字后面出现的 '/' 是正则而不是除号。 */
var REGEX_PREFIX_KEYWORDS = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'case', 'yield', 'await', 'throw'];

function isRegexPosition(previous) {
    if (previous === '') {
        return true;
    }
    if (previous.length > 1) {
        return REGEX_PREFIX_KEYWORDS.indexOf(previous) >= 0;
    }
    return '([{,;=:!&|?+-*%~^<>'.indexOf(previous) >= 0;
}

function skipString(source, index) {
    var quote = source.charAt(index);
    var i = index + 1;
    while (i < source.length) {
        var ch = source.charAt(i);
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === quote) {
            return i + 1;
        }
        i += 1;
    }
    return source.length;
}

function skipTemplate(source, index) {
    // 简化处理：把 \${ 当成普通字符跳过，不做嵌套解析。
    // 对"模板串里恰好有 require('x')"这种极罕见写法，结果是漏报而非误报。
    var i = index + 1;
    while (i < source.length) {
        var ch = source.charAt(i);
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '`') {
            return i + 1;
        }
        i += 1;
    }
    return source.length;
}

function skipRegex(source, index) {
    var i = index + 1;
    var inClass = false;
    while (i < source.length) {
        var ch = source.charAt(i);
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '[') {
            inClass = true;
        } else if (ch === ']') {
            inClass = false;
        } else if (ch === '/' && !inClass) {
            i += 1;
            while (i < source.length && IDENT_PART.test(source.charAt(i))) {
                i += 1;
            }
            return i;
        } else if (ch === '\n') {
            return i;
        }
        i += 1;
    }
    return source.length;
}

/** 返回 [{spec, specStart, specEnd}]，specStart/specEnd 是不含引号的字面量区间。 */
function findRequires(source) {
    var found = [];
    var i = 0;
    var previous = '';
    while (i < source.length) {
        var ch = source.charAt(i);
        if (ch === '/' && source.charAt(i + 1) === '/') {
            while (i < source.length && source.charAt(i) !== '\n') { i += 1; }
            continue;
        }
        if (ch === '/' && source.charAt(i + 1) === '*') {
            i += 2;
            while (i < source.length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) { i += 1; }
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            i = skipString(source, i);
            previous = '"';
            continue;
        }
        if (ch === '`') {
            i = skipTemplate(source, i);
            previous = '`';
            continue;
        }
        if (ch === '/' && isRegexPosition(previous)) {
            i = skipRegex(source, i);
            previous = '/';
            continue;
        }
        if (IDENT_START.test(ch)) {
            var start = i;
            while (i < source.length && IDENT_PART.test(source.charAt(i))) { i += 1; }
            var word = source.slice(start, i);
            if (word === 'require') {
                var j = i;
                while (j < source.length && /\s/.test(source.charAt(j))) { j += 1; }
                if (source.charAt(j) === '(') {
                    j += 1;
                    while (j < source.length && /\s/.test(source.charAt(j))) { j += 1; }
                    var quote = source.charAt(j);
                    if (quote === '"' || quote === "'") {
                        var end = skipString(source, j);
                        found.push({
                            spec: source.slice(j + 1, end - 1),
                            specStart: j + 1,
                            specEnd: end - 1
                        });
                    }
                }
            }
            previous = word;
            continue;
        }
        if (!/\s/.test(ch)) {
            previous = ch;
        }
        i += 1;
    }
    return found;
}

/** 按区间倒序替换（这样前面的下标不会因为替换而失效）。 */
function applyReplacements(source, edits) {
    var out = source;
    for (var i = edits.length - 1; i >= 0; i -= 1) {
        var edit = edits[i];
        out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    }
    return out;
}

module.exports = { findRequires: findRequires, applyReplacements: applyReplacements };
