'use strict';

/**
 * http 模块（**只有客户端**）。
 *
 * 建在宿主的 `toolCall('http_request')` 之上，而不是裸 socket ——
 * 理由见 lib/http-driver.ts：那是一个走用户审批的工具，另起一套会绕过权限模型。
 *
 * 覆盖：request / get、ClientRequest（Writable，可 setHeader 后 end）、
 * IncomingMessage（Readable，带 statusCode / headers / rawHeaders）、
 * STATUS_CODES、METHODS、Agent（无连接池）。
 *
 * 不覆盖：
 *   - createServer / Server —— 沙箱里没有可监听的 socket，构造时显式抛 ONJ_UNSUPPORTED；
 *   - 请求体只能给文本（宿主工具的参数是字符串），二进制上行不做；
 *   - abort() 只发出 'abort' 事件，无法真正取消已经在宿主里跑着的请求（工具调用没有取消通道）；
 *   - 没有连接池 / keep-alive / HTTP/2。
 */

import streamModule = require('./stream');
import { Buffer } from './buffer';
import { onjError } from './lib/errors';
import * as httpDriver from './lib/http-driver';
import type { RequestOptions } from './lib/http-types';

function toAbsoluteUrl(input: string | RequestOptions, fallbackProtocol: string): string {
    if (typeof input === 'string') {
        return input;
    }
    if (typeof input.href === 'string' && input.href.length > 0) {
        return input.href;
    }
    const protocol = typeof input.protocol === 'string' && input.protocol.length > 0
        ? input.protocol
        : fallbackProtocol;
    const withColon = protocol.charAt(protocol.length - 1) === ':' ? protocol : protocol + ':';
    let host = '';
    if (typeof input.host === 'string' && input.host.length > 0) {
        host = input.host;
    } else {
        host = typeof input.hostname === 'string' ? input.hostname : '';
        if (input.port !== undefined && input.port !== null && String(input.port) !== '') {
            host += ':' + String(input.port);
        }
    }
    const auth = typeof input.auth === 'string' && input.auth.length > 0 ? input.auth + '@' : '';
    const path = typeof input.path === 'string' && input.path.length > 0 ? input.path : '/';
    return withColon + '//' + auth + host + path;
}

class IncomingMessage extends streamModule.Readable {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    rawHeaders: string[];
    httpVersion = '1.1';
    httpVersionMajor = 1;
    httpVersionMinor = 1;
    complete = true;
    url: string;
    method: string | null = null;
    aborted = false;

    constructor(response: httpDriver.HttpHostResponse) {
        super();
        this.statusCode = response.statusCode;
        this.statusMessage = response.statusMessage;
        this.url = response.url;
        // Node 的 headers 用全小写键名
        const normalized: Record<string, string> = {};
        const raw: string[] = [];
        const names = Object.keys(response.headers);
        for (let i = 0; i < names.length; i += 1) {
            const name = names[i];
            normalized[name.toLowerCase()] = response.headers[name];
            raw.push(name, response.headers[name]);
        }
        this.headers = normalized;
        this.rawHeaders = raw;
        const body = response.contentBase64 !== null && response.contentBase64 !== ''
            ? Buffer.from(response.contentBase64, 'base64')
            : Buffer.from(response.content, 'utf8');
        if (body.length > 0) {
            this.push(body);
        }
        this.push(null);
    }

    // 数据在构造时就推完了，不需要主动拉
    override _read(size: number): void {
        void size;
    }
}

type ResponseCallback = (response: IncomingMessage) => void;

class ClientRequest extends streamModule.Writable {
    method: string;
    path: string;
    protocol: string;
    host: string;
    readonly maxHeadersCount: number | null = null;
    readonly reusedSocket = false;
    aborted = false;
    finished = false;

    // 全部公开：本文件用 `export =`，导出类带 private 成员会触发 TS4094
    readonly targetUrl: string;
    readonly headerMap: Record<string, string> = {};
    bodyChunks: Uint8Array[] = [];
    timer: unknown = null;

    constructor(input: string | RequestOptions, options?: RequestOptions | ResponseCallback, callback?: ResponseCallback) {
        super();
        let opts: RequestOptions = {};
        let done = callback;
        if (typeof options === 'function') {
            done = options;
        } else if (options !== undefined && options !== null) {
            opts = options;
        }
        const source = typeof input === 'string' ? { href: input } : input;
        this.targetUrl = toAbsoluteUrl(input, 'http:');
        this.method = (opts.method !== undefined ? opts.method : (source.method !== undefined ? source.method : 'GET')).toUpperCase();
        const path = typeof source.path === 'string' && source.path.length > 0 ? source.path : '/';
        this.path = path;
        const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(this.targetUrl);
        this.protocol = schemeMatch === null ? 'http:' : schemeMatch[1] + ':';
        this.host = typeof source.hostname === 'string' ? source.hostname : '';
        const headers = opts.headers !== undefined ? opts.headers : source.headers;
        if (headers !== undefined && headers !== null) {
            const names = Object.keys(headers);
            for (let i = 0; i < names.length; i += 1) {
                this.setHeader(names[i], headers[names[i]]);
            }
        }
        if (typeof done === 'function') {
            this.once('response', done as unknown as (...args: unknown[]) => void);
        }
    }

