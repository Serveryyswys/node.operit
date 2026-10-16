'use strict';

/**
 * 极简断言harness。测试只在桌面 Node 上跑，不进包（package.json 的 files 不含 test/）。
 */

var state = { passed: 0, failed: 0, failures: [] };

function format(value) {
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    return JSON.stringify(value);
}

function record(ok, label, expected, actual) {
    if (ok) {
        state.passed += 1;
        return;
    }
    state.failed += 1;
    if (state.failures.length < 50) {
        state.failures.push(label + '\n    expected: ' + format(expected) + '\n    actual:   ' + format(actual));
    }
}

function equal(actual, expected, label) {
    record(actual === expected, label, expected, actual);
}

function deepEqual(actual, expected, label) {
    record(JSON.stringify(actual) === JSON.stringify(expected), label, expected, actual);
}

function ok(condition, label) {
    record(Boolean(condition), label, true, condition);
}

function section(name) {
    process.stdout.write('\n== ' + name + ' ==\n');
}

function report() {
    // 同时落盘：stdout 在长输出下可能被外层截断，文件里留着完整汇总
    try {
        var fileReport = 'passed: ' + state.passed + ', failed: ' + state.failed + '\n';
        if (state.failed > 0) {
            fileReport += state.failures.join('\n') + '\n';
        }
        require('fs').writeFileSync(__dirname + '/last-run.txt', fileReport);
    } catch (ignored) {
        // 落盘失败不影响测试结论
    }
    process.stdout.write('\npassed: ' + state.passed + ', failed: ' + state.failed + '\n');
    if (state.failures.length > 0) {
        process.stdout.write('\n失败样例:\n');
        state.failures.forEach(function (item) {
            process.stdout.write('  - ' + item + '\n');
        });
        if (state.failed > state.failures.length) {
            process.stdout.write('  ... 其余 ' + (state.failed - state.failures.length) + ' 条省略\n');
        }
    }
    return state.failed === 0;
}

function count() {
    return state.passed + state.failed;
}

module.exports = {
    count: count,
    equal: equal,
    deepEqual: deepEqual,
    ok: ok,
    section: section,
    report: report
};
