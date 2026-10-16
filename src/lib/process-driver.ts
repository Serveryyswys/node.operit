'use strict';

/**
 * child_process 的宿主驱动层：把「怎么起进程」与「Node 的 child_process 语义」分开。
 * 与 fs-driver 同一套思路 —— 桌面测试可以注入基于 Node child_process 的驱动，
 * 从而把 child_process.ts 的语义与 Node 对拍，Java 相关的假设只收敛在一处。
 *
 * 实现一律是**同步**的：Java bridge 只有同步通道，没有真异步。
 */

import * as bridge from './bridge';

export interface ProcessRunOptions {
    cwd?: string;
    env?: Record<string, string>;
}

export interface ProcessRunResult {
    pid: number;
    status: number | null;
    stdout: string;
    stderr: string;
}

export interface ProcessDriver {
    /** 按 argv 起进程并等待结束；输出按 UTF-8 解码成文本。 */
    run(argv: readonly string[], options: ProcessRunOptions): ProcessRunResult;
}

let driver: ProcessDriver | null = null;

/** 宿主注入点：桌面测试用，传 null 恢复为 Operit Java 驱动。 */
export function setDriver(next: ProcessDriver | null): void {
    driver = next;
}

export function getDriver(): ProcessDriver {
    if (driver === null) {
        driver = createJavaDriver();
    }
    return driver;
}

/**
 * 基于 java.lang.ProcessBuilder 的驱动。
 *
 * 两处刻意的选择：
 *   - argv 用 JS 数组直接传：bridge 的 convertArg 对 `wrapper.isArray` 与 Collection 目标
 *     都能把 JS 数组转成 Java 数组 / List，因此不需要手工拼命令行字符串；
 *   - 输出用 java.util.Scanner 读成 String：InputStream.readAllBytes() 是 Java 9，
 *     在 Android 8~12 上不可用；Scanner 在所有 API 级别都在。
 *     代价是输出按 UTF-8 解码，二进制输出会有损（已在 README 写明）。
 *
 * 已知限制：先读 stdout 再读 stderr，若子进程往 stderr 写超过管道缓冲（约 64KB）
 * 会与我们的读取形成死锁。Node 用事件循环规避这一点，同步实现做不到。
 */
export function createJavaDriver(): ProcessDriver {
    function readAll(stream: unknown): string {
        const scanner = bridge.newInstance('java.util.Scanner', [stream, 'UTF-8']);
        try {
            if (!bridge.normalizeBoolean(bridge.callInstance(scanner, 'hasNext', []))) {
                return '';
            }
            return String(bridge.callInstance(scanner, 'next', []));
        } finally {
            bridge.callInstance(scanner, 'close', []);
        }
    }

    return {
        run(argv: readonly string[], options: ProcessRunOptions): ProcessRunResult {
            const builder = bridge.newInstance('java.lang.ProcessBuilder', [argv.slice()]);
            if (options.cwd !== undefined) {
                bridge.callInstance(builder, 'directory', [bridge.newInstance('java.io.File', [options.cwd])]);
            }
            if (options.env !== undefined) {
                const environment = bridge.callInstance(builder, 'environment', []);
                bridge.callInstance(environment, 'putAll', [options.env]);
            }
            const process = bridge.callInstance(builder, 'start', []);
            const stdout = readAll(bridge.callInstance(process, 'getInputStream', []));
            const stderr = readAll(bridge.callInstance(process, 'getErrorStream', []));
            const status = Number(bridge.callInstance(process, 'waitFor', []));
            const pid = Number(bridge.callInstance(process, 'pid', [])) || 0;
            return { pid: pid, status: status, stdout: stdout, stderr: stderr };
        }
    };
}
