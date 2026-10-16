'use strict';

/** diagnostics_channel 的公开类型。 */
export interface Subscriber {
    (message: unknown, name: string): void;
}

export interface ChannelStore {
    [key: string]: unknown;
}
