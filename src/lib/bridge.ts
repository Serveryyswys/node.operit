'use strict';

/**
 * 唯一接触 Operit Java bridge 的地方。
 *
 * 运行时契约（types/core.d.ts）：
 *   javaCallStatic(className, methodName, argsJson) -> "{\"success\":bool,\"data\":any,\"error\":string}"
 *   javaNewInstance / javaCallInstance / javaGet|SetStatic|InstanceField 同形状
 *   javaGetApplicationContext / javaGetCurrentActivity
 *
 * 返回值经 toJsonCompatibleValue 转换：基本类型直通，数组 / Map / Iterable 递归展开，
 * 其余对象变成 { __javaHandle, __javaClass } 句柄。参数方向只接受 JSON 值。
 *
 * 本模块只做三件事：调用、解包、把 Java 异常翻成带 code 的中间态错误。
 * 它不知道 fs，也不知道路径语义 —— 那些属于上层。
 */

import { javaError, onjError, createError, type NodeStyleError } from './errors';

/** Java 侧对象在 JS 侧的表现形式。 */
export interface JavaHandle {
    __javaHandle: string;
    __javaClass: string;
}

/** 宿主后端接口：Operit 上的实现走 NativeInterface，桌面测试注入 mock。 */
export interface JavaBridgeBackend {
    classExists(className: string): boolean;
    callStatic(className: string, methodName: string, args: readonly unknown[]): unknown;
    callInstance(instance: unknown, methodName: string, args: readonly unknown[]): unknown;
    newInstance(className: string, args: readonly unknown[]): unknown;
    getStaticField(className: string, fieldName: string): unknown;
    setStaticField(className: string, fieldName: string, value: unknown): unknown;
    getInstanceField(instance: unknown, fieldName: string): unknown;
    setInstanceField(instance: unknown, fieldName: string, value: unknown): unknown;
    getApplicationContext(): unknown;
    getCurrentActivity(): unknown;
    setEnv(key: string, value: string | null): void;
}

interface BridgeEnvelope {
    success?: boolean;
    data?: unknown;
    error?: string;
    message?: string;
}

let backend: JavaBridgeBackend | null = null;

/** 宿主注入点：桌面测试与 mock 使用。传 null 恢复为自动解析 Operit 宿主。 */
export function setBackend(next: JavaBridgeBackend | null): void {
    backend = next === undefined ? null : next;
}

function getBackend(): JavaBridgeBackend {
    if (backend === null) {
        backend = createOperitBackend();
    }
    return backend;
}

function createOperitBackend(): JavaBridgeBackend {
    // 必须用 typeof 探测：宿主不存在时（例如桌面 Node、或不在工具调用上下文里跑）
    // 直接写 NativeInterface 会抛 ReferenceError，而不是本库的 ONJ_MISSING_HOST。
    const detected = typeof NativeInterface === 'undefined' ? undefined : NativeInterface;
    if (detected === undefined) {
        throw onjError('ONJ_MISSING_HOST');
    }
    const native: OperitNativeInterface = detected;

    function callNative(method: keyof OperitNativeInterface, args: readonly unknown[]): unknown {
        const fn = native[method];
        if (typeof fn !== 'function') {
            throw onjError('ONJ_MISSING_HOST', 'NativeInterface.' + String(method) + ' 不可用。');
        }
        const invoke = fn as (...inner: unknown[]) => unknown;
        return invoke.apply(native, args as unknown[]);
    }

    return {
        classExists(className: string): boolean {
            return normalizeBoolean(callNative('javaClassExists', [String(className)]));
        },
        callStatic(className: string, methodName: string, args: readonly unknown[]): unknown {
            return unwrap(
                callNative('javaCallStatic', [String(className), String(methodName), JSON.stringify(args)]),
                'javaCallStatic ' + className + '#' + methodName
            );
        },
        callInstance(instance: unknown, methodName: string, args: readonly unknown[]): unknown {
            return unwrap(
                callNative('javaCallInstance', [handleOf(instance), String(methodName), JSON.stringify(args)]),
                'javaCallInstance ' + methodName
            );
        },
        newInstance(className: string, args: readonly unknown[]): unknown {
            return unwrap(
                callNative('javaNewInstance', [String(className), JSON.stringify(args)]),
                'javaNewInstance ' + className
            );
        },
        getStaticField(className: string, fieldName: string): unknown {
            return unwrap(
                callNative('javaGetStaticField', [String(className), String(fieldName)]),
                'javaGetStaticField ' + className + '#' + fieldName
            );
        },
        setStaticField(className: string, fieldName: string, value: unknown): unknown {
            return unwrap(
                callNative('javaSetStaticField', [String(className), String(fieldName), JSON.stringify(value)]),
                'javaSetStaticField ' + className + '#' + fieldName
            );
        },
        getInstanceField(instance: unknown, fieldName: string): unknown {
            return unwrap(
                callNative('javaGetInstanceField', [handleOf(instance), String(fieldName)]),
                'javaGetInstanceField ' + fieldName
            );
        },
        setInstanceField(instance: unknown, fieldName: string, value: unknown): unknown {
            return unwrap(
                callNative('javaSetInstanceField', [handleOf(instance), String(fieldName), JSON.stringify(value)]),
                'javaSetInstanceField ' + fieldName
            );
        },
        getApplicationContext(): unknown {
            return unwrap(callNative('javaGetApplicationContext', []), 'javaGetApplicationContext');
        },
        getCurrentActivity(): unknown {
            return unwrap(callNative('javaGetCurrentActivity', []), 'javaGetCurrentActivity');
        },
        setEnv(key: string, value: string | null): void {
            // setEnv 属于 P2（源码里真实存在，官方 d.ts 未声明），因此显式检查可用性
            if (typeof native.setEnv !== 'function') {
                throw onjError('ONJ_MISSING_HOST', 'NativeInterface.setEnv 不可用，无法写环境变量。');
            }
            native.setEnv(String(key), value);
        }
    };
}

