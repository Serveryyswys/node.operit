'use strict';

/**
 * 端到端验证跑批：
 *   1. 把 node_modules 复制成 build/（模拟打包产物）；
 *   2. 写入 toolpkg 入口 main.js；
 *   3. 做裸名重写（Node 内建 -> node.operit，npm 包 -> 包入口）；
 *   4. 用 Operit 运行时模拟器加载入口；
 *   5. 同一份打包产物再用 Node 原生加载器跑一遍，两边结果必须一致。
 *
 * 第 5 步是关键：它把"模拟器里能跑"与"代码本身是对的"分开，
 * 否则一个坏掉的模拟器也能"跑通"。
 */

var fs = require('fs');
var path = require('path');
var rewrite = require('./rewrite.js');
var runtimeModule = require('./operit-runtime.js');

var integration = path.join(__dirname, '..');
var sourceModules = path.join(integration, 'node_modules');
var buildDir = path.join(integration, 'build');

/**
 * 本包的安装目录名**从 package.json 的 name 推导**，不写死。
 * 私有源上是带 scope 的 @serveryyswys/node.operit，对应 node_modules/@serveryyswys/node.operit/；
 * 写死的话，换个 scope 就要改测试，而契约本身其实与 scope 无关。
 */
var LIBRARY_NAME = JSON.parse(fs.readFileSync(path.join(integration, '..', 'package.json'), 'utf8')).name;

function libraryDirUnder(modulesDir) {
    // name 形如 @scope/pkg 时，path.join 天然拼出两级目录
    return path.join(modulesDir, LIBRARY_NAME);
}

/** 列出 node_modules 下的包目录；遇到 @scope 目录展开一层。 */
function listPackageDirs(modulesDir) {
    var out = [];
    var entries = fs.readdirSync(modulesDir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i];
        if (!entry.isDirectory() || entry.name === '.bin') {
            continue;
        }
        if (entry.name.charAt(0) === '@') {
            var scoped = fs.readdirSync(path.join(modulesDir, entry.name), { withFileTypes: true });
            for (var j = 0; j < scoped.length; j += 1) {
                if (scoped[j].isDirectory()) {
                    out.push(path.join(modulesDir, entry.name, scoped[j].name));
                }
            }
            continue;
        }
        out.push(path.join(modulesDir, entry.name));
    }
    return out;
}

function fail(message) {
    console.error('FAIL: ' + message);
    process.exitCode = 1;
}

/**
 * 模拟 npm install：把 node.operit 刷进消费方的 node_modules。
 *
 * 默认用开发树（integration/../dist）。设了 ONJ_ARTIFACT_DIR 就改用**打包产物** ——
 * 那才是「要上传到私有源的东西」，验证它本身能跑通契约，而不是验证开发树能跑。
 */
function refreshNodeOperit() {
    var dest = libraryDirUnder(sourceModules);
    var artifact = process.env.ONJ_ARTIFACT_DIR;
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    if (artifact !== undefined && artifact !== '') {
        console.log('（使用打包产物：' + artifact + '）');
        fs.cpSync(artifact, dest, { recursive: true });
        return;
    }
    ['package.json', 'BUILTINS.json'].forEach(function (name) {
        fs.copyFileSync(path.join(integration, '..', name), path.join(dest, name));
    });
    fs.cpSync(path.join(integration, '..', 'dist'), path.join(dest, 'dist'), { recursive: true });
}

function pack() {
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });
    fs.cpSync(sourceModules, path.join(buildDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'main.js'), require('./main-source.js'), 'utf8');
}

function collectEntryPoints() {
    var points = [path.join(buildDir, 'main.js')];
    var libraryDir = path.resolve(libraryDirUnder(path.join(buildDir, 'node_modules')));
    listPackageDirs(path.join(buildDir, 'node_modules')).forEach(function (dir) {
        if (path.resolve(dir) === libraryDir) {
            return;
        }
        var main = rewrite.entryOfPackage(dir);
        if (main !== null) {
            points.push(main);
        }
    });
    return points;
}

