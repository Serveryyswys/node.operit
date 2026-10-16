'use strict';

/**
 * Operit 运行时的模拟器。
 *
 * 目的：在没有安卓设备的情况下，用**与 Operit 相同的 require 语义**加载打好包的代码。
 * normalizePath / dirname / resolveModulePath / buildCandidatePaths / requireInternal
 * 都是从 Operit-src 的 JsExecutionScriptBuilder.kt 逐行搬过来的，
 * 注释里标了原始行号，改了任何一处都应同步那边。
 *
 * 刻意制造的约束（与真机一致）：
 *   - 裸模块只有 lodash / uuid / axios，其它一律**静默返回 {}**；
 *   - 没有 node_modules 查找；
 *   - 模块树加载期间 globalThis 上没有 process / Buffer / global。
 *
 * 已知的模拟保真度边界：
 *   - 删除全局只覆盖加载期的同步执行；模块如果延后到异步回调里再读 process，
 *     那时全局已恢复。测试包不这么做。
 *   - 不实现 toolCall / Java bridge / UI 相关能力。
 */

var fs = require('fs');
var path = require('path');

// ---- 与 JsExecutionScriptBuilder.kt 对应（行号见注释） ----

function text(value) {                                    // :97
    if (value === undefined || value === null) {
        return '';
    }
    return String(value);
}

function normalizePath(pathValue) {                       // :209
    var parts = text(pathValue).replace(/\\/g, '/').split('/');
    var stack = [];
    for (var i = 0; i < parts.length; i += 1) {
        var part = parts[i];
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            if (stack.length > 0) {
                stack.pop();
            }
            continue;
        }
        stack.push(part);
    }
    return stack.join('/');
}

function dirname(pathValue) {                             // :228
    var normalized = normalizePath(pathValue);
    var index = normalized.lastIndexOf('/');
    return index < 0 ? '' : normalized.slice(0, index);
}

function resolveModulePath(request, fromPath) {           // :234
    var normalized = text(request).replace(/\\/g, '/').trim();
    if (!normalized) {
        return '';
    }
    if (!(normalized.charAt(0) === '.' || normalized.charAt(0) === '/')) {
        return normalized;
    }
    if (normalized.charAt(0) === '/') {
        return normalizePath(normalized);
    }
    var base = dirname(fromPath);
    return normalizePath(base ? base + '/' + normalized : normalized);
}

function buildCandidatePaths(modulePath) {                // :249
    var normalized = normalizePath(modulePath);
    if (!normalized) {
        return [];
    }
    if (/\.[a-z0-9]+$/i.test(normalized)) {
        return [normalized];
    }
    return [
        normalized,
        normalized + '.js',
        normalized + '.json',
        normalized + '/index.js',
        normalized + '/index.json'
    ];
}

/** 模拟 Operit 注入的运行时前导代码（这里只需要占位，模块不直接依赖它）。 */
var RUNTIME_PRELUDE = 'var __operit_runtime_marker = 1;';

function OperitRuntime(options) {
    this.root = options.root;
    this.lodash = options.lodash === undefined ? undefined : options.lodash;
    this.toolCall = options.toolCall === undefined ? undefined : options.toolCall;
    this.moduleInstances = Object.create(null);
    this.loadedModules = [];
    this.requireLog = [];
    this.injectProcess = options.injectProcess === true;
}

OperitRuntime.prototype.readToolPkgModule = function readToolPkgModule(modulePath) {   // :675
    var candidates = buildCandidatePaths(modulePath);
    for (var i = 0; i < candidates.length; i += 1) {
        var candidate = candidates[i];
        var full = path.join(this.root, candidate);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            return { path: candidate, text: fs.readFileSync(full, 'utf8') };
        }
    }
    return null;
};

