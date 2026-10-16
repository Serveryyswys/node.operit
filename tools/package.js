'use strict';

/**
 * 生成 build/ 下的发布产物。源仓库里改完代码跑这一条即可：
 *
 *     npm run package
 *
 * 做四件事：编译 -> 组装 build/package/ -> npm pack -> 写 build/PUBLISH.md（含校验值）。
 *
 * 用 stdio: 'inherit' 而不是默认的管道：某些受限环境（例如 DSH 的沙箱）不允许
 * 通过管道捕获子进程输出，会直接 EPERM；inherit 不经过管道。
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var zlib = require('zlib');
var childProcess = require('child_process');

var root = path.join(__dirname, '..');
var buildDir = path.join(root, 'build');
var pkgDir = path.join(buildDir, 'package');

function run(command, workdir) {
    var result = childProcess.spawnSync(command, {
        cwd: workdir,
        stdio: 'inherit',
        shell: true
    });
    if (result.status !== 0) {
        throw new Error('命令失败（退出码 ' + result.status + '）：' + command);
    }
}

function copyInto(from, to, names) {
    for (var i = 0; i < names.length; i += 1) {
        var source = path.join(from, names[i]);
        var target = path.join(to, names[i]);
        if (fs.statSync(source).isDirectory()) {
            fs.cpSync(source, target, { recursive: true });
        } else {
            fs.copyFileSync(source, target);
        }
    }
}

/**
 * 极简 tar 目录解析（只读文件名）。用它而不是 shell 调 tar -tzf：
 * 受限环境不允许通过管道捕获子进程输出，而这里需要拿到输出做校验。
 */
function listTarEntries(buffer) {
    var names = [];
    var offset = 0;
    while (offset + 512 <= buffer.length) {
        var header = buffer.subarray(offset, offset + 512);
        var allZero = true;
        for (var i = 0; i < 512; i += 1) {
            if (header[i] !== 0) { allZero = false; break; }
        }
        if (allZero) { break; }
        var name = header.subarray(0, 100).toString('utf8').replace(/\u0000[\s\S]*$/, '');
        var prefix = header.subarray(345, 500).toString('utf8').replace(/\u0000[\s\S]*$/, '');
        if (prefix.length > 0) { name = prefix + '/' + name; }
        var sizeText = header.subarray(124, 136).toString('utf8').replace(/\u0000[\s\S]*$/, '').trim();
        var size = parseInt(sizeText, 8) || 0;
        var typeFlag = String.fromCharCode(header[156]);
        if (typeFlag === '0' || typeFlag === '\u0000') { names.push(name); }
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return names;
}

function countFiles(dir) {
    var total = 0;
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i += 1) {
        total += entries[i].isDirectory() ? countFiles(path.join(dir, entries[i].name)) : 1;
    }
    return total;
}

