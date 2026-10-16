'use strict';

/**
 * http / https 契约测试。
 *
 * 用 mock 驱动而不是真发请求：
 *   - 真发请求要联网，测试不该依赖网络；
 *   - 更关键的是要断言"传给宿主 toolCall 的参数是什么" —— 那是与 Operit 工具的契约。
 *
 * 同时验证 Node 侧的 API 形状：ClientRequest 是 Writable、IncomingMessage 是 Readable、
 * 响应头全小写、非 2xx 不抛错、错误走 'error' 事件。
 */

var h = require('./harness.js');
var myHttp = require('../dist/http.js');
var myHttps = require('../dist/https.js');
var httpDriver = require('../dist/lib/http-driver.js');

function okResponse(overrides) {
    return Object.assign({
        url: 'http://example.com/',
        statusCode: 200,
        statusMessage: 'OK',
        headers: { 'Content-Type': 'text/plain', 'X-Custom': 'yes' },
        contentType: 'text/plain',
        content: 'hello body',
        contentBase64: null,
        size: 10
    }, overrides === undefined ? {} : overrides);
}

function createMock(handler) {
    var calls = [];
    return {
        calls: calls,
        request: function (spec) {
            calls.push(spec);
            var outcome = handler(spec);
            return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
        }
    };
}

function readBody(response) {
    return new Promise(function (resolve, reject) {
        var chunks = [];
        response.on('data', function (chunk) { chunks.push(Buffer.from(chunk).toString('utf8')); });
        response.on('end', function () { resolve(chunks.join('')); });
        response.on('error', reject);
    });
}

