'use strict';

/** v8 的堆统计类型（与 Node 的字段名一致）。 */
export interface HeapStatistics {
    total_heap_size: number;
    total_heap_size_executable: number;
    total_physical_size: number;
    total_available_size: number;
    used_heap_size: number;
    heap_size_limit: number;
    malloced_memory: number;
    peak_malloced_memory: number;
    does_zap_garbage: boolean;
    number_of_native_contexts: number;
    number_of_detached_contexts: number;
    total_global_handles_size: number;
    used_global_handles_size: number;
    external_memory: number;
}

export interface HeapSpaceStatistics {
    space_name: string;
    space_size: number;
    space_used_size: number;
    space_available_size: number;
    physical_space_size: number;
}

export interface HeapCodeStatistics {
    code_and_metadata_size: number;
    bytecode_and_metadata_size: number;
    external_script_source_size: number;
    cpu_profiler_metadata_size: number;
}
