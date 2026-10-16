'use strict';

/**
 * Node util 模块的移植。
 *
 * 重点在两处：
 *   - format()：%s/%d/%i/%f/%j/%o/%O/%c 与"多余参数按 inspect 追加"的规则照搬
 *   - TextEncoder / TextDecoder：QuickJS 不保证提供，这里用 lib/bytes 自实现
 *
 * inspect 只对齐常用形态（原始值、扁平对象/数组、Map/Set/Date/RegExp/Error/Buffer、循环引用），
 * Node 那套 compact / breakLength 折行算法没有照搬，见 BUILTINS.json 的 partial 说明。
 */

import * as bytesCodec from './lib/bytes';
import { ERRNO } from './lib/errors';
import { isDeepStrictEqual as sharedIsDeepStrictEqual } from './lib/deep-equal';

const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');

import { InspectOptions } from './lib/util-types';

const DEFAULT_DEPTH = 2;

function quoteString(value: string, maxLength?: number | null): string {
    let text = value;
    const truncated = maxLength !== undefined && maxLength !== null && text.length > maxLength;
    if (truncated && maxLength !== undefined && maxLength !== null) {
        text = text.slice(0, maxLength);
    }
    let out = "'";
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code === 39) {
            out += "\\'";
        } else if (code === 92) {
            out += '\\\\';
        } else if (code === 10) {
            out += '\\n';
        } else if (code === 13) {
            out += '\\r';
        } else if (code === 9) {
            out += '\\t';
        } else if (code < 32) {
            out += '\\x' + pad2(code.toString(16));
        } else {
            out += text.charAt(i);
        }
    }
    out += "'";
    if (truncated && maxLength !== undefined && maxLength !== null) {
        out = out.slice(0, out.length - 1) + "... " + (value.length - maxLength) + ' more characters' + "'";
    }
    return out;
}

function pad2(value: string): string {
    return value.length >= 2 ? value : '0' + value;
}

