'use strict';

/**
 * 验证「要上传到私有源的产物」本身，而不是开发树。
 *
 *     npm run verify:artifact
 *
 * 步骤：把 build/ 里的 tgz 解包 -> 让 integration/tools/run.js 用它当 node.operit
 * （通过 ONJ_ARTIFACT_DIR）-> 跑那一整套真实 npm 包的端到端验证。
 *
 * 为什么值得单独做：开发树能跑不等于打包出来的东西完整 —— 少一个文件、
 * files 白名单写漏、exports 写错，都只有拿产物跑才会暴露。
 */

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var root = path.join(__dirname, '..', '..');
var buildDir = path.join(root, 'build');
var integrationDir = path.join(root, 'integration');

function run(command, options) {
    var result = childProcess.spawnSync(command, Object.assign({ stdio: 'inherit', shell: true }, options));
    if (result.status !== 0) {
        throw new Error('命令失败（退出码 ' + result.status + '）：' + command);
    }
}

function main() {
    if (!fs.existsSync(buildDir)) {
        throw new Error('build/ 不存在，先跑 npm run package');
    }
    var archives = fs.readdirSync(buildDir).filter(function (name) { return name.slice(-4) === '.tgz'; });
    if (archives.length !== 1) {
        throw new Error('build/ 里应当有且仅有一个 tgz，实际 ' + archives.length + ' 个');
    }
    var tgzPath = path.join(buildDir, archives[0]);
    var extractDir = path.join(buildDir, '.verify');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });

    console.log('== 解包 ' + archives[0] + ' ==');
    run('tar -xzf "' + tgzPath + '" -C "' + extractDir + '"');
    var artifactDir = path.join(extractDir, 'package');
    var expected = ['package.json', 'BUILTINS.json', 'README.md', 'DESIGN.md', 'LICENSE', 'dist'];
    var missing = expected.filter(function (name) { return !fs.existsSync(path.join(artifactDir, name)); });
    if (missing.length > 0) {
        throw new Error('产物缺少：' + missing.join(', '));
    }
    console.log('产物内容完整：' + expected.join(', '));

    console.log('');
    console.log('== 用该产物跑端到端验证 ==');
    var environment = Object.assign({}, process.env, { ONJ_ARTIFACT_DIR: artifactDir });
    run('node tools/run.js', { cwd: integrationDir, env: environment });

    fs.rmSync(extractDir, { recursive: true, force: true });
    console.log('');
    console.log('产物验证通过。');
}

main();
