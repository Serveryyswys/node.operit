'use strict';

/**
 * OperitPackageManager 打包期的「裸名重写」步骤。
 *
 * 关键认识（实测得出）：Operit 的 require **没有 node_modules 查找**。
 *   resolveModulePath: 不以 . 或 / 开头的请求原样返回；
 *   requireInternal:   lodash/uuid/axios 之外的一律 return {}（静默！）
 * 所以打包期必须把**所有**裸名改写成相对路径，不只是 Node 内建：
 *   - Node 内建名 -> node_modules/@serveryyswys/node.operit/dist/<subpath>.js
 *   - npm 包名    -> 该包入口文件（main/exports 解析在打包期做，运行期没有这个能力）
 *   - lodash/uuid/axios -> 保持原样（Operit 自带）
 *
 * 只处理**从入口可达**的文件：npm 包里常有 tests/ 之类的不可达文件，
 * 它们可能 require 没装的 devDependency（实测 safer-buffer/tests.js require('tape')）。
 * 不可达的文件不该让构建失败。
 *
 * 契约表里不可行（planned / unsupported）或可达却解析不到的，**让构建失败**：
 * 运行期拿到 {} 只会退化成"某个值是 undefined"，那是最难定位的一类错。
 */

var fs = require('fs');
var path = require('path');
var jsRequires = require('./js-requires.js');

var OPERIT_BUILTIN_BARE = ['lodash', 'uuid', 'axios'];

function isBare(spec) {
    return !spec.startsWith('.') && !spec.startsWith('/');
}

function loadContract(contractPath) {
    return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
}