/** 把 { __javaHandle, __javaClass } 或裸 handle 字符串统一成 handle 字符串。 */
export function handleOf(instance: unknown): string {
    if (typeof instance === 'string' && instance.length > 0) {
        return instance;
    }
    if (instance !== null && typeof instance === 'object') {
        const candidate = (instance as Partial<JavaHandle>).__javaHandle;
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }
    throw createError('EINVAL', 'bridge.handleOf');
}

export function normalizeBoolean(value: unknown): boolean {
    if (value === true || value === false) {
        return value;
    }
    if (typeof value === 'string') {
        return value.trim().toLowerCase() === 'true';
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    if (value === null || value === undefined) {
        return false;
    }
    return Boolean(value);
}

/**
 * 解包 bridge 返回值。约定形状 `{ success, data?, error?, message? }`；
 * success 为 false 时抛中间态 Java 错误（带 code，但还没有 syscall / path）。
 */
export function unwrap(raw: unknown, context: string): unknown {
    if (typeof raw !== 'string') {
        return raw;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (parseFailure) {
        throw onjError('ONJ_BRIDGE_PROTOCOL', context + ' 的返回不是 JSON。');
    }
    if (parsed === null || typeof parsed !== 'object') {
        return parsed;
    }
    const envelope = parsed as BridgeEnvelope;
    if (envelope.success === false) {
        const detail = typeof envelope.error === 'string' && envelope.error.length > 0
            ? envelope.error
            : (typeof envelope.message === 'string' && envelope.message.length > 0 ? envelope.message : context);
        throw javaError(detail);
    }
    if (Object.prototype.hasOwnProperty.call(envelope, 'data')) {
        return envelope.data;
    }
    return envelope;
}

export function classExists(className: string): boolean {
    return getBackend().classExists(className);
}

export function callStatic(className: string, methodName: string, args: readonly unknown[] = []): unknown {
    return getBackend().callStatic(className, methodName, args);
}

export function callInstance(instance: unknown, methodName: string, args: readonly unknown[] = []): unknown {
    return getBackend().callInstance(instance, methodName, args);
}

export function newInstance(className: string, args: readonly unknown[] = []): unknown {
    return getBackend().newInstance(className, args);
}

export function getStaticField(className: string, fieldName: string): unknown {
    return getBackend().getStaticField(className, fieldName);
}

export function setStaticField(className: string, fieldName: string, value: unknown): unknown {
    return getBackend().setStaticField(className, fieldName, value);
}

export function getInstanceField(instance: unknown, fieldName: string): unknown {
    return getBackend().getInstanceField(instance, fieldName);
}

export function setInstanceField(instance: unknown, fieldName: string, value: unknown): unknown {
    return getBackend().setInstanceField(instance, fieldName, value);
}

export function getApplicationContext(): unknown {
    return getBackend().getApplicationContext();
}

export function getCurrentActivity(): unknown {
    return getBackend().getCurrentActivity();
}

/** 写环境变量。setEnv 是 P2 能力：不存在时抛 ONJ_MISSING_HOST，不静默丢弃。 */
export function setEnv(key: string, value: string | null): void {
    getBackend().setEnv(key, value);
}

/** 便于上层判断某个值是不是 Java 句柄。 */
export function isJavaHandle(value: unknown): value is JavaHandle {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    return typeof (value as Partial<JavaHandle>).__javaHandle === 'string';
}

/** 类型收窄辅助：把 unknown 断言成带 code 的错误对象。 */
export function asNodeError(value: unknown): NodeStyleError | null {
    if (value instanceof Error) {
        return value as NodeStyleError;
    }
    return null;
}
