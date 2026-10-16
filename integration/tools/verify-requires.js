'use strict';

/**
 * tools/js-requires.js 的单元检查：注释/字符串/模板串/正则里的 require 不能被误认为真依赖。
 * 误报的后果很实际 —— node.operit 自己的文档注释里就写着 require('<项目>/...')。
 */

var req = require('./js-requires.js');

var Q = String.fromCharCode(39);
var DQ = String.fromCharCode(34);
var BT = String.fromCharCode(96);
var NL = String.fromCharCode(10);

function str(literal) { return Q + literal + Q; }
function call(name) { return 'require(' + str(name) + ')'; }

var cases = [
    ['普通', 'var a = ' + call('fs') + ';', ['fs']],
    ['行注释', '// ' + call('fs') + NL + 'var a = 1;', []],
    ['块注释', '/* ' + call('fs') + ' */ var a = 1;', []],
    ['双引号字符串里', 'var s = ' + DQ + call('fs') + DQ + ';', []],
    ['单引号字符串里', 'var t = ' + str('x ' + call('fs')) + ';', []],
    ['模板串里', 'var s = ' + BT + call('fs') + BT + ';', []],
    ['正则字面量里', 'var r = /' + 'require\\(' + Q + 'fs' + Q + '\\)' + '/;', []],
    ['除号不误判为正则', 'var x = a / b; var c = ' + call('path') + ';', ['path']],
    ['多个调用', call('a') + '; ' + call('b') + ';', ['a', 'b']],
    ['动态参数不认', 'require(someVar);', []],
    ['node: 前缀原样保留', call('node:fs') + ';', ['node:fs']],
    ['return 后的正则', 'function f() { return /x/; } var c = ' + call('url') + ';', ['url']],
    ['字符串里的转义引号', 'var s = ' + str('a\\' + Q + ' ' + call('fs')) + ';', []]
];

var failures = 0;
for (var i = 0; i < cases.length; i += 1) {
    var actual = req.findRequires(cases[i][1]).map(function (f) { return f.spec; });
    var expected = cases[i][2];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error('  FAIL ' + cases[i][0] + ' 期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual));
        failures += 1;
    }
}
if (failures > 0) {
    console.error('js-requires 检查失败 ' + failures + ' 项');
    process.exitCode = 1;
} else {
    console.log('js-requires 检查通过（' + cases.length + ' 个用例）');
}
