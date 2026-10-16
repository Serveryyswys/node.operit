'use strict';

/**
 * fs 的环境状态机。
 *
 * 模型：环境 = 根 + 能力。切环境就是切 cwd —— 相对路径与 path.resolve 的基准随之改变，
 * 所以状态机不是给 fs 打的补丁，而是路径语义的唯一来源。
 *
 *     UNBOUND ──首次使用──▶ BOUND(sdcard)
 *     BOUND(A) ──use(B)──▶ BOUND(B)
 *     BOUND(A) ──with(B, fn)──▶ BOUND(B) ──fn 同步返回──▶ BOUND(A)
 *     BOUND(*) ──reset()──▶ UNBOUND
 *
 * 为什么 with() 强制同步：模块实例会跨工具调用复用（见 DESIGN.md §7.4），
 * 一旦回调是异步的，await 期间别的代码就会看到被改掉的环境。
 */

import { onjError } from './errors';
import { pluginConfigDir, filesDir } from './paths';

export interface FsEnvironmentSpec {
    readonly name: string;
    /** 物理根。用函数是为了让 config / app 这类根惰性解析（需要 bridge）。 */
    readonly root: string | (() => string);
    readonly writable: boolean;
}

export interface FsEnvHooks {
    setCwd(path: string): void;
    getCwd(): string;
    /** 探测根是否可用；抛错即视为不可用。 */
    probe(root: string): void;
}

const BUILTIN_ENVS: readonly FsEnvironmentSpec[] = [
    { name: 'sdcard', root: '/sdcard', writable: true },
    { name: 'config', root: () => pluginConfigDir(), writable: true },
    { name: 'app', root: () => filesDir(), writable: true }
];

const BUILTIN_NAMES: readonly string[] = BUILTIN_ENVS.map((item) => item.name);

const specs = new Map<string, FsEnvironmentSpec>();
BUILTIN_ENVS.forEach((item) => specs.set(item.name, item));

let hooks: FsEnvHooks | null = null;
let currentName: string | null = null;
let strictMode = false;
const stack: string[] = [];

export function setHooks(next: FsEnvHooks): void {
    hooks = next;
}

function requireHooks(): FsEnvHooks {
    if (hooks === null) {
        throw onjError('ONJ_MISSING_HOST', 'fs 环境状态机尚未接入宿主。');
    }
    return hooks;
}

function resolveRoot(spec: FsEnvironmentSpec): string {
    const value = typeof spec.root === 'function' ? spec.root() : spec.root;
    if (typeof value !== 'string' || value.length === 0) {
        throw onjError('ONJ_ENV_UNAVAILABLE', '环境 ' + spec.name + ' 的根解析为空。');
    }
    return value;
}

/** 注册自定义环境。内置环境名不可覆盖。 */
export function define(name: string, spec: Omit<FsEnvironmentSpec, 'name'>): void {
    if (typeof name !== 'string' || name.trim().length === 0) {
        throw new TypeError('fs.env.define 的名称必须是非空字符串。');
    }
    if (BUILTIN_NAMES.indexOf(name) >= 0) {
        throw onjError('ONJ_UNKNOWN_ENV', '内置环境 ' + name + ' 不可覆盖。');
    }
    if (spec === null || typeof spec !== 'object') {
        throw new TypeError('fs.env.define 的 spec 必须是对象。');
    }
    specs.set(name, { name: name, root: spec.root, writable: spec.writable !== false });
}

export function names(): string[] {
    return Array.from(specs.keys());
}

export function current(): string | null {
    return currentName;
}

export function root(): string {
    const spec = requireCurrent();
    return resolveRoot(spec);
}

export function writable(): boolean {
    return requireCurrent().writable;
}

function requireCurrent(): FsEnvironmentSpec {
    if (currentName === null) {
        throw onjError('ONJ_ENV_NOT_SET');
    }
    const spec = specs.get(currentName);
    if (spec === undefined) {
        throw onjError('ONJ_UNKNOWN_ENV', currentName);
    }
    return spec;
}

/** 显式切换环境。根不可用即拒绝，不做任何降级。 */
export function use(name: string): void {
    const spec = specs.get(name);
    if (spec === undefined) {
        throw onjError('ONJ_UNKNOWN_ENV', name);
    }
    const target = resolveRoot(spec);
    const host = requireHooks();
    try {
        host.probe(target);
    } catch (failure) {
        throw onjError('ONJ_ENV_UNAVAILABLE', '环境 ' + name + ' 的根 ' + target + ' 不可用。');
    }
    host.setCwd(target);
    currentName = name;
}

/** 作用域内切换，回调必须同步返回。 */
export function withEnvironment<T>(name: string, callback: () => T): T {
    const host = requireHooks();
    const previousName = currentName;
    const previousCwd = host.getCwd();
    use(name);
    try {
        const result = callback();
        if (isThenable(result)) {
            throw onjError('ONJ_ENV_ASYNC_SCOPE');
        }
        return result;
    } finally {
        host.setCwd(previousCwd);
        currentName = previousName;
    }
}

/** 回到 UNBOUND。cwd 不动 —— 调用方要回默认值请再 use('sdcard')。 */
export function reset(): void {
    currentName = null;
    stack.length = 0;
}

/** strict 模式下，未显式 use() 就使用 fs 会直接报错。 */
export function strict(flag: boolean): void {
    strictMode = flag === true;
}

export function isStrict(): boolean {
    return strictMode;
}

/** fs 每次操作前调用：非 strict 时按默认环境惰性绑定。 */
export function ensureBound(): void {
    if (currentName !== null) {
        return;
    }
    if (strictMode) {
        throw onjError('ONJ_ENV_NOT_SET');
    }
    use(BUILTIN_NAMES[0]);
}

function isThenable(value: unknown): boolean {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    return typeof (value as { then?: unknown }).then === 'function';
}
