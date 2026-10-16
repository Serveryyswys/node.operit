'use strict';

/**
 * dns/promises 子路径入口。
 *
 * 与 `require('dns').promises` 是同一份实现：lookup / lookupService / getServers /
 * setDefaultResultOrder 等。resolve 一族同样显式抛 ONJ_UNSUPPORTED（原因见 dns.ts）。
 */

import { onjError } from '../lib/errors';
import * as dnsDriver from '../lib/dns-driver';
import type { DnsError, LookupOptions } from '../lib/dns-types';

const GETADDRINFO_ERRNO: Readonly<Record<string, number>> = {
    ENOTFOUND: -3008,
    EAI_AGAIN: -3001,
    EAI_FAIL: -3003,
    EAI_NODATA: -3006,
    EAI_NONAME: -3007,
    ENODATA: -3006
};

const SERVICE_NAMES: Readonly<Record<number, string>> = {
    20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain',
    80: 'http', 110: 'pop3', 143: 'imap', 443: 'https', 465: 'smtps', 587: 'submission',
    993: 'imaps', 995: 'pop3s', 3306: 'mysql', 5432: 'postgresql', 6379: 'redis',
    8080: 'http-alt', 8443: 'https-alt'
};

let resultOrder = 'verbatim';

function dnsFailure(code: string, hostname: string): DnsError {
    const error = new Error('getaddrinfo ' + code + ' ' + hostname) as DnsError;
    error.code = code;
    error.errno = GETADDRINFO_ERRNO[code] === undefined ? -3008 : GETADDRINFO_ERRNO[code];
    error.syscall = 'getaddrinfo';
    error.hostname = hostname;
    return error;
}

function codeForFailure(failure: unknown): string {
    const mapped = failure as { code?: string; message?: string };
    if (mapped.code === 'ENOTFOUND' || mapped.code === 'EAI_AGAIN') {
        return mapped.code;
    }
    const message = mapped.message === undefined ? '' : mapped.message;
    if (/temporary failure in name resolution|unable to resolve host/i.test(message)) {
        return 'EAI_AGAIN';
    }
    return 'ENOTFOUND';
}

function serviceNameOf(port: number): string {
    const known = SERVICE_NAMES[port];
    return known === undefined ? String(port) : known;
}

function normalizeOptions(options?: number | LookupOptions): { family: number; all: boolean; verbatim: boolean } {
    let family = 0;
    let all = false;
    let verbatim = resultOrder === 'verbatim';
    if (typeof options === 'number') {
        family = options;
    } else if (options !== undefined && options !== null) {
        if (typeof options.family === 'number') {
            family = options.family;
        }
        all = options.all === true;
        if (typeof options.verbatim === 'boolean') {
            verbatim = options.verbatim;
        }
    }
    return { family: family, all: all, verbatim: verbatim };
}

function lookup(hostname: unknown, options?: number | LookupOptions): Promise<unknown> {
    const host = String(hostname);
    const settings = normalizeOptions(options);
    return new Promise(function (resolve, reject): void {
        let records;
        try {
            records = dnsDriver.getDriver().lookup(host);
        } catch (failure) {
            reject(dnsFailure(codeForFailure(failure), host));
            return;
        }
        let filtered = records;
        if (settings.family === 4 || settings.family === 6) {
            filtered = records.filter(function (record): boolean { return record.family === settings.family; });
        }
        if (!settings.verbatim) {
            filtered = filtered.slice().sort(function (left, right): number { return left.family - right.family; });
        }
        if (filtered.length === 0) {
            reject(dnsFailure('ENOTFOUND', host));
            return;
        }
        if (settings.all) {
            resolve(filtered);
            return;
        }
        resolve({ address: filtered[0].address, family: filtered[0].family });
    });
}

function lookupService(address: unknown, port: unknown): Promise<{ hostname: string; service: string }> {
    const target = String(address);
    const numericPort = Number(port);
    return new Promise(function (resolve, reject): void {
        try {
            resolve({
                hostname: dnsDriver.getDriver().canonicalNameOf(target),
                service: serviceNameOf(numericPort)
            });
        } catch (failure) {
            reject(dnsFailure(codeForFailure(failure), target));
        }
    });
}

function getServers(): string[] {
    return [];
}

function setServers(): never {
    throw onjError('ONJ_UNSUPPORTED', 'dns.setServers() 无法实现：JVM 的解析器配置改不了（Android 由 netd 按网络管理）。');
}

function getDefaultResultOrder(): string {
    return resultOrder;
}

function setDefaultResultOrder(order: unknown): void {
    const value = String(order);
    if (value !== 'verbatim' && value !== 'ipv4first' && value !== 'ipv6first') {
        throw new TypeError('Invalid result order: ' + value);
    }
    resultOrder = value;
}

function unsupportedResolve(name: string): () => never {
    return function (): never {
        throw onjError(
            'ONJ_UNSUPPORTED',
            'dns.promises.' + name + '() 需要 DNS 记录级查询，而这要 JNDI 的 DNS provider —— ' +
            'com.sun.jndi.dns 不在 Android 里，所以这个能力在本平台不成立。' +
            '需要解析主机名请用 dns.promises.lookup()（getaddrinfo）。'
        );
    };
}

const api = {
    lookup: lookup,
    lookupService: lookupService,
    resolve: unsupportedResolve('resolve'),
    resolve4: unsupportedResolve('resolve4'),
    resolve6: unsupportedResolve('resolve6'),
    resolveAny: unsupportedResolve('resolveAny'),
    resolveCaa: unsupportedResolve('resolveCaa'),
    resolveCname: unsupportedResolve('resolveCname'),
    resolveMx: unsupportedResolve('resolveMx'),
    resolveNaptr: unsupportedResolve('resolveNaptr'),
    resolveNs: unsupportedResolve('resolveNs'),
    resolvePtr: unsupportedResolve('resolvePtr'),
    resolveSoa: unsupportedResolve('resolveSoa'),
    resolveSrv: unsupportedResolve('resolveSrv'),
    resolveTlsa: unsupportedResolve('resolveTlsa'),
    resolveTxt: unsupportedResolve('resolveTxt'),
    reverse: unsupportedResolve('reverse'),
    getServers: getServers,
    setServers: setServers,
    getDefaultResultOrder: getDefaultResultOrder,
    setDefaultResultOrder: setDefaultResultOrder
};

export = api;