function collectJsFiles(dir) {
    var out = [];
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i];
        var full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out = out.concat(collectJsFiles(full));
        } else if (entry.isFile() && /\.(js|cjs|mjs)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function relativeRequire(fromFile, targetFile) {
    var rel = path.relative(path.dirname(fromFile), targetFile).split(path.sep).join('/');
    if (rel.charAt(0) !== '.') {
        rel = './' + rel;
    }
    return rel;
}

function splitSpec(spec) {
    var parts = spec.split('/');
    if (spec.charAt(0) === '@') {
        return { name: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') };
    }
    return { name: parts[0], subpath: parts.slice(1).join('/') };
}

function findPackageDir(name, fromDir, rootDir) {
    var current = fromDir;
    while (true) {
        var candidate = path.join(current, 'node_modules', name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            return candidate;
        }
        var parent = path.dirname(current);
        if (parent === current || current === rootDir) {
            break;
        }
        current = parent;
    }
    return null;
}

function completeExtension(base) {
    var tried = [base, base + '.js', base + '.json', path.join(base, 'index.js'), path.join(base, 'index.json')];
    for (var i = 0; i < tried.length; i += 1) {
        if (fs.existsSync(tried[i]) && fs.statSync(tried[i]).isFile()) {
            return tried[i];
        }
    }
    return null;
}

/** package.json 的入口解析：exports['.'] 优先，其次 main，最后 index.js。 */
function entryOfPackage(packageDir) {
    var manifestPath = path.join(packageDir, 'package.json');
    var manifest = {};
    if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    var entry = manifest.exports;
    if (entry !== undefined && entry !== null) {
        if (typeof entry === 'string') {
            return completeExtension(path.resolve(packageDir, entry));
        }
        if (typeof entry === 'object') {
            var root = entry['.'];
            if (typeof root === 'string') {
                return completeExtension(path.resolve(packageDir, root));
            }
            if (root !== undefined && root !== null && typeof root === 'object') {
                var condition = root.require !== undefined ? root.require : (root.node !== undefined ? root.node : root.default);
                if (typeof condition === 'string') {
                    return completeExtension(path.resolve(packageDir, condition));
                }
            }
        }
    }
    if (typeof manifest.main === 'string') {
        return completeExtension(path.resolve(packageDir, manifest.main));
    }
    return completeExtension(path.join(packageDir, 'index.js'));
}

/**
 * 解析一个 require 目标。返回：
 *   { kind: 'relative' | 'builtin' | 'package' | 'operit-bare' | 'unsupported' | 'unresolved', target? }
 */
function resolveSpec(spec, fromFile, context) {
    if (!isBare(spec)) {
        return { kind: 'relative', target: completeExtension(path.resolve(path.dirname(fromFile), spec)) };
    }
    var bare = spec.indexOf('node:') === 0 ? spec.slice(5) : spec;
    if (OPERIT_BUILTIN_BARE.indexOf(bare) >= 0) {
        return { kind: 'operit-bare' };
    }
    var entry = context.contract.builtins[bare];
    if (entry !== undefined) {
        if (entry.status !== 'ready' && entry.status !== 'partial') {
            return { kind: 'unsupported', reason: entry.status };
        }
        var target = path.join(context.nodeOperitDir, context.contract.distDir, bare + '.js');
        if (!fs.existsSync(target)) {
            return { kind: 'unsupported', reason: 'missing-file' };
        }
        return { kind: 'builtin', target: target };
    }
    var split = splitSpec(bare);
    var packageDir = findPackageDir(split.name, path.dirname(fromFile), context.rootDir);
    if (packageDir === null) {
        return { kind: 'unresolved' };
    }
    var resolved = split.subpath === ''
        ? entryOfPackage(packageDir)
        : completeExtension(path.join(packageDir, split.subpath));
    if (resolved === null) {
        return { kind: 'unresolved' };
    }
    return { kind: 'package', target: resolved, packageName: split.name };
}

/** 从入口出发按 require 关系做可达性分析。 */
function computeReachable(entryPoints, context) {
    var reachable = new Set();
    var queue = entryPoints.slice();
    var missing = [];
    while (queue.length > 0) {
        var file = queue.shift();
        if (reachable.has(file)) {
            continue;
        }
        if (!fs.existsSync(file)) {
            missing.push(file);
            continue;
        }
        reachable.add(file);
        if (file.slice(-3) !== '.js' && file.slice(-4) !== '.cjs' && file.slice(-4) !== '.mjs') {
            continue;
        }
        var calls = jsRequires.findRequires(fs.readFileSync(file, 'utf8'));
        for (var i = 0; i < calls.length; i += 1) {
            var resolution = resolveSpec(calls[i].spec, file, context);
            if (resolution.kind === 'operit-bare' || resolution.kind === 'unresolved' || resolution.kind === 'unsupported') {
                continue;
            }
            queue.push(resolution.target);
        }
    }
    return { reachable: reachable, missing: missing };
}

function jsonShimFor(jsonFile) {
    return jsonFile + '.onj.js';
}

function writeJsonShim(jsonFile, dryRun) {
    var shimPath = jsonShimFor(jsonFile);
    if (!dryRun) {
        var payload = fs.readFileSync(jsonFile, 'utf8');
        fs.writeFileSync(shimPath, 'module.exports = ' + payload.trim() + ';\n', 'utf8');
    }
    return shimPath;
}

function rewriteTree(options) {
    var context = {
        contract: options.contract,
        nodeOperitDir: options.nodeOperitDir,
        rootDir: options.rootDir
    };
    var dryRun = options.dryRun === true;
    var analysis = computeReachable(options.entryPoints, context);
    var reachable = analysis.reachable;

    var report = {
        reachableFiles: reachable.size,
        changedFiles: 0,
        builtins: [],
        packages: [],
        jsonShims: [],
        untouched: {},
        unsupported: [],
        unresolved: [],
        skipped: [],
        missingEntries: analysis.missing
    };

    var allFiles = collectJsFiles(options.targetDir);
    var extraFiles = [];
    reachable.forEach(function (file) { extraFiles.push(file); });

    var files = allFiles.filter(function (file) { return reachable.has(file); });
    var skippedFiles = allFiles.filter(function (file) { return !reachable.has(file); });
    for (var s = 0; s < skippedFiles.length; s += 1) {
        var skippedCalls = jsRequires.findRequires(fs.readFileSync(skippedFiles[s], 'utf8'));
        var bareSkipped = skippedCalls.filter(function (c) { return isBare(c.spec); });
        if (bareSkipped.length > 0) {
            report.skipped.push({
                file: skippedFiles[s],
                specs: bareSkipped.map(function (c) { return c.spec; })
            });
        }
    }

    for (var i = 0; i < files.length; i += 1) {
        var file = files[i];
        var source = fs.readFileSync(file, 'utf8');
        var calls = jsRequires.findRequires(source);
        var edits = [];

        for (var c = 0; c < calls.length; c += 1) {
            var spec = calls[c].spec;
            var resolution = resolveSpec(spec, file, context);
            if (resolution.kind === 'operit-bare') {
                report.untouched[spec] = (report.untouched[spec] || 0) + 1;
                continue;
            }
            if (resolution.kind === 'unsupported') {
                report.unsupported.push({ file: file, spec: spec, status: resolution.reason });
                continue;
            }
            if (resolution.kind === 'unresolved') {
                report.unresolved.push({ file: file, spec: spec });
                continue;
            }
            var target = resolution.target;
            if (resolution.kind === 'relative') {
                // 相对路径 Operit 自己能解析，不用改写；
                // 但 JSON 会被当 JS 文本执行（new Function 里数组字面量当语句，模块导出仍是空对象），
                // 所以 .json 必须换成包装模块 —— iconv-lite 的码表就是这条路径。
                if (target === null || target.slice(-5) !== '.json') {
                    continue;
                }
            } else if (resolution.kind === 'builtin') {
                report.builtins.push({ file: file, spec: spec, target: target });
            } else if (resolution.kind === 'package') {
                report.packages.push({ file: file, spec: spec, target: target });
            }
            if (target.slice(-5) === '.json') {
                report.jsonShims.push({ file: file, spec: spec, shim: jsonShimFor(target) });
                target = writeJsonShim(target, dryRun);
            }
            edits.push({
                start: calls[c].specStart,
                end: calls[c].specEnd,
                replacement: relativeRequire(file, target)
            });
        }

        if (edits.length > 0) {
            report.changedFiles += 1;
            if (!dryRun) {
                fs.writeFileSync(file, jsRequires.applyReplacements(source, edits), 'utf8');
            }
        }
    }
    return report;
}

module.exports = {
    rewriteTree: rewriteTree,
    collectJsFiles: collectJsFiles,
    loadContract: loadContract,
    resolveSpec: resolveSpec,
    entryOfPackage: entryOfPackage,
    computeReachable: computeReachable,
    OPERIT_BUILTIN_BARE: OPERIT_BUILTIN_BARE
};
