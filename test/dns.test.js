'use strict';

/**
 * dns 契约测试。
 *
 * 用 mock 驱动：测试不该依赖网络，而且要断言"交给宿主的查询是什么"。
 * 错误字段（code / errno / syscall / hostname）用的是实测 Node 的值，写死在这里。
 *
 * resolve 一族在 Android 上不成立（JNDI 没有 DNS provider），断言它们**显式抛错**，
 * 而不是静默给空结果。
 */

var nodeDns = require('dns');
var h = require('./harness.js');
var myDns = require('../dist/dns.js');
var myDnsPromises = require('../dist/dns/promises.js');
var dnsDriver = require('../dist/lib/dns-driver.js');

var RECORDS = [
    { address: '::1', family: 6 },
    { address: '127.0.0.1', family: 4 }
];

function createMock(handler) {
    var calls = [];
    return {
        calls: calls,
        lookup: function (hostname) {
            calls.push(hostname);
            return handler(hostname);
        },
        canonicalNameOf: function (address) {
            calls.push(address);
            return 'mock-host';
        }
    };
}

function lookupAsync(hostname, options) {
    return new Promise(function (resolve) {
        var callback = function (error, address, family) {
            resolve({ error: error, address: address, family: family });
        };
        if (options === undefined) {
            myDns.lookup(hostname, callback);
        } else {
            myDns.lookup(hostname, options, callback);
        }
    });
}

