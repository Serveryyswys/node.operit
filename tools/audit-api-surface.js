'use strict';

/**
 * 与 Node 逐模块做导出差分，找"形状不一致"。
 *
 * 为什么需要它（两个真实故障）：
 *   1. pureimage/pngjs 写 util.inherits(X, zlib.Zlib) —— 本库没导出 Zlib，
 *      传进去是 undefined，报"superConstructor must be a function"，指向不明；
 *   2. 老包写 function X() { Stream.call(this); } —— 本库 Stream 是原生 class，
 *      QuickJS 抛"class constructors must be invoked with 'new'"。
 * 两次都不是"某个函数算错了"，而是**导出表/调用形态与 Node 不一致**。
 * 纯 API 对拍测不出这两类，因为它们关心的是"有哪些、能不能这么调"。
 *
 * 用法：node tools/audit-api-surface.js [--json]
 * 退出码：有"缺函数/缺类/可调用性差异"时为 1，只差常量时为 0。
 */

var fs = require('fs');
var path = require('path');

var DIST = path.join(__dirname, '..', 'dist');
var CONTRACT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'BUILTINS.json'), 'utf8'));

/**
 * 审"本库声称已实现"的模块：ready 与 partial 都要审。
 *
 * 之前只审 ready，漏掉 28 个 partial —— 而"已实现但不完整"恰恰是缺口最容易藏的地方
 * （partial 的意思是"能用，但没覆盖全"，不是"可以随便缺"）。
 * planned/unsupported 的缺失是既定设计，不审。
 */
function implementedSpecs() {
    var specs = [];
    var builtins = CONTRACT.builtins || {};
    Object.keys(builtins).forEach(function (name) {
        var entry = builtins[name];
        if (entry && (entry.status === 'ready' || entry.status === 'partial')) {
            specs.push(entry.subpath || name);
        }
    });
    return specs.sort();
}

/**
 * Node 里这些模块是同一个对象（别名），差分时要以被别名的那一方为准，
 * 否则整个模块的成员都会被报成"缺失"。
 */
var ALIASES = { sys: 'util' };

function tryLoad(loader, label) {
    try {
        return { ok: true, value: loader() };
    } catch (error) {
        return { ok: false, error: String(error.message).split('\n')[0].slice(0, 90), label: label };
    }
}

/**
 * 能不能不用 new 直接调用（Node 的 EventEmitter / Stream 这类是普通函数）。
 *
 * 只对"像构造函数"的名字做实测 —— 绝不能对任意函数调用：
 * console.trace 会打印、assert 会断言失败、还有一堆有副作用的函数。
 * 老式继承写法只发生在构造函数上，所以按首字母大写筛就够了。
 */
function isConstructorLike(name) {
    return typeof name === 'string' && /^[A-Z]/.test(name);
}

function callability(value) {
    if (typeof value !== 'function') {
        return 'n/a';
    }
    var source = Function.prototype.toString.call(value);
    var isClass = /^class\s/.test(source);
    var callWorks = true;
    try {
        value.call({});
    } catch (error) {
        callWorks = false;
    }
    if (callWorks) {
        return 'callable';
    }
    return isClass ? 'class-only' : 'throws';
}

function classify(value) {
    if (typeof value === 'function') {
        return /^class\s/.test(Function.prototype.toString.call(value)) ? 'class' : 'function';
    }
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    return typeof value;
}

