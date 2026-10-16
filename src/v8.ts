'use strict';

/**
 * v8 —— **partial**。
 *
 * 只实现"能从 JVM 如实取到"的堆统计；V8 专有的东西（序列化格式、V8 标志、覆盖率、
 * 堆快照）在 QuickJS + Android 上没有对应物，一律显式抛 ONJ_UNSUPPORTED，
 * 不给形状相似但语义不同的假实现。
 *
 * 注意：这里的堆统计是 **JVM 堆**，不是 V8 堆（Node 里是 V8 堆）。
 * 这一点与 os.totalmem / os.freemem 的近似同类，已在 BUILTINS.json 里记明。
 */

import * as bridge from './lib/bridge';
import { HeapStatistics, HeapSpaceStatistics, HeapCodeStatistics } from './lib/v8-types';

function onjUnsupported(feature: string, reason: string): Error {
    const failure = new Error(feature + '：' + reason);
    (failure as Error & { code?: string }).code = 'ONJ_UNSUPPORTED';
    return failure;
}

function runtime(): unknown {
    return bridge.callStatic('java.lang.Runtime', 'getRuntime', []);
}

function heapNumbers(): { total: number; free: number; max: number } {
    const handle = runtime();
    return {
        total: Number(bridge.callInstance(handle, 'totalMemory', [])) || 0,
        free: Number(bridge.callInstance(handle, 'freeMemory', [])) || 0,
        max: Number(bridge.callInstance(handle, 'maxMemory', [])) || 0
    };
}

function getHeapStatistics(): HeapStatistics {
    const heap = heapNumbers();
    const used = heap.total - heap.free;
    return {
        total_heap_size: heap.total,
        total_heap_size_executable: 0,
        total_physical_size: heap.total,
        total_available_size: heap.max - used,
        used_heap_size: used,
        heap_size_limit: heap.max,
        malloced_memory: 0,
        peak_malloced_memory: 0,
        does_zap_garbage: false,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        external_memory: 0
    };
}

/** QuickJS 不暴露分空间统计，返回空数组（Node 在 V8 下会给出各 space）。 */
function getHeapSpaceStatistics(): HeapSpaceStatistics[] {
    return [];
}

function getHeapCodeStatistics(): HeapCodeStatistics {
    return {
        code_and_metadata_size: 0,
        bytecode_and_metadata_size: 0,
        external_script_source_size: 0,
        cpu_profiler_metadata_size: 0
    };
}

function serialize(): never {
    throw onjUnsupported('v8.serialize()', 'V8 的二进制序列化格式依赖 V8 本身，QuickJS 无法产出兼容字节流');
}

function deserialize(): never {
    throw onjUnsupported('v8.deserialize()', '同上：无法解析 V8 的序列化格式');
}

function setFlagsFromString(): never {
    throw onjUnsupported('v8.setFlagsFromString()', '这是 V8 专有的标志开关，运行时不是 V8');
}

function cachedDataVersionTag(): never {
    throw onjUnsupported('v8.cachedDataVersionTag()', '该值标识 V8 版本，用于判断编译缓存是否可用；运行时不用 V8 缓存');
}

function writeHeapSnapshot(): never {
    throw onjUnsupported('v8.writeHeapSnapshot()', '堆快照是 V8 专有格式');
}

function takeCoverage(): never {
    throw onjUnsupported('v8.takeCoverage()', '覆盖率采集是 V8 专有能力');
}

function stopCoverage(): never {
    throw onjUnsupported('v8.stopCoverage()', '覆盖率采集是 V8 专有能力');
}

const v8Module = {
    getHeapStatistics: getHeapStatistics,
    getHeapSpaceStatistics: getHeapSpaceStatistics,
    getHeapCodeStatistics: getHeapCodeStatistics,
    serialize: serialize,
    deserialize: deserialize,
    setFlagsFromString: setFlagsFromString,
    cachedDataVersionTag: cachedDataVersionTag,
    writeHeapSnapshot: writeHeapSnapshot,
    takeCoverage: takeCoverage,
    stopCoverage: stopCoverage
};

export = v8Module;
