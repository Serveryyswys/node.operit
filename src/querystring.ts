'use strict';

/**
 * Node querystring 模块的移植。
 *
 * 与 URI 编码有关的两处 Node 特性必须照搬，否则三方库看到的串会不一样：
 *   - escape() 在 encodeURIComponent 之上额外转义 ! ' ( ) *
 *   - unescape()/parse() 是**宽松**解码：非法 % 序列原样保留，不抛 URIError
 * 另外 parse() 会把 '+' 当空格，而 unescape() 不会 —— 这是 Node 的既有不对称。
 */

import * as bytesCodec from './lib/bytes';

const CHAR_PERCENT = 37;
const CHAR_PLUS = 43;
const CHAR_SPACE = 32;

/** 与 Node 一致：querystring.escape 就是 encodeURIComponent（不额外转义 ! ' ( ) *）。 */
export function escape(value: unknown): string {
    return encodeURIComponent(String(value));
}

export function unescape(value: unknown): string {
    return decodeComponent(String(value), false);
}

function charCodeHex(code: number): string {
    const digits = '0123456789ABCDEF';
    return digits.charAt((code >> 4) & 15) + digits.charAt(code & 15);
}

function hexValue(code: number): number {
    if (code >= 48 && code <= 57) {
        return code - 48;
    }
    if (code >= 97 && code <= 102) {
        return code - 87;
    }
    if (code >= 65 && code <= 70) {
        return code - 55;
    }
    return -1;
}

/** 宽松百分号解码：连续的 %XX 汇总成字节后按 UTF-8 解释，非法序列原样保留。 */
function decodeComponent(text: string, decodeSpaces: boolean): string {
    let result = '';
    let i = 0;
    const length = text.length;
    while (i < length) {
        const code = text.charCodeAt(i);
        if (code === CHAR_PERCENT && i + 3 <= length) {
            const bytes: number[] = [];
            while (i + 3 <= length && text.charCodeAt(i) === CHAR_PERCENT) {
                const high = hexValue(text.charCodeAt(i + 1));
                const low = hexValue(text.charCodeAt(i + 2));
                if (high < 0 || low < 0) {
                    break;
                }
                bytes.push((high << 4) | low);
                i += 3;
            }
            if (bytes.length === 0) {
                result += '%';
                i += 1;
                continue;
            }
            result += bytesCodec.utf8Decode(new Uint8Array(bytes));
            continue;
        }
        if (code === CHAR_PLUS && decodeSpaces) {
            result += ' ';
            i += 1;
            continue;
        }
        result += text.charAt(i);
        i += 1;
    }
    return result;
}

function stringifyPrimitive(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' && isFinite(value)) {
        return String(value);
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    return '';
}

interface StringifyOptions {
    encodeURIComponent?: (value: string) => string;
}

export function stringify(value: unknown, separator?: string, equals?: string, options?: StringifyOptions): string {
    const sep = separator === undefined || separator === '' ? '&' : separator;
    const eq = equals === undefined || equals === '' ? '=' : equals;
    const encode = options !== undefined && typeof options.encodeURIComponent === 'function'
        ? options.encodeURIComponent
        : escape;
    if (value === null || typeof value !== 'object') {
        return '';
    }
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    let fields = '';
    for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const raw = source[key];
        const prefix = encode(stringifyPrimitive(key)) + eq;
        if (Array.isArray(raw)) {
            for (let j = 0; j < raw.length; j += 1) {
                if (fields.length > 0) {
                    fields += sep;
                }
                fields += prefix + encode(stringifyPrimitive(raw[j]));
            }
        } else {
            if (fields.length > 0) {
                fields += sep;
            }
            fields += prefix + encode(stringifyPrimitive(raw));
        }
    }
    return fields;
}

interface ParseOptions {
    maxKeys?: number;
    decodeURIComponent?: (value: string) => string;
}

export function parse(
    text: unknown,
    separator?: string,
    equals?: string,
    options?: ParseOptions
): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
    if (typeof text !== 'string' || text.length === 0) {
        return result;
    }
    const sep = separator === undefined || separator === '' ? '&' : separator;
    const eq = equals === undefined || equals === '' ? '=' : equals;
    const decode = options !== undefined && typeof options.decodeURIComponent === 'function'
        ? options.decodeURIComponent
        : function (value: string): string {
            return decodeComponent(value, true);
        };
    const maxKeys = options !== undefined && typeof options.maxKeys === 'number' && options.maxKeys >= 0
        ? options.maxKeys
        : 1000;

    const pairs = text.split(sep);
    let count = 0;
    for (let i = 0; i < pairs.length; i += 1) {
        if (maxKeys > 0 && count >= maxKeys) {
            break;
        }
        // 空分段也占用 maxKeys 预算（Node: parse('&a=1', '&', '=', {maxKeys:1}) === {}）
        count += 1;
        const pair = pairs[i];
        if (pair.length === 0) {
            continue;
        }
        const index = pair.indexOf(eq);
        let key: string;
        let value: string;
        if (index >= 0) {
            key = decode(pair.slice(0, index));
            value = decode(pair.slice(index + eq.length));
        } else {
            key = decode(pair);
            value = '';
        }
        const existing = result[key];
        if (existing === undefined) {
            result[key] = value;
        } else if (Array.isArray(existing)) {
            existing.push(value);
        } else {
            result[key] = [existing, value];
        }
    }
    return result;
}

export const encode = stringify;
export const decode = parse;
