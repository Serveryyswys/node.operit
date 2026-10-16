'use strict';

/**
 * Node os 模块的移植。
 *
 * 取值全部来自 Android / Java 侧，因此与桌面 Node 的数值必然不同；
 * 这里保证的是**形状与语义**（类型、单位、字段名）与 Node 一致，
 * 以及每个近似值都在 README / BUILTINS.json 里写清楚。
 *
 * 已知近似：
 *   - totalmem / freemem 取的是 JVM 堆上限与空闲量，不是物理内存
 *   - cpus() 的 model 是 os.arch，speed 为 0，times 全 0
 *   - homedir() 返回 /sdcard（Android 没有用户 home 概念）
 *   - loadavg() 恒为 [0,0,0]
 */

import * as bridge from './lib/bridge';
import * as paths from './lib/paths';
import { onjError, ERRNO } from './lib/errors';

export interface CpuInfo {
    model: string;
    speed: number;
    times: { user: number; nice: number; sys: number; idle: number; irq: number };
}

export interface NetworkInterfaceInfo {
    address: string;
    family: string;
    internal: boolean;
}

function runtime(): unknown {
    return bridge.callStatic('java.lang.Runtime', 'getRuntime', []);
}

function readProperty(name: string): string {
    const value = bridge.callStatic('java.lang.System', 'getProperty', [name]);
    return typeof value === 'string' ? value : '';
}

/** Node 的 arch 命名与 Java 的 os.arch 不同，这里显式映射。 */
function mapArch(javaArch: string): string {
    switch (javaArch) {
        case 'aarch64':
        case 'arm64':
            return 'arm64';
        case 'x86_64':
        case 'amd64':
            return 'x64';
        case 'i386':
        case 'i686':
        case 'x86':
            return 'ia32';
        case 'arm':
            return 'arm';
        default:
            return javaArch;
    }
}

export const EOL = '\n';

export function platform(): string {
    return 'android';
}

export function arch(): string {
    return mapArch(readProperty('os.arch'));
}

export function machine(): string {
    return arch();
}

export function type(): string {
    return 'Linux';
}

export function release(): string {
    const value = bridge.getStaticField('android.os.Build$VERSION', 'RELEASE');
    return typeof value === 'string' ? value : '';
}

export function version(): string {
    return readProperty('os.version');
}

export function endianness(): string {
    return 'LE';
}

export function hostname(): string {
    const local = bridge.callStatic('java.net.InetAddress', 'getLocalHost', []);
    const name = bridge.callInstance(local, 'getHostName', []);
    return typeof name === 'string' ? name : '';
}

export function tmpdir(): string {
    return paths.cacheDir();
}

/** Android 没有用户 home；按已安装包都可见的公共目录取 /sdcard。 */
export function homedir(): string {
    return '/sdcard';
}

export function availableParallelism(): number {
    const value = bridge.callInstance(runtime(), 'availableProcessors', []);
    const count = Number(value);
    return isFinite(count) && count > 0 ? count : 1;
}

export function cpus(): CpuInfo[] {
    const count = availableParallelism();
    const model = readProperty('os.arch');
    const out: CpuInfo[] = [];
    for (let i = 0; i < count; i += 1) {
        out.push({
            model: model,
            speed: 0,
            times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
        });
    }
    return out;
}

/** JVM 堆上限，不是物理内存总量。 */
export function totalmem(): number {
    return Number(bridge.callInstance(runtime(), 'maxMemory', [])) || 0;
}

/** JVM 堆空闲量，不是系统可用内存。 */
export function freemem(): number {
    return Number(bridge.callInstance(runtime(), 'freeMemory', [])) || 0;
}

export function loadavg(): number[] {
    return [0, 0, 0];
}

export function uptime(): number {
    const elapsed = Number(bridge.callStatic('android.os.SystemClock', 'elapsedRealtime', [])) || 0;
    return Math.floor(elapsed / 1000);
}

export interface UserInfo {
    uid: number;
    gid: number;
    username: string;
    homedir: string;
    shell: string;
}

export function userInfo(): UserInfo {
    return {
        uid: -1,
        gid: -1,
        username: readProperty('user.name'),
        homedir: homedir(),
        shell: '/system/sh'
    };
}

/** 通过 NetworkInterface 的 Enumeration 逐个展开；Java 侧没有直接可用的集合视图。 */
export function networkInterfaces(): Record<string, NetworkInterfaceInfo[]> {
    const out: Record<string, NetworkInterfaceInfo[]> = {};
    const interfaces = bridge.callStatic('java.net.NetworkInterface', 'getNetworkInterfaces', []);
    if (interfaces === null || typeof interfaces !== 'object') {
        return out;
    }
    while (bridge.normalizeBoolean(bridge.callInstance(interfaces, 'hasMoreElements', []))) {
        const current = bridge.callInstance(interfaces, 'nextElement', []);
        const name = String(bridge.callInstance(current, 'getName', []));
        const addresses: NetworkInterfaceInfo[] = [];
        const enumeration = bridge.callInstance(current, 'getInetAddresses', []);
        while (bridge.normalizeBoolean(bridge.callInstance(enumeration, 'hasMoreElements', []))) {
            const address = bridge.callInstance(enumeration, 'nextElement', []);
            const text = String(bridge.callInstance(address, 'getHostAddress', []));
            addresses.push({
                address: text,
                family: text.indexOf(':') >= 0 ? 'IPv6' : 'IPv4',
                internal: bridge.normalizeBoolean(bridge.callInstance(address, 'isLoopbackAddress', []))
            });
        }
        out[name] = addresses;
    }
    return out;
}

/** Node 的 os.devNull 是字符串属性，不是函数。 */
export const devNull = '/dev/null';

/** 进程优先级在 Android 上由调度器策略决定，Node 的 niceness 语义不成立。 */
export function getPriority(): number {
    throw onjError('ONJ_UNSUPPORTED', 'os.getPriority() 依赖 POSIX niceness，Android 上不成立。');
}

export function setPriority(): void {
    throw onjError('ONJ_UNSUPPORTED', 'os.setPriority() 依赖 POSIX niceness，Android 上不成立。');
}

function buildPositiveErrno(): Record<string, number> {
    const out: Record<string, number> = {};
    const names = Object.keys(ERRNO);
    for (let i = 0; i < names.length; i += 1) {
        out[names[i]] = Math.abs(ERRNO[names[i]]);
    }
    return out;
}

export const constants = {
    signals: {
        SIGHUP: 1,
        SIGINT: 2,
        SIGQUIT: 3,
        SIGILL: 4,
        SIGTRAP: 5,
        SIGABRT: 6,
        SIGBUS: 7,
        SIGFPE: 8,
        SIGKILL: 9,
        SIGUSR1: 10,
        SIGSEGV: 11,
        SIGUSR2: 12,
        SIGPIPE: 13,
        SIGALRM: 14,
        SIGTERM: 15,
        SIGWINCH: 28
    },
    // Node 的 os.constants.errno 是正的，而 lib/errors 的 ERRNO 取负（对应 error.errno）
    errno: buildPositiveErrno(),
    priority: {
        PRIORITY_LOW: 19,
        PRIORITY_BELOW_NORMAL: 10,
        PRIORITY_NORMAL: 0,
        PRIORITY_ABOVE_NORMAL: -7,
        PRIORITY_HIGH: -14,
        PRIORITY_HIGHEST: -20
    }
};