async function run() {
    dnsDriver.setDriver(createMock(function () { return RECORDS.slice(); }));

    h.section('dns.lookup');
    var first = await lookupAsync('example.test');
    h.equal(first.error, null, '成功时 error 为 null');
    h.equal(first.address, '::1', 'verbatim 顺序下先给 ::1');
    h.equal(first.family, 6, 'family 为 6');

    var all = await lookupAsync('example.test', { all: true });
    h.deepEqual(all.address, RECORDS, 'all: true 返回数组');
    h.equal(all.family, undefined, 'all: true 时没有第二个参数');

    var v4 = await lookupAsync('example.test', 4);
    h.deepEqual(v4.address, '127.0.0.1', 'family 4 只留 IPv4');
    h.equal(v4.family, 4, 'family 4');

    var v6 = await lookupAsync('example.test', { family: 6 });
    h.deepEqual(v6.address, '::1', 'family 6 只留 IPv6');

    var ipv4First = await lookupAsync('example.test', { verbatim: false, all: true });
    h.deepEqual(ipv4First.address.map(function (r) { return r.address; }), ['127.0.0.1', '::1'], 'verbatim:false 时 IPv4 在前');

    var filteredOut = await lookupAsync('example.test', 6);
    dnsDriver.setDriver(createMock(function () { return [{ address: '127.0.0.1', family: 4 }]; }));
    var none = await lookupAsync('example.test', 6);
    h.equal(none.error !== null && none.error.code, 'ENOTFOUND', '过滤后为空时报 ENOTFOUND');

    h.section('dns.lookup 的错误形状（对齐实测的 Node 值）');
    dnsDriver.setDriver(createMock(function () { throw new Error('boom'); }));
    var missing = await lookupAsync('nope.test');
    h.equal(missing.error.code, 'ENOTFOUND', 'code');
    h.equal(missing.error.errno, -3008, 'errno（实测 Node 就是 -3008）');
    h.equal(missing.error.syscall, 'getaddrinfo', 'syscall');
    h.equal(missing.error.hostname, 'nope.test', 'hostname');
    h.equal(missing.error.message, 'getaddrinfo ENOTFOUND nope.test', 'message 文案');

    h.section('dns.lookupService');
    dnsDriver.setDriver(createMock(function () { return RECORDS.slice(); }));
    var service = await new Promise(function (resolve) {
        myDns.lookupService('127.0.0.1', 80, function (error, hostname, name) {
            resolve({ error: error, hostname: hostname, service: name });
        });
    });
    h.equal(service.error, null, 'lookupService 成功');
    h.equal(service.hostname, 'mock-host', 'hostname');
    h.equal(service.service, 'http', '80 -> http（Node 的 getnameinfo 也这么给）');
    var unknownPort = await new Promise(function (resolve) {
        myDns.lookupService('127.0.0.1', 12345, function (error, hostname, name) { resolve(name); });
    });
    h.equal(unknownPort, '12345', '未收录的端口给端口号字符串');

    h.section('dns.promises');
    var promised = await myDnsPromises.lookup('example.test');
    h.deepEqual(promised, { address: '::1', family: 6 }, 'promises.lookup 给 {address, family}');
    var promisedAll = await myDnsPromises.lookup('example.test', { all: true });
    h.deepEqual(promisedAll, RECORDS, 'promises.lookup(all) 给数组');
    var promisedService = await myDnsPromises.lookupService('127.0.0.1', 443);
    h.deepEqual(promisedService, { hostname: 'mock-host', service: 'https' }, 'promises.lookupService');
    dnsDriver.setDriver(createMock(function () { throw new Error('boom'); }));
    var promisedError = await myDnsPromises.lookup('nope.test').then(function () { return null; }, function (e) { return e; });
    h.equal(promisedError !== null && promisedError.code, 'ENOTFOUND', 'promises.lookup 失败时拒绝');
    dnsDriver.setDriver(createMock(function () { return RECORDS.slice(); }));
    h.equal(myDns.promises === myDnsPromises, true, 'dns.promises 与子路径是同一对象');

    h.section('getServers / 结果顺序');
    h.deepEqual(myDns.getServers(), [], 'getServers 返回空数组（Android 读不到解析器配置）');
    h.equal(myDns.getDefaultResultOrder(), nodeDns.getDefaultResultOrder(), 'getDefaultResultOrder 与 Node 一致');
    myDns.setDefaultResultOrder('ipv4first');
    h.equal(myDns.getDefaultResultOrder(), 'ipv4first', 'setDefaultResultOrder 生效');
    var orderedByDefault = await lookupAsync('example.test');
    h.equal(orderedByDefault.address, '127.0.0.1', 'ipv4first 下缺省先给 IPv4');
    myDns.setDefaultResultOrder('verbatim');
    var invalidOrder = null;
    try { myDns.setDefaultResultOrder('bogus'); } catch (e) { invalidOrder = e; }
    h.equal(invalidOrder instanceof TypeError, true, '非法顺序抛 TypeError');

    h.section('常量与 Node 逐项比对');
    var constantKeys = ['ADDRCONFIG', 'V4MAPPED', 'ALL', 'NODATA', 'FORMERR', 'SERVFAIL', 'NOTFOUND',
        'NOTIMP', 'REFUSED', 'BADQUERY', 'BADNAME', 'BADFAMILY', 'BADRESP', 'CONNREFUSED', 'TIMEOUT',
        'EOF', 'FILE', 'NOMEM', 'DESTRUCTION', 'BADSTR', 'BADFLAGS', 'NONAME', 'BADHINTS',
        'NOTINITIALIZED', 'LOADIPHLPAPI', 'ADDRGETNETWORKPARAMS', 'CANCELLED'];
    var wrong = [];
    constantKeys.forEach(function (key) {
        if (myDns[key] !== nodeDns[key]) {
            wrong.push(key + ' 本库 ' + JSON.stringify(myDns[key]) + ' Node ' + JSON.stringify(nodeDns[key]));
        }
    });
    h.deepEqual(wrong, [], 'dns 常量与 Node 一致');

    h.section('平台不成立的能力：显式拒绝');
    var unsupported = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
        'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];
    var notThrown = [];
    unsupported.forEach(function (name) {
        var failure = null;
        try { myDns[name]('example.com', function () { /* 不应被调用 */ }); } catch (e) { failure = e; }
        if (failure === null || failure.code !== 'ONJ_UNSUPPORTED') {
            notThrown.push(name);
        }
    });
    h.deepEqual(notThrown, [], 'dns.resolve* / reverse 全部显式抛 ONJ_UNSUPPORTED');
    var promisedNotThrown = [];
    ['resolve4', 'resolveMx', 'reverse'].forEach(function (name) {
        var failure = null;
        try { myDnsPromises[name]('example.com'); } catch (e) { failure = e; }
        if (failure === null || failure.code !== 'ONJ_UNSUPPORTED') {
            promisedNotThrown.push(name);
        }
    });
    h.deepEqual(promisedNotThrown, [], 'dns.promises.resolve* 同样显式抛');
    var setServersError = null;
    try { myDns.setServers(['8.8.8.8']); } catch (e) { setServersError = e; }
    h.equal(setServersError !== null && setServersError.code === 'ONJ_UNSUPPORTED', true, 'setServers 显式抛');
    var resolverError = null;
    try { new myDns.Resolver(); } catch (e) { resolverError = e; }
    h.equal(resolverError !== null && resolverError.code === 'ONJ_UNSUPPORTED', true, 'Resolver 显式抛');

    h.section('参数校验');
    var badCallback = null;
    try { myDns.lookup('example.com'); } catch (e) { badCallback = e; }
    h.equal(badCallback instanceof TypeError, true, '缺少回调抛 TypeError');

    dnsDriver.setDriver(null);
}

module.exports = { run: run };
