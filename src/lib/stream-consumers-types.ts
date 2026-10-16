'use strict';

/** stream/consumers 接受的最小可读流形状。 */
export interface ReadableLike {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
}