OperitRuntime.prototype.requireInternal = function requireInternal(moduleName, fromPath) {  // :1262
    var self = this;
    var request = text(moduleName).trim();
    if (request === 'lodash') {
        return this.lodash;
    }
    if (request === 'uuid') {
        return {
            v4: function () {
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
                    var random = Math.random() * 16 | 0;
                    var value = char === 'x' ? random : ((random & 0x3) | 0x8);
                    return value.toString(16);
                });
            }
        };
    }
    if (request === 'axios') {
        return {
            get: function (url, config) {
                return self.toolCall('http_request', config ? Object.assign({ url: url }, config) : { url: url });
            },
            post: function (url, data, config) {
                return self.toolCall('http_request', config ? Object.assign({ url: url, data: data }, config) : { url: url, data: data });
            }
        };
    }
    if (!(request.charAt(0) === '.' || request.charAt(0) === '/')) {
        // 真机行为：静默返回空对象。这正是打包期必须拦截的原因。
        this.requireLog.push({ request: request, from: fromPath, result: 'silent-empty-object' });
        return {};
    }

    var resolvedPath = resolveModulePath(request, fromPath);
    this.requireLog.push({ request: request, from: fromPath, result: resolvedPath });
    var loaded = this.readToolPkgModule(resolvedPath);
    if (!loaded) {
        throw new Error('Cannot resolve module "' + request + '" from "' + (fromPath || '<root>') + '"');
    }
    return this.executeModule(loaded.path, loaded.text, fromPath);
};

OperitRuntime.prototype.executeModule = function executeModule(modulePath, source, fromPath) {  // :1219
    var self = this;
    if (this.moduleInstances[modulePath] !== undefined) {
        return this.moduleInstances[modulePath].exports;
    }
    this.loadedModules.push(modulePath);
    var module = { exports: {} };
    this.moduleInstances[modulePath] = module;

    // 与 Kotlin JsExecutionScriptBuilder.kt:1231 一致：.json 走 JSON.parse，不经过 new Function。
    // （早先这里漏了这一段，于是把 JSON 当 JS 执行、导出恒为空对象，还据此在文档里
    //   写下了"运行时吞掉 JSON require"的错误结论 —— 是同一个误读的自我印证。）
    if (/\.json$/i.test(modulePath)) {
        try {
            module.exports = JSON.parse(source);
        } catch (failure) {
            delete this.moduleInstances[modulePath];
            throw failure;
        }
        return module.exports;
    }

    var requireFn = function (name) {
        return self.requireInternal(name, modulePath);
    };
    // 参数列表与 Operit 完全一致：不额外加参数。
    // 真机上 Buffer / process 是"全局缺失"，而不是"被遮蔽的函数参数"；
    // 加同名参数还会与模块自己声明的 class Buffer 直接语法冲突。
    var factory = new Function(
        'module',
        'exports',
        'require',
        '__operit_call_runtime',
        RUNTIME_PRELUDE + '\n' + source
    );
    try {
        factory(module, module.exports, requireFn, function () { throw new Error('toolCall 未接入'); });
    } catch (failure) {
        // 报错时带上模块路径：否则只有一行 <anonymous> 行号，根本不知道是哪个包炸的
        var wrapped = failure instanceof Error ? failure : new Error(String(failure));
        wrapped.message = '[模块 ' + modulePath + '] ' + wrapped.message;
        wrapped.operitModulePath = modulePath;
        throw wrapped;
    }
    return module.exports;
};

/**
 * Operit 的 QuickJS 全局里没有 process / Buffer / global。
 * 模拟办法：整棵模块树加载期间把它们从 globalThis 上真正删掉再恢复 ——
 * 同 realm、同 intrinsics，typeof process === 'undefined' 与真机一致。
 */
OperitRuntime.prototype.withOperitGlobals = function withOperitGlobals(task) {
    // injectProcess 是给"OperitPackageManager 应当注入 process 全局"这个建议做的对照实验：
    // 打开它就不删 process，用来验证注入之后那些探测 typeof process 的包是否恢复正常。
    var names = this.injectProcess === true ? ['Buffer', 'global'] : ['process', 'Buffer', 'global'];
    var saved = [];
    for (var i = 0; i < names.length; i += 1) {
        saved.push([names[i], Object.getOwnPropertyDescriptor(globalThis, names[i])]);
        delete globalThis[names[i]];
    }
    try {
        return task();
    } finally {
        for (var j = 0; j < saved.length; j += 1) {
            if (saved[j][1] !== undefined) {
                Object.defineProperty(globalThis, saved[j][0], saved[j][1]);
            }
        }
    }
};

OperitRuntime.prototype.runEntry = function runEntry(entryRelativePath) {
    var self = this;
    var loaded = this.readToolPkgModule(entryRelativePath);
    if (!loaded) {
        throw new Error('入口不存在: ' + entryRelativePath);
    }
    return this.withOperitGlobals(function () {
        return self.executeModule(loaded.path, loaded.text, loaded.path);
    });
};

module.exports = {
    OperitRuntime: OperitRuntime,
    normalizePath: normalizePath,
    resolveModulePath: resolveModulePath,
    buildCandidatePaths: buildCandidatePaths,
    dirname: dirname
};
