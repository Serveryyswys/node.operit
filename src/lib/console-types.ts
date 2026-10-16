'use strict';

/** console 涉及的公开类型。 */

/** 输出目标的最小形状：只要求 write。 */
export interface WriteStreamLike {
    write(chunk: string): unknown;
}

/** prelude 提供的 console；Node 下这里就是全局 console。 */
export interface HostConsoleLike {
    log(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