    setHeader(name: unknown, value: unknown): this {
        this.headerMap[String(name).toLowerCase()] = String(value);
        return this;
    }

    getHeader(name: unknown): string | undefined {
        return this.headerMap[String(name).toLowerCase()];
    }

    getHeaders(): Record<string, string> {
        return Object.assign({}, this.headerMap);
    }

    getHeaderNames(): string[] {
        return Object.keys(this.headerMap);
    }

    hasHeader(name: unknown): boolean {
        return Object.prototype.hasOwnProperty.call(this.headerMap, String(name).toLowerCase());
    }

    removeHeader(name: unknown): void {
        delete this.headerMap[String(name).toLowerCase()];
    }

    _write(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void {
        void encoding;
        this.bodyChunks.push(chunk as Uint8Array);
        callback(null);
    }

    _final(callback: (error?: Error | null) => void): void {
        this.send();
        callback(null);
    }

    send(): void {
        const self = this;
        if (this.aborted) {
            return;
        }
        let body: string | undefined;
        if (this.bodyChunks.length > 0) {
            body = Buffer.concat(this.bodyChunks).toString('utf8');
        }
        const spec: httpDriver.HttpRequestSpec = {
            url: this.targetUrl,
            method: this.method,
            headers: this.getHeaders()
        };
        if (body !== undefined) {
            spec.body = body;
        }
        this.finished = true;
        let pending: Promise<unknown>;
        try {
            pending = httpDriver.getDriver().request(spec) as Promise<unknown>;
        } catch (failure) {
            // 驱动同步抛（例如宿主没有 toolCall）也要走 'error' 事件，不能漏出去
            this.emit('error', failure);
            return;
        }
        pending.then(httpDriver.normalizeResponse).then(function (response: httpDriver.HttpHostResponse): void {
            self.clearTimer();
            self.emit('response', new IncomingMessage(response));
            self.emit('close');
        }, function (failure: unknown): void {
            self.clearTimer();
            self.emit('error', failure);
        });
    }

    clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer as number);
            this.timer = null;
        }
    }

    setTimeout(milliseconds: number, callback?: () => void): this {
        this.clearTimer();
        const self = this;
        this.timer = setTimeout(function (): void {
            self.emit('timeout');
            if (typeof callback === 'function') {
                callback();
            }
        }, milliseconds);
        return this;
    }

    /** 只能发出 'abort'：宿主的工具调用没有取消通道，已在跑的请求停不下来。 */
    abort(): void {
        if (this.aborted) {
            return;
        }
        this.aborted = true;
        this.clearTimer();
        this.emit('abort');
    }

    destroy(error?: Error): this {
        this.abort();
        if (error !== undefined) {
            this.emit('error', error);
        }
        return this;
    }
}

class Agent {
    maxSockets = Infinity;
    maxFreeSockets = 256;
    readonly sockets: Record<string, unknown[]> = {};
    readonly freeSockets: Record<string, unknown[]> = {};
    readonly requests: Record<string, unknown[]> = {};
    readonly options: Record<string, unknown> = {};
    readonly maxTotalSockets = Infinity;
    totalSocketCount = 0;

    /** 没有真实连接可销毁 —— 请求由宿主工具代发。 */
    destroy(): void {
        return;
    }
}

function request(input: string | RequestOptions, options?: RequestOptions | ResponseCallback, callback?: ResponseCallback): ClientRequest {
    return new ClientRequest(input, options, callback);
}

function get(input: string | RequestOptions, options?: RequestOptions | ResponseCallback, callback?: ResponseCallback): ClientRequest {
    const clientRequest = request(input, options, callback);
    // end() 是 applyWritable 挂到 Writable.prototype 上的，类型里没有，得转一下
    (clientRequest as unknown as { end(): void }).end();
    return clientRequest;
}

function createServer(): never {
    throw onjError(
        'ONJ_UNSUPPORTED',
        'http.createServer() 需要监听 socket，Operit 的沙箱脚本没有这个能力；' +
        '网络访问请用工具调用（toolCall("http_request") 或内建的 axios）。'
    );
}

const METHODS = [
    'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK',
    'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS',
    'PATCH', 'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT', 'REBIND', 'REPORT', 'SEARCH',
    'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE'
];

const STATUS_CODES: Record<number, string> = {
    100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
    200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
    204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status',
    208: 'Already Reported', 226: 'IM Used',
    300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
    304: 'Not Modified', 305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
    407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict',
    410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large',
    414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable',
    417: 'Expectation Failed', 418: "I'm a Teapot", 421: 'Misdirected Request',
    422: 'Unprocessable Entity', 423: 'Locked', 424: 'Failed Dependency', 425: 'Too Early',
    426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests',
    431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
    500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
    506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected',
    509: 'Bandwidth Limit Exceeded', 510: 'Not Extended', 511: 'Network Authentication Required'
};

const api = {
    request: request,
    get: get,
    createServer: createServer,
    ClientRequest: ClientRequest,
    IncomingMessage: IncomingMessage,
    Agent: Agent,
    globalAgent: new Agent(),
    METHODS: METHODS,
    STATUS_CODES: STATUS_CODES,
    maxHeaderSize: 16384
};

export = api;
