'use strict';

/**
 * 本地测试入口：node test/run-tests.js
 * 测试只在桌面 Node 上跑，用于对拍 Node 语义与验证纯逻辑模块。
 *
 * 两个刻意的选择：
 *   - 入口是 async，让个别模块（stream / zlib 的回调形式）能真实等待异步结果；
 *   - 结尾只设 process.exitCode，不调用 process.exit() —— 后者会与管道刷新竞态，
 *     把最后的计数与失败详情截掉（这个坑踩过一次）。
 */

var h = require('./harness.js');

var MODULES = [
    './path.test.js',
    './buffer.test.js',
    './fs.test.js',
    './fs-stream.test.js',
    './fs-fd.test.js',
    './stdlib.test.js',
    './host.test.js',
    './crypto.test.js',
    './zlib.test.js',
    './stream.test.js',
    './child_process.test.js',
    './assert.test.js',
    './url.test.js',
    './url-whatwg.test.js',
    './small-modules.test.js',
    './http.test.js',
    './dns.test.js',
    './new-modules.test.js'
];

/**
 * 看门狗：某个模块的 Promise 若永不 resolve，事件循环会变空、Node 会静默退 0，
 * 看起来像"全绿"。这里把它变成一个明确的失败码。
 */
var currentModule = '启动';
var watchdog = setTimeout(function () {
    process.stdout.write('\n测试超时：模块 ' + currentModule + ' 未在 30s 内完成（很可能是 await 永不 resolve）\n');
    process.exitCode = 3;
}, 30000);

(async function main() {
    for (var i = 0; i < MODULES.length; i += 1) {
        currentModule = MODULES[i];
        var before = h.count();
        var result = require(MODULES[i]).run();
        if (result !== undefined && typeof result.then === 'function') {
            await result;
        }
        process.stdout.write('  ' + MODULES[i].replace('./', '').replace('.test.js', '').padEnd(16) +
            ' 断言 ' + (h.count() - before) + ' 条\n');
    }

    clearTimeout(watchdog);
    process.exitCode = h.report() ? 0 : 1;
})();