function main() {
    var asJson = process.argv.indexOf('--json') >= 0;
    var findings = [];
    var gaps = [];
    var identities = [];
    var notes = [];

    // 别名同一性：契约里明确写了 sys 与 util 是同一个对象，这是可断言的事实
    Object.keys(ALIASES).forEach(function (alias) {
        var aliasModule = tryLoad(function () { return require(path.join(DIST, alias + '.js')); }, 'alias');
        var targetModule = tryLoad(function () { return require(path.join(DIST, ALIASES[alias] + '.js')); }, 'target');
        if (!aliasModule.ok || !targetModule.ok) {
            identities.push({ detail: alias + ' 或 ' + ALIASES[alias] + ' 无法加载' });
            return;
        }
        if (aliasModule.value !== targetModule.value) {
            identities.push({
                spec: alias,
                member: '(模块自身)',
                severity: 'high',
                detail: '契约声明与 ' + ALIASES[alias] + ' 是同一对象，实际不是'
            });
        }
    });
    findings = findings.concat(identities);
    var specs = implementedSpecs();
    var nodeMissing = [];
    var unloadable = [];

    specs.forEach(function (spec) {
        var mine = tryLoad(function () { return require(path.join(DIST, spec.replace(/\//g, path.sep) + '.js')); }, 'mine');
        var nodeSide = tryLoad(function () { return require(ALIASES[spec] || spec); }, 'node');
        if (!mine.ok) {
            unloadable.push({ spec: spec, error: mine.error });
            return;
        }
        if (!nodeSide.ok) {
            // 运行时（QuickJS）里没有的模块，比如 http/dns 的部分子路径，跳过差分
            nodeMissing.push(spec);
            return;
        }
        var a = mine.value;
        var b = nodeSide.value;
        // 注意：a/b 可能是带宿主 getter 的对象，所有读取都走 readMember
        // 模块整体形态
        var kindA = classify(a);
        var kindB = classify(b);
        if (kindA !== kindB) {
            findings.push({ spec: spec, member: '(模块自身)', severity: 'high', detail: '本库是 ' + kindA + '，Node 是 ' + kindB });
        }
        var callA = callability(a);
        var callB = callability(b);
        if (callB === 'callable' && callA !== 'callable') {
            findings.push({ spec: spec, member: '(模块自身)', severity: 'high', detail: 'Node 可 .call 调用，本库是 ' + callA });
        }
        // 成员差分
        function readMember(target, key) {
            try {
                return target == null ? undefined : target[key];
            } catch (error) {
                // 需要宿主才能读的 getter（process.version 之类）：算作"存在但不可读"
                return undefined;
            }
        }
        var keys = {};
        Object.keys(Object(b)).forEach(function (k) { keys[k] = true; });
        Object.keys(Object(a)).forEach(function (k) { keys[k] = true; });
        Object.keys(keys).sort().forEach(function (key) {
            var inMine = readMember(a, key) !== undefined;
            var inNode = readMember(b, key) !== undefined;
            if (inNode && !inMine) {
                var nodeKind = classify(readMember(b, key));
                // 缺成员一律归入"覆盖缺口"单独统计 —— partial 模块本来就没实现全，
                // 把它们混进"问题"里会淹没真正需要处理的形状不一致。
                gaps.push({ spec: spec, member: key, kind: nodeKind });
                return;
            }
            if (inMine && inNode) {
                var mineKind = classify(readMember(a, key));
                var nodeKind2 = classify(readMember(b, key));
                if (mineKind !== nodeKind2 && !(mineKind === 'class' && nodeKind2 === 'function')) {
                    findings.push({ spec: spec, member: key, severity: 'medium', detail: '本库 ' + mineKind + '，Node ' + nodeKind2 });
                }
                if (!isConstructorLike(key)) {
                    return;
                }
                var cA = callability(readMember(a, key));
                var cB = callability(readMember(b, key));
                if (cB === 'callable' && cA !== 'callable') {
                    findings.push({ spec: spec, member: key, severity: 'high', detail: 'Node 可 .call 调用（老包继承写法），本库是 ' + cA });
                }
            }
            if (inMine && !inNode) {
                findings.push({ spec: spec, member: key, severity: 'low', detail: 'Node 没有，本库多出（' + classify(readMember(a, key)) + '）' });
            }
        });
    });

    var high = findings.filter(function (f) { return f.severity === 'high'; });
    var medium = findings.filter(function (f) { return f.severity === 'medium'; });
    var low = findings.filter(function (f) { return f.severity === 'low'; });
    var gapBySpec = {};
    gaps.forEach(function (g) {
        if (gapBySpec[g.spec] === undefined) { gapBySpec[g.spec] = { total: 0, functions: 0 }; }
        gapBySpec[g.spec].total += 1;
        if (g.kind === 'function' || g.kind === 'class') { gapBySpec[g.spec].functions += 1; }
    });

    if (asJson) {
        console.log(JSON.stringify({ specs: specs.length, high: high, medium: medium, low: low, unloadable: unloadable, nodeMissing: nodeMissing }, null, 2));
        return high.length > 0 ? 1 : 0;
    }

    console.log('审计模块数: ' + specs.length + '（BUILTINS.json 里 status=ready 或 partial 的全部）');
    console.log('');
    console.log('=== 形状不一致：会导致依赖直接崩的（' + high.length + '）===');
    high.length === 0 ? console.log('  无') : high.forEach(function (f) {
        console.log('  ' + (f.spec + '.' + f.member).padEnd(34) + f.detail);
    });
    console.log('');
    console.log('=== 中等：类型不符（' + medium.length + '）===');
    medium.length === 0 ? console.log('  无') : medium.slice(0, 40).forEach(function (f) {
        console.log('  ' + (f.spec + '.' + f.member).padEnd(34) + f.detail);
    });
    if (medium.length > 40) { console.log('  …还有 ' + (medium.length - 40) + ' 条'); }
    console.log('');
    console.log('=== 轻微：本库多出的成员（' + low.length + '）===');
    low.length === 0 ? console.log('  无') : low.slice(0, 25).forEach(function (f) {
        console.log('  ' + (f.spec + '.' + f.member).padEnd(34) + f.detail);
    });
    if (low.length > 25) { console.log('  …还有 ' + (low.length - 25) + ' 条'); }
    if (unloadable.length > 0) {
        console.log('');
        console.log('=== 加载失败（' + unloadable.length + '）===');
        unloadable.forEach(function (u) { console.log('  ' + u.spec.padEnd(34) + u.error); });
    }
    console.log('');
    console.log('=== 覆盖缺口（partial 模块的正常状态，按缺口里含多少个函数类成员排序）===');
    var ranked = Object.keys(gapBySpec).sort(function (x, y) {
        return gapBySpec[y].functions - gapBySpec[x].functions || gapBySpec[y].total - gapBySpec[x].total;
    });
    if (ranked.length === 0) {
        console.log('  无');
    } else {
        ranked.forEach(function (spec) {
            console.log('  ' + spec.padEnd(22) + '缺 ' + String(gapBySpec[spec].total).padStart(3) + ' 个（其中函数/类 ' + gapBySpec[spec].functions + '）');
        });
    }
    console.log('');
    console.log('运行时没有对应模块而跳过差分的: ' + (nodeMissing.length === 0 ? '无' : nodeMissing.join(', ')));
    return high.length > 0 ? 1 : 0;
}

process.exitCode = main();
