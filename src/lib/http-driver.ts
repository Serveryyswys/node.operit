'use strict';

/**
 * http / https 的宿主驱动层：把"请求怎么发出去"收敛在一处，便于测试注入。
 *
 * 关键设计决定：**不直接用 Java 的 socket / HttpURLConnection**，而是走宿主的
 * `toolCall('http_request', ...)` 工具。
 *
 * 原因：`http_request` 是 Operit 注册的工具（ToolRegistration.kt:1967），
 * 走用户的工具审批流程。用裸 socket 另起一套相当于绕过那个模型。
 * 建在工具之上则既满足 Node 的 API，又不改变权限语义。
 *
 * 宿主返回的形状取自 HttpResponseData（ToolResultDataClasses.kt:600）：
 *   { url, statusCode, statusMessage, headers, contentType, content, contentBase64, size, cookies }
 * 而 toolCall 会把 ToolResult 拆包，直接给出 data 本身。
 */

interface ToolCallFunction {
    (name: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface HttpRequestSpec {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

export interface HttpHostResponse {
    url: string;
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    contentType: string;
    content: string;
    contentBase64: string | null;
    size: number;
}

export interface HttpDriver {
    /** 返回的是**未校验**的宿主返回值，交给 normalizeResponse 校验成 HttpHostResponse。 */
    request(spec: HttpRequestSpec): Promise<unknown>;
}

let driver: HttpDriver | null = null;

/** 宿主注入点：桌面测试用，传 null 恢复为走 toolCall 的默认实现。 */
export function setDriver(next: HttpDriver | null): void {
    driver = next;
}

function hostToolCall(): ToolCallFunction {
    const global = globalThis as unknown as { toolCall?: ToolCallFunction };
    if (typeof global.toolCall !== 'function') {
        throw new Error('node.operit: 宿主没有提供 toolCall，http 请求无法发出。');
    }
    return global.toolCall;
}

/**
 * 把宿主返回的对象校验成 HttpHostResponse；形状不对就明确报错，不做静默兜底。
 *
 * 这一步必须对**所有**驱动都跑（包括测试注入的），所以由 http.ts 在 send() 里调用，
 * 而不是只放在默认驱动里 —— 否则注入的驱动会绕开校验。
 */
export function normalizeResponse(raw: unknown): HttpHostResponse {
    if (raw === null || typeof raw !== 'object') {
        throw new Error('node.operit: http_request 的返回值不是对象，无法解释为 HTTP 响应。');
    }
    const value = raw as Record<string, unknown>;
    if (typeof value.statusCode !== 'number') {
        throw new Error('node.operit: http_request 的返回值缺少 statusCode 字段。');
    }
    const headers: Record<string, string> = {};
    if (value.headers !== null && typeof value.headers === 'object') {
        const source = value.headers as Record<string, unknown>;
        for (const key of Object.keys(source)) {
            headers[key] = String(source[key]);
        }
    }
    return {
        url: typeof value.url === 'string' ? value.url : '',
        statusCode: value.statusCode,
        statusMessage: typeof value.statusMessage === 'string' ? value.statusMessage : '',
        headers: headers,
        contentType: typeof value.contentType === 'string' ? value.contentType : '',
        content: typeof value.content === 'string' ? value.content : '',
        contentBase64: typeof value.contentBase64 === 'string' ? value.contentBase64 : null,
        size: typeof value.size === 'number' ? value.size : 0
    };
}

function createHostDriver(): HttpDriver {
    return {
        request(spec: HttpRequestSpec): Promise<unknown> {
            const params: Record<string, unknown> = {
                url: spec.url,
                method: spec.method
            };
            if (Object.keys(spec.headers).length > 0) {
                params.headers = JSON.stringify(spec.headers);
            }
            if (spec.body !== undefined) {
                params.body = spec.body;
            }
            return hostToolCall()('http_request', params) as Promise<unknown>;
        }
    };
}

export function getDriver(): HttpDriver {
    if (driver === null) {
        driver = createHostDriver();
    }
    return driver;
}