async function run() {
    h.section('http.get：请求与响应');
    var mock = createMock(function () { return okResponse(); });
    httpDriver.setDriver(mock);
    var response = await new Promise(function (resolve, reject) {
        myHttp.get('http://example.com/a?b=1', resolve).on('error', reject);
    });
    h.equal(response.statusCode, 200, 'statusCode');
    h.equal(response.statusMessage, 'OK', 'statusMessage');
    h.deepEqual(response.headers, { 'content-type': 'text/plain', 'x-custom': 'yes' }, '响应头键名全小写');
    h.deepEqual(response.rawHeaders, ['Content-Type', 'text/plain', 'X-Custom', 'yes'], 'rawHeaders 保原样');
    h.equal(await readBody(response), 'hello body', '响应体可读');
    h.equal(response instanceof myHttp.IncomingMessage, true, 'IncomingMessage 类型');
    h.deepEqual(mock.calls[0], { url: 'http://example.com/a?b=1', method: 'GET', headers: {} }, '传给宿主工具的参数');

    h.section('http.request：方法 / 头 / 请求体');
    var mock2 = createMock(function () { return okResponse({ statusCode: 201 }); });
    httpDriver.setDriver(mock2);
    var request = myHttp.request('http://example.com/post', { method: 'POST' }, function (res) {
        h.equal(res.statusCode, 201, '自定义方法得到响应');
    });
    request.setHeader('Content-Type', 'application/json');
    request.setHeader('X-Trace', 'abc');
    h.equal(request.getHeader('content-type'), 'application/json', 'getHeader 不分大小写');
    h.equal(request.hasHeader('X-TRACE'), true, 'hasHeader 不分大小写');
    h.deepEqual(request.getHeaderNames().sort(), ['content-type', 'x-trace'], 'getHeaderNames');
    request.removeHeader('X-Trace');
    h.equal(request.hasHeader('x-trace'), false, 'removeHeader');
    request.end('{"a":1}');
    await new Promise(function (resolve) { request.on('close', resolve); });
    h.deepEqual(mock2.calls[0], {
        url: 'http://example.com/post',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}'
    }, '请求体与头传给宿主工具');

    h.section('非 2xx 不抛错（与 Node 一致）');
    var mock3 = createMock(function () { return okResponse({ statusCode: 404, statusMessage: 'Not Found', content: 'nope' }); });
    httpDriver.setDriver(mock3);
    var notFound = await new Promise(function (resolve, reject) {
        myHttp.get('http://example.com/missing', resolve).on('error', reject);
    });
    h.equal(notFound.statusCode, 404, '404 照常给响应');
    h.equal(await readBody(notFound), 'nope', '404 的体也能读');

    h.section('错误传播');
    var mock4 = createMock(function () { return new Error('宿主说不行'); });
    httpDriver.setDriver(mock4);
    var error = await new Promise(function (resolve) {
        myHttp.get('http://example.com/err', function () { resolve(null); })
            .on('error', function (failure) { resolve(failure); });
    });
    h.equal(error !== null && error.message === '宿主说不行', true, '驱动拒绝时走 error 事件');

    h.section('contentBase64 优先（字节保真）');
    var mock5 = createMock(function () {
        return okResponse({ content: '不应被使用', contentBase64: Buffer.from([0x00, 0x01, 0xff]).toString('base64') });
    });
    httpDriver.setDriver(mock5);
    var binary = await new Promise(function (resolve, reject) {
        myHttp.get('http://example.com/bin', resolve).on('error', reject);
    });
    var collected = [];
    await new Promise(function (resolve) {
        binary.on('data', function (chunk) { collected.push(Buffer.from(chunk)); });
        binary.on('end', resolve);
    });
    h.deepEqual(Array.from(Buffer.concat(collected)), [0, 1, 255], 'base64 体按字节还原');

    h.section('options 形式与 https');
    var mock6 = createMock(function () { return okResponse(); });
    httpDriver.setDriver(mock6);
    await new Promise(function (resolve, reject) {
        myHttp.get({ hostname: 'example.com', port: 8080, path: '/p?q=1' }, function () { resolve(); }).on('error', reject);
    });
    h.equal(mock6.calls[0].url, 'http://example.com:8080/p?q=1', 'options 形式拼出 URL');
    await new Promise(function (resolve, reject) {
        myHttps.get({ hostname: 'secure.example', path: '/s' }, function () { resolve(); }).on('error', reject);
    });
    h.equal(mock6.calls[1].url, 'https://secure.example/s', 'https 缺省协议是 https:');
    await new Promise(function (resolve, reject) {
        myHttps.get('https://full.example/x', function () { resolve(); }).on('error', reject);
    });
    h.equal(mock6.calls[2].url, 'https://full.example/x', 'https 传完整 URL');

    h.section('abort 与 setHeader 之外的结构');
    var mock7 = createMock(function () { return okResponse(); });
    httpDriver.setDriver(mock7);
    var abortable = myHttp.request('http://example.com/slow');
    var aborted = false;
    abortable.on('abort', function () { aborted = true; });
    abortable.abort();
    h.equal(aborted, true, 'abort 发出事件');
    h.equal(abortable.aborted, true, 'aborted 标志');

    h.section('常量与未实现项');
    h.equal(myHttp.STATUS_CODES[200], 'OK', 'STATUS_CODES[200]');
    h.equal(myHttp.STATUS_CODES[404], 'Not Found', 'STATUS_CODES[404]');
    h.equal(myHttp.STATUS_CODES[500], 'Internal Server Error', 'STATUS_CODES[500]');
    h.equal(myHttp.METHODS.indexOf('GET') >= 0, true, 'METHODS 含 GET');
    h.equal(myHttp.METHODS.indexOf('PATCH') >= 0, true, 'METHODS 含 PATCH');
    h.equal(typeof myHttp.Agent, 'function', 'Agent 存在');
    h.equal(myHttp.globalAgent instanceof myHttp.Agent, true, 'globalAgent 是 Agent 实例');
    var serverError = null;
    try { myHttp.createServer(); } catch (e) { serverError = e; }
    h.equal(serverError !== null && serverError.code === 'ONJ_UNSUPPORTED', true, 'http.createServer 显式抛 ONJ_UNSUPPORTED');
    var httpsServerError = null;
    try { myHttps.createServer(); } catch (e) { httpsServerError = e; }
    h.equal(httpsServerError !== null && httpsServerError.code === 'ONJ_UNSUPPORTED', true, 'https.createServer 显式抛 ONJ_UNSUPPORTED');

    h.section('宿主返回值形状不对时明确报错');
    var mockBad = createMock(function () { return { oops: true }; });
    httpDriver.setDriver(mockBad);
    var shapeError = await new Promise(function (resolve) {
        myHttp.get('http://example.com/bad', function () { resolve(null); })
            .on('error', function (failure) { resolve(failure); });
    });
    h.equal(shapeError !== null && /statusCode/.test(shapeError.message), true, '缺少 statusCode 时报错而不是静默');

    httpDriver.setDriver(null);
}

module.exports = { run: run };