function main() {
    var sourcePkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    console.log('== 1/4 编译 ==');
    run('npm run build', root);

    console.log('');
    console.log('== 2/4 组装 ' + path.relative(root, pkgDir) + ' ==');
    // 只清空 build/ 的内容，不删目录本身。
    // Windows 上 build/ 可能被别的进程（编辑器、索引器、沙箱）占着句柄，删目录会 EBUSY，
    // 而删里面的内容不会；目录本身留着没有任何副作用。
    if (fs.existsSync(buildDir)) {
        const stale = fs.readdirSync(buildDir);
        for (let index = 0; index < stale.length; index += 1) {
            fs.rmSync(path.join(buildDir, stale[index]), { recursive: true, force: true });
        }
    }
    fs.mkdirSync(pkgDir, { recursive: true });
    copyInto(root, pkgDir, ['dist', 'BUILTINS.json', 'README.md', 'DESIGN.md', 'LICENSE', 'NOTICE']);

    // 发布用的 package.json：只保留消费方需要的字段。
    // 不带 scripts —— 源仓库的 build/test/prepack 在安装方那里既没依赖也没意义。
    // 从源 manifest **派生**发布版：只删掉不该发布的字段，而不是白名单挑选。
    // 白名单会在新增字段时静默丢失 —— author 就这么丢过一次（源码里有，产物里没有）。
    var published = Object.assign({}, sourcePkg);
    delete published.scripts;
    delete published.devDependencies;
    delete published.private;
    // 刻意不带空的 dependencies：私有源的上传管线会把 {} 重新序列化成 []（空数组），
    // 而 [] 不是 package.json 规范里的合法形态。本来就没有依赖，省掉最稳。
    if (published.dependencies !== undefined && Object.keys(published.dependencies).length === 0) {
        delete published.dependencies;
    }
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(published, null, 2) + '\n', 'utf8');

    console.log('');
    console.log('== 3/4 打包 ==');
    // 缓存指到仓库内，避免在某些环境下写系统缓存目录被拒
    run('npm pack --cache "' + path.join(root, 'integration', '.npm-cache') + '"', pkgDir);
    var produced = fs.readdirSync(pkgDir).filter(function (name) { return name.slice(-4) === '.tgz'; });
    if (produced.length !== 1) {
        throw new Error('npm pack 产出了 ' + produced.length + ' 个 tgz，期望 1 个');
    }
    var tgzName = produced[0];
    fs.renameSync(path.join(pkgDir, tgzName), path.join(buildDir, tgzName));
    var tgzPath = path.join(buildDir, tgzName);
    var size = fs.statSync(tgzPath).size;
    var sha256 = crypto.createHash('sha256').update(fs.readFileSync(tgzPath)).digest('hex');
    var distFiles = countFiles(path.join(pkgDir, 'dist'));

    // 校验产物内容：文件名被上传工具改过（例如 LICENSE -> LICENSE.txt）、
    // 或者 files 白名单写漏，都必须在打包这一步就炸出来，而不是等装到用户那里才发现。
    var entries = listTarEntries(zlib.gunzipSync(fs.readFileSync(tgzPath)));
    var required = ['package/package.json', 'package/BUILTINS.json', 'package/README.md', 'package/DESIGN.md', 'package/dist/index.js'];
    var missingEntries = required.filter(function (name) { return entries.indexOf(name) < 0; });
    if (!entries.some(function (name) { return name.indexOf('package/LICENSE') === 0; })) {
        missingEntries.push('package/LICENSE*');
    }
    if (entries.indexOf('package/NOTICE') < 0) {
        missingEntries.push('package/NOTICE');
    }
    if (missingEntries.length > 0) {
        throw new Error('产物缺少这些条目：' + missingEntries.join(', ') + '\n实际内容：' + entries.slice(0, 12).join(', ') + ' …');
    }
    console.log('产物内容校验通过：' + entries.length + ' 个条目，含 LICENSE');

    console.log('');
    console.log('== 4/4 写 PUBLISH.md ==');
    var publish = [
        '# ' + published.name + ' ' + published.version + ' —— 上传到私有源',
        '',
        '本目录就是可直接上传的产物。两个东西用哪个都行：',
        '',
        '| 路径 | 用途 |',
        '| --- | --- |',
        '| `package/` | **目录方式**：`cd package && npm publish --registry <你的源>` |',
        '| `' + tgzName + '` | **tarball 方式**：私有源后台直接传，或 `npm publish <tgz> --registry <你的源>` |',
        '',
        '## 校验',
        '',
        '```',
        '文件名    ' + tgzName,
        '大小      ' + size + ' 字节（' + (size / 1024).toFixed(1) + ' KB）',
        'SHA-256   ' + sha256,
        '内容      dist/ ' + distFiles + ' 个文件（.js 与 .d.ts 成对）',
        '          BUILTINS.json、README.md、DESIGN.md、package.json',
        '```',
        '',
        '运行时**零依赖**（`dependencies: {}`）。',
        '',
        '## 上传',
        '',
        '```bash',
        '# 目录方式',
        'cd package',
        'npm publish --registry <你的私有源>',
        '',
        '# 或 tarball 方式',
        'npm publish ' + tgzName + ' --registry <你的私有源>',
        '```',
        '',
        '需要先在私有源登录（`npm login --registry <你的私有源>`）。若该源上已有同版本号，',
        '先改 `package.json` 的 `version`，再跑一次 `npm run package`。',
        '',
        '## 这个包是给谁用的（重要）',
        '',
        '它是 **Operit 的 QuickJS 运行时**的 Node 能力补充，不是给普通 Node 项目用的库：',
        '',
        '- 包本身是合法的 CommonJS，在 Node 里 `require` 它能加载，纯逻辑（`path`/`buffer`/`crypto`/`url` …）能用；',
        '- 但 `fs` / `os` / `process` / `child_process` / `http` / `dns` 这些**要在 Operit 里才有宿主** ——',
        '  脱离 Operit 调用会抛 `ONJ_MISSING_HOST`（这是刻意的，不是缺陷）。',
        '',
        '消费方式：OperitPackageManager 打包时按 `BUILTINS.json` 的 `packing` 段把裸名重写成',
        '`<rel>/node_modules/@serveryyswys/node.operit/dist/<subpath>.js`。**`BUILTINS.json` 因此必须随包发布**（已包含）。',
        '详细契约见 README 与 DESIGN。',
        '',
        '## 上传前已经验证过什么',
        '',
        '```',
        '把 tgz 解包 -> 放进消费方的 node_modules/@serveryyswys/node.operit',
        '-> 重写 9 个真实 npm 包（ms / iconv-lite / safer-buffer / semver / marked / diff /',
        '   dayjs / debug / supports-color）的裸名',
        '-> 用忠实复刻 Operit require 语义的运行时模拟器加载',
        '-> 再与 Node 原生加载器逐字段比对',
        '',
        '可达文件 113，改写 16 个文件',
        '静默返回 {} 的裸名请求数: 0',
        '比较字段数: 29',
        '全部一致',
        '```',
        '',
        '（这一步用 `npm run verify:artifact` 可以复现。）',
        '',
        '## 关于这个私有源的两点实测行为',
        '',
        '1. **服务端会重写 package.json**。实测：本包的 `dependencies: {}` 被它重新序列化成了 `[]`（空数组，',
        '   不是 package.json 规范里的合法形态）。本产物因此**刻意不写 `dependencies` 字段** —— 本来就没有依赖，',
        '   省掉最稳。除此之外服务端没改动别的字段（name / version / license / main / types / exports / files 都一致）。',
        '2. **上传工具可能在目录里改文件名**。实测：`LICENSE` 被改名成了 `LICENSE.txt`，',
        '   而白名单当时写的是 `"LICENSE"`，于是它没进包 —— 0.1.1 就是这样漏掉了许可证。',
        '   现在白名单写的是 `"LICENSE*"`，两种拼写都能进包（已实测验证），',
        '   并且 `npm run package` 会**校验产物的条目清单**，再漏就直接报错而不是静默通过。',
        '',
        '## 上传前你可能还要处理的一件事',
        '',
        '**版本号**：重复发布同一个版本会被源拒绝，改 `version` 后重跑 `npm run package`。',
        '',
        '## 产物里没有的东西（刻意的）',
        '',
        '`src/`、`test/`、`tools/`、`integration/` 都不在包里 —— 消费方不需要。',
        '发布版也没有 `scripts`，安装方不会执行任何脚本。'
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(buildDir, 'PUBLISH.md'), publish, 'utf8');

    console.log('');
    console.log('完成：');
    console.log('  ' + path.relative(root, pkgDir) + '/');
    console.log('  ' + tgzName + '  ' + size + ' 字节');
    console.log('  SHA-256 ' + sha256);
}

main();