function functionLabel(value: Function): string {
    const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : '';
    const kind = /^class[\s{]/.test(Function.prototype.toString.call(value)) ? 'class' : 'Function';
    return name.length > 0 ? '[Function: ' + name + ']' : '[Function (anonymous)]';
}

function inspectValue(value: unknown, options: InspectOptions, depth: number, seen: unknown[]): string {
    const maxDepth = options.depth === null || options.depth === undefined ? DEFAULT_DEPTH : options.depth;
    if (value === null) {
        return 'null';
    }
    switch (typeof value) {
        case 'undefined':
            return 'undefined';
        case 'boolean':
            return value ? 'true' : 'false';
        case 'number':
            if (Number.isNaN(value)) {
                return 'NaN';
            }
            if (value === Infinity) {
                return 'Infinity';
            }
            if (value === -Infinity) {
                return '-Infinity';
            }
            return Object.is(value, -0) ? '-0' : String(value);
        case 'bigint':
            return String(value) + 'n';
        case 'symbol':
            return value.toString();
        case 'string':
            return quoteString(value, options.maxStringLength);
        case 'function':
            return functionLabel(value as Function);
        default:
            break;
    }

    const object = value as Record<string, unknown>;
    const custom = object[inspectCustom as unknown as string];
    if (typeof custom === 'function') {
        return String((custom as (this: unknown) => unknown).call(object));
    }

    if (seen.indexOf(object) >= 0) {
        return '[Circular]';
    }
    if (maxDepth >= 0 && depth > maxDepth) {
        return Array.isArray(object) ? '[Array]' : '[Object]';
    }

    seen.push(object);
    try {
        if (object instanceof Date) {
            return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
        }
        if (object instanceof RegExp) {
            return object.toString();
        }
        if (object instanceof Error) {
            return object.stack !== undefined && typeof object.stack === 'string'
                ? object.stack
                : object.name + ': ' + object.message;
        }
        if (object instanceof Uint8Array) {
            const limit = Math.min(object.length, 50);
            let out = '<Buffer';
            for (let i = 0; i < limit; i += 1) {
                out += ' ' + pad2(object[i].toString(16));
            }
            if (object.length > limit) {
                out += ' ... ' + (object.length - limit) + ' more bytes';
            }
            return out + '>';
        }
        if (object instanceof Map) {
            const parts: string[] = [];
            object.forEach(function (entryValue: unknown, entryKey: unknown): void {
                parts.push(inspectValue(entryKey, options, depth + 1, seen) + ' => ' + inspectValue(entryValue, options, depth + 1, seen));
            });
            return formatCollection('Map(' + object.size + ') ', parts, options, depth, '{}');
        }
        if (object instanceof Set) {
            const parts: string[] = [];
            object.forEach(function (entryValue: unknown): void {
                parts.push(inspectValue(entryValue, options, depth + 1, seen));
            });
            return formatCollection('Set(' + object.size + ') ', parts, options, depth, '{}');
        }
        if (Array.isArray(object)) {
            const limit = options.maxArrayLength === undefined ? object.length : Math.min(object.length, options.maxArrayLength);
            const parts: string[] = [];
            for (let i = 0; i < limit; i += 1) {
                parts.push(inspectValue(object[i], options, depth + 1, seen));
            }
            if (limit < object.length) {
                parts.push('... ' + (object.length - limit) + ' more items');
            }
            return formatCollection('', parts, options, depth, '[]');
        }
        const keys = Object.keys(object);
        if (options.sorted === true) {
            keys.sort();
        }
        const parts: string[] = [];
        for (let i = 0; i < keys.length; i += 1) {
            const key = keys[i];
            parts.push(formatKey(key) + ': ' + inspectValue(object[key], options, depth + 1, seen));
        }
        return formatCollection('', parts, options, depth, '{}');
    } finally {
        seen.pop();
    }
}

/**
 * 集合的统一排版。
 * compact === false 时强制多行（Node 的 inspect 也是这个开关），
 * 缩进按递归深度算，所以嵌套时每层多缩进两格。
 */
function formatCollection(head: string, parts: string[], options: InspectOptions, depth: number, brackets: string): string {
    const open = brackets.charAt(0);
    const close = brackets.charAt(1);
    if (parts.length === 0) {
        return head + open + close;
    }
    if (options.compact === false) {
        const inner = '  '.repeat(depth + 1);
        const outer = '  '.repeat(depth);
        return head + open + '\n' + inner + parts.join(',\n' + inner) + '\n' + outer + close;
    }
    return head + open + ' ' + parts.join(', ') + ' ' + close;
}

function formatKey(key: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quoteString(key);
}

function inspect(value: unknown, options?: InspectOptions | boolean | number): string {
    let normalized: InspectOptions = {};
    if (typeof options === 'boolean') {
        normalized = { colors: options };
    } else if (typeof options === 'number') {
        normalized = { depth: options };
    } else if (options !== null && typeof options === 'object') {
        normalized = options;
    }
    return inspectValue(value, normalized, 0, []);
}

(inspect as unknown as { custom?: unknown }).custom = inspectCustom;

function jsonOf(value: unknown): string {
    try {
        const encoded = JSON.stringify(value);
        return encoded === undefined ? 'undefined' : encoded;
    } catch (failure) {
        return '[Circular]';
    }
}

function formatWithOptions(options: InspectOptions, template?: unknown, ...rest: unknown[]): string {
    // Node 的 util.format() / util.formatWithOptions({}) 在**没有要格式化的值**时返回空串，
    // 而不是字符串 'undefined'。两者必须区分开 —— 否则 console.log() 会多打印一个 "undefined"
    // （console 与 Node 的逐字节对拍抓到了这一条）。
    if (arguments.length <= 1) {
        return '';
    }
    const args: unknown[] = [template].concat(rest);
    const first = args[0];
    const inspectOptions: InspectOptions = options === undefined || options === null ? {} : options;
    if (typeof first !== 'string') {
        return args.map(function (value: unknown): string {
            return typeof value === 'string' ? value : inspectValue(value, inspectOptions, 0, []);
        }).join(' ');
    }
    if (args.length === 1) {
        return first;
    }
    let out = '';
    let lastPosition = 0;
    let consumed = 0;
    for (let i = 0; i < first.length; i += 1) {
        if (first.charCodeAt(i) !== 37) {
            continue;
        }
        let replacement: string | null = null;
        const specifier = first.charCodeAt(i + 1);
        if (specifier === 37) {
            // %%
            replacement = '%';
        } else if (consumed + 1 >= args.length) {
            // 参数不足时占位符原样保留（Node: format('%s %s', 'a') === 'a %s'）
            continue;
        } else {
            switch (specifier) {
                case 115:
                    replacement = String(args[++consumed]);
                    break;
                case 100:
                    replacement = String(Number(args[++consumed]));
                    break;
                case 105:
                    replacement = String(parseInt(String(args[++consumed]), 10));
                    break;
                case 102:
                    replacement = String(parseFloat(String(args[++consumed])));
                    break;
                case 106:
                    replacement = jsonOf(args[++consumed]);
                    break;
                case 111:
                    replacement = inspectValue(args[++consumed], { showHidden: true, showProxy: true, depth: 4, colors: inspectOptions.colors }, 0, []);
                    break;
                case 79:
                    replacement = inspectValue(args[++consumed], inspectOptions, 0, []);
                    break;
                case 99:
                    // %c 是 CSS 占位符：消费参数但输出空串
                    consumed += 1;
                    replacement = '';
                    break;
                default:
                    continue;
            }
        }
        if (i > lastPosition) {
            out += first.slice(lastPosition, i);
        }
        out += replacement;
        i += 1;
        lastPosition = i + 1;
    }
    if (lastPosition < first.length) {
        out += first.slice(lastPosition);
    }
    for (let index = consumed + 1; index < args.length; index += 1) {
        const extra = args[index];
        // 多余参数：字符串按原样追加，其余走 inspect
        out += ' ' + (typeof extra === 'string' ? extra : inspectValue(extra, inspectOptions, 0, []));
    }
    return out;
}

function format(template?: unknown, ...rest: unknown[]): string {
    // 必须在**这一层**判断参数个数：下面那次调用永远会给 formatWithOptions 传两个实参
    // （options 和显式的 template），所以那边无法区分"没传值"和"传了 undefined"。
    // Node：util.format() === ''，util.format(undefined) === 'undefined'。
    if (arguments.length === 0) {
        return '';
    }
    return formatWithOptions({}, template, ...rest);
}

function inherits(constructor: Function, superConstructor: Function): void {
    if (constructor === undefined || constructor === null) {
        throw new TypeError('The "constructor" argument must be a function.');
    }
    if (superConstructor === undefined || superConstructor === null) {
        throw new TypeError('The "superConstructor" argument must be a function.');
    }
    Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
    Object.setPrototypeOf(constructor, superConstructor);
    (constructor as Function & { super_?: Function }).super_ = superConstructor;
}

function promisify(original: Function): Function {
    if (typeof original !== 'function') {
        throw new TypeError('The "original" argument must be of type function.');
    }
    const custom = (original as Function & Record<symbol, unknown>)[promisifyCustom];
    if (custom !== undefined) {
        return custom as Function;
    }
    function fn(this: unknown, ...args: unknown[]): Promise<unknown> {
        const self = this;
        return new Promise(function (resolve, reject): void {
            args.push(function (error: unknown, value: unknown): void {
                if (error !== null && error !== undefined) {
                    reject(error);
                } else {
                    resolve(value);
                }
            });
            original.apply(self, args);
        });
    }
    Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
    Object.defineProperty(fn, promisifyCustom, { value: custom, configurable: true });
    return fn;
}

(promisify as unknown as { custom?: unknown }).custom = promisifyCustom;

function callbackify(original: Function): Function {
    if (typeof original !== 'function') {
        throw new TypeError('The "original" argument must be of type function.');
    }
    return function (this: unknown, ...args: unknown[]): void {
        const callback = args.pop();
        if (typeof callback !== 'function') {
            throw new TypeError('The last argument must be of type function.');
        }
        const runner = callback as (error: unknown, value?: unknown) => void;
        (original.apply(this, args) as Promise<unknown>).then(
            function (value: unknown): void {
                queueMicrotask(function (): void {
                    runner(null, value);
                });
            },
            function (error: unknown): void {
                queueMicrotask(function (): void {
                    runner(error);
                });
            }
        );
    };
}

function deprecate(fn: Function, message: string): Function {
    let warned = false;
    return function (this: unknown, ...args: unknown[]): unknown {
        if (!warned) {
            warned = true;
            const target = (fn as Function & { name?: string }).name;
            console.warn('DeprecationWarning: ' + message + (target !== undefined ? ' [' + target + ']' : ''));
        }
        return fn.apply(this, args);
    };
}

function debuglog(section: string): Function & { enabled: boolean } {
    void section;
    const logger = function (): void {
        // Node 只在 NODE_DEBUG 命中时输出；这里没有环境变量通道，默认静默。
    } as unknown as Function & { enabled: boolean };
    logger.enabled = false;
    return logger;
}

function getSystemErrorName(errno: number): string {
    const names = Object.keys(ERRNO);
    for (let i = 0; i < names.length; i += 1) {
        if (ERRNO[names[i]] === errno) {
            return names[i];
        }
    }
    return 'Unknown system error ' + errno;
}

function stripVTControlCharacters(value: string): string {
    return String(value).replace(/\u001b\[[0-9;]*m/g, '');
}

const types = {
    isDate: function (value: unknown): boolean {
        return value instanceof Date;
    },
    isRegExp: function (value: unknown): boolean {
        return value instanceof RegExp;
    },
    isArray: function (value: unknown): boolean {
        return Array.isArray(value);
    },
    isTypedArray: function (value: unknown): boolean {
        return value instanceof Uint8Array || value instanceof Int8Array ||
            value instanceof Uint16Array || value instanceof Int16Array ||
            value instanceof Uint32Array || value instanceof Int32Array ||
            value instanceof Float32Array || value instanceof Float64Array;
    },
    isUint8Array: function (value: unknown): boolean {
        return value instanceof Uint8Array;
    },
    isArrayBuffer: function (value: unknown): boolean {
        return value instanceof ArrayBuffer;
    },
    isPromise: function (value: unknown): boolean {
        return value !== null && typeof value === 'object' &&
            typeof (value as { then?: unknown }).then === 'function';
    },
    isNativeError: function (value: unknown): boolean {
        return value instanceof Error;
    },
    isMap: function (value: unknown): boolean {
        return value instanceof Map;
    },
    isSet: function (value: unknown): boolean {
        return value instanceof Set;
    },
    isBigInt64Array: function (value: unknown): boolean {
        return typeof BigInt64Array !== 'undefined' && value instanceof BigInt64Array;
    },
    isAsyncFunction: function (value: unknown): boolean {
        return typeof value === 'function' && (value as { constructor?: { name?: string } }).constructor !== undefined &&
            (value as { constructor: { name?: string } }).constructor.name === 'AsyncFunction';
    },
    isGeneratorFunction: function (value: unknown): boolean {
        return typeof value === 'function' && (value as { constructor?: { name?: string } }).constructor !== undefined &&
            (value as { constructor: { name?: string } }).constructor.name === 'GeneratorFunction';
    }
};

function isDeepStrictEqual(left: unknown, right: unknown): boolean {
    return sharedIsDeepStrictEqual(left, right);
}

class TextEncoder {
    readonly encoding = 'utf-8';

    encode(input?: string): Uint8Array {
        return bytesCodec.utf8Encode(input === undefined ? '' : String(input));
    }

    encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
        const encoded = bytesCodec.utf8Encode(String(source));
        const writable = Math.min(encoded.length, destination.length);
        destination.set(encoded.subarray(0, writable));
        return { read: writable === encoded.length ? source.length : source.length, written: writable };
    }
}

class TextDecoder {
    readonly encoding: string;
    readonly fatal: boolean;
    readonly ignoreBOM: boolean;

    constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) {
        const normalized = (label === undefined ? 'utf-8' : String(label)).toLowerCase();
        if (normalized !== 'utf-8' && normalized !== 'utf8') {
            throw new RangeError('node.operit 的 TextDecoder 只支持 utf-8，收到 ' + normalized);
        }
        this.encoding = 'utf-8';
        this.fatal = options !== undefined && options.fatal === true;
        this.ignoreBOM = options !== undefined && options.ignoreBOM === true;
    }

    decode(input?: Uint8Array): string {
        if (input === undefined) {
            return '';
        }
        return bytesCodec.utf8Decode(input);
    }
}

const util = {
    format: format,
    formatWithOptions: formatWithOptions,
    inspect: inspect,
    inherits: inherits,
    promisify: promisify,
    callbackify: callbackify,
    deprecate: deprecate,
    debuglog: debuglog,
    getSystemErrorName: getSystemErrorName,
    stripVTControlCharacters: stripVTControlCharacters,
    isDeepStrictEqual: isDeepStrictEqual,
    types: types,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder
};

export = util;
