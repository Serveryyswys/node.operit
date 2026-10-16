'use strict';
var path = require('path');
var rewrite = require('./rewrite.js');
var integration = path.join(__dirname, '..');
var modules = path.join(integration, 'node_modules');
// 安装目录名从 package.json 的 name 推导（可能带 scope）
var libraryName = JSON.parse(require('fs').readFileSync(path.join(integration, '..', 'package.json'), 'utf8')).name;
var libraryDir = path.join(modules, libraryName);
var contract = rewrite.loadContract(path.join(libraryDir, 'BUILTINS.json'));

// 入口 = 每个第三方包的 package.json 入口（跳过本包本身，scope 目录要展开）
var entryPoints = [];
function addPackage(dir) {
    var main = rewrite.entryOfPackage(dir);
    if (main) { entryPoints.push(main); }
}
require('fs').readdirSync(modules, { withFileTypes: true }).forEach(function (e) {
    if (!e.isDirectory() || e.name === '.bin') { return; }
    if (e.name.charAt(0) === '@') {
        require('fs').readdirSync(path.join(modules, e.name), { withFileTypes: true }).forEach(function (inner) {
            if (!inner.isDirectory()) { return; }
            var dir = path.join(modules, e.name, inner.name);
            if (path.resolve(dir) === path.resolve(libraryDir)) { return; }
            addPackage(dir);
        });
        return;
    }
    if (path.resolve(path.join(modules, e.name)) === path.resolve(libraryDir)) { return; }
    addPackage(path.join(modules, e.name));
});
console.log('本包安装目录: ' + path.relative(modules, libraryDir));
console.log('入口点: ' + entryPoints.map(function (p) { return p.replace(modules + path.sep, ''); }).join(', '));

var result = rewrite.rewriteTree({
    targetDir: modules,
    nodeOperitDir: libraryDir,
    contract: contract,
    rootDir: integration,
    entryPoints: entryPoints,
    dryRun: true
});
function tally(list) { var m = {}; list.forEach(function (i) { m[i.spec] = (m[i.spec] || 0) + 1; }); return JSON.stringify(m); }
console.log('可达文件: ' + result.reachableFiles + ' | 需要改写: ' + result.changedFiles);
console.log('Node 内建 -> node.operit: ' + tally(result.builtins));
console.log('npm 包 -> 入口: ' + tally(result.packages));
console.log('保持原样(Operit 内建): ' + JSON.stringify(result.untouched));
console.log('不可行: ' + JSON.stringify(result.unsupported));
console.log('可达却解析不到: ' + JSON.stringify(result.unresolved));
console.log('不可达且含裸名的文件（已跳过）: ' + result.skipped.length + ' 个');