function main() {
    require('./verify-requires.js');
    refreshNodeOperit();
    pack();
    var nodeOperitDir = libraryDirUnder(path.join(buildDir, 'node_modules'));
    var contract = rewrite.loadContract(path.join(nodeOperitDir, 'BUILTINS.json'));
    var report = rewrite.rewriteTree({
        targetDir: buildDir,
        nodeOperitDir: nodeOperitDir,
        contract: contract,
        rootDir: buildDir,
        entryPoints: collectEntryPoints()
    });

    console.log('== 打包 ==');
    console.log('可达文件 ' + report.reachableFiles + '，改写 ' + report.changedFiles + ' 个文件');
    var builtinTally = {};
    report.builtins.forEach(function (i) { builtinTally[i.spec] = (builtinTally[i.spec] || 0) + 1; });
    var packageTally = {};
    report.packages.forEach(function (i) { packageTally[i.spec] = (packageTally[i.spec] || 0) + 1; });
    console.log('Node 内建 -> node.operit: ' + JSON.stringify(builtinTally));
    console.log('npm 包 -> 包入口: ' + JSON.stringify(packageTally));
    console.log('JSON 包装模块: ' + report.jsonShims.length + ' 个');
    console.log('跳过的不可达文件: ' + report.skipped.length + ' 个含裸名的文件');
    if (report.unsupported.length > 0) {
        fail('契约表里不可行: ' + JSON.stringify(report.unsupported));
        return;
    }
    if (report.unresolved.length > 0) {
        fail('可达却解析不到: ' + JSON.stringify(report.unresolved));
        return;
    }

    // 宿主全局：真机上这些都有，模拟器补上更接近真实环境
    globalThis.getEnv = function () { return undefined; };
    globalThis.getState = function () { return 'idle'; };
    globalThis.getLang = function () { return 'zh'; };
    globalThis.getPluginConfigDir = function (id) { return path.join(buildDir, '.plugin-config', id === '' ? 'demo' : id); };
    globalThis.OPERIT_DOWNLOAD_DIR = path.join(buildDir, '.download');
    globalThis.OPERIT_CLEAN_ON_EXIT_DIR = path.join(buildDir, '.clean');

    console.log('');
    console.log('== 用 Operit 运行时模拟器加载 ==');
    var simulative;
    try {
        var runtime = new runtimeModule.OperitRuntime({
            root: buildDir,
            lodash: {},
            toolCall: function () { throw new Error('toolCall 未接入'); }
        });
        simulative = runtime.runEntry('main.js');
        console.log('加载模块数: ' + runtime.loadedModules.length);
        console.log('静默返回 {} 的裸名请求数: ' + runtime.requireLog.filter(function (r) { return r.result === 'silent-empty-object'; }).length);
    } catch (error) {
        fail('模拟器加载抛错: ' + (error && error.stack ? error.stack : String(error)));
        return;
    }

    console.log('');
    console.log('== 用 Node 原生加载器加载同一份产物（对照） ==');
    var reference;
    try {
        reference = require(path.join(buildDir, 'main.js'));
    } catch (error) {
        fail('Node 加载抛错: ' + (error && error.stack ? error.stack : String(error)));
        return;
    }

    setTimeout(function () {
        console.log('');
        console.log('== 差分比较（纯函数型包，必须逐字段一致）==');
        var mine = simulative.differential;
        var theirs = reference.differential;
        var mismatches = [];
        var keys = Object.keys(theirs);
        keys.forEach(function (key) {
            var left = JSON.stringify(mine[key]);
            var right = JSON.stringify(theirs[key]);
            if (left !== right) {
                mismatches.push(key + '\n    模拟器: ' + left + '\n    Node  : ' + right);
            }
        });
        console.log('比较字段数: ' + keys.length);
        if (mismatches.length > 0) {
            fail('结果不一致:\n    ' + mismatches.join('\n    '));
            return;
        }
        console.log('全部一致');

        console.log('');
        console.log('== 环境敏感型包（会探测 typeof process，只报不判）==');
        console.log('模拟器（无 process 全局，与真机一致）:');
        console.log('  ' + JSON.stringify(simulative.environmentSensitive, null, 2).split('\n').join('\n  '));
        console.log('Node 原生加载器（有 process 全局）:');
        console.log('  ' + JSON.stringify(reference.environmentSensitive, null, 2).split('\n').join('\n  '));
        console.log('');
        console.log('== 对照实验：注入 process 全局之后 ==');
        console.log('（这是给 OperitPackageManager 的建议：把 node.operit 的 process 挂成全局，');
        console.log('  否则 supports-color 这类顶层就解构 process 的包会在 require 时直接抛）');
        var processModulePath = path.join(nodeOperitDir, 'dist', 'process.js');
        globalThis.process = require(processModulePath);
        try {
            var injected = new runtimeModule.OperitRuntime({
                root: buildDir,
                lodash: {},
                toolCall: function () { throw new Error('toolCall 未接入'); },
                injectProcess: true
            });
            var injectedResult = injected.runEntry('main.js');
            console.log('  模拟器 + process 全局: ' + JSON.stringify(injectedResult.environmentSensitive));
            console.log('  Node 原生加载器      : ' + JSON.stringify(reference.environmentSensitive));
            var sameShape = injectedResult.environmentSensitive.supportsColorKeys !== undefined &&
                JSON.stringify(injectedResult.environmentSensitive.supportsColorKeys) ===
                JSON.stringify(reference.environmentSensitive.supportsColorKeys);
            console.log(sameShape
                ? '  -> 注入之后支持度探测恢复正常，与 Node 一致'
                : '  -> 注入之后仍不一致，需要进一步查');
        } finally {
            delete globalThis.process;
        }

        console.log('');
        console.log('== 结果摘录（differential）==');
        console.log(JSON.stringify(mine, null, 2).slice(0, 2000));
    }, 300);
}

main();
