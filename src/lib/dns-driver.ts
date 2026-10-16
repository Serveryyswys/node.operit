'use strict';

/**
 * dns 的宿主驱动层：把"怎么把主机名解析成地址"收敛在一处，便于测试注入。
 *
 * 基于 java.net.InetAddress（即 getaddrinfo），这也是 dns.lookup 在 Node 里的实现路径。
 * **记录级查询（resolveMx / resolveTxt 等）在 Android 上不成立**：
 * 那需要 JNDI 的 DNS provider，而 com.sun.jndi.dns 不在 Android 里，
 * 所以 dns.ts 对它们显式抛 ONJ_UNSUPPORTED，不做半个实现。
 */

import * as bridge from './bridge';
import { createError } from './errors';

export interface AddressRecord {
    address: string;
    family: number;
}

export interface DnsDriver {
    /** 对应 getaddrinfo：可能返回多条（IPv4 与 IPv6 都在）。失败时抛 Java 侧映射过的错误。 */
    lookup(hostname: string): AddressRecord[];
    /** 反向查询：地址 -> 规范主机名。 */
    canonicalNameOf(address: string): string;
}

let driver: DnsDriver | null = null;

/** 宿主注入点：桌面测试用，传 null 恢复为 Operit Java 驱动。 */
export function setDriver(next: DnsDriver | null): void {
    driver = next;
}

/** Java 可能给链路本地地址带上作用域（fe80::1%wlan0），Node 不给，这里去掉。 */
function stripScope(address: string): string {
    const percent = address.indexOf('%');
    return percent < 0 ? address : address.slice(0, percent);
}

export function createJavaDriver(): DnsDriver {
    return {
        lookup(hostname: string): AddressRecord[] {
            const list = bridge.callStatic('java.net.InetAddress', 'getAllByName', [hostname]);
            if (!Array.isArray(list)) {
                throw createError('EIO', 'getaddrinfo', hostname);
            }
            const out: AddressRecord[] = [];
            for (let i = 0; i < list.length; i += 1) {
                const raw = String(bridge.callInstance(list[i], 'getHostAddress', []));
                const address = stripScope(raw);
                out.push({ address: address, family: address.indexOf(':') >= 0 ? 6 : 4 });
            }
            return out;
        },
        canonicalNameOf(address: string): string {
            const handle = bridge.callStatic('java.net.InetAddress', 'getByName', [address]);
            return String(bridge.callInstance(handle, 'getCanonicalHostName', []));
        }
    };
}

export function getDriver(): DnsDriver {
    if (driver === null) {
        driver = createJavaDriver();
    }
    return driver;
}
