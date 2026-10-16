'use strict';

/**
 * diagnostics_channel。
 *
 * 它的语义是纯粹的「按名字的发布订阅」，本身不依赖任何平台能力，所以可以完整实现。
 *
 * 与 Node 的差异（都写进 BUILTINS.json）：
 *   - Channel 的 bindStore / unbindStore / runStores 依赖 AsyncLocalStorage（需要 async_hooks），
 *     Android 的 QuickJS 运行时没有物化这些钩子，所以这三个方法显式抛 ONJ_UNSUPPORTED，
 *     而不是给一个"看着像但语义不对"的空实现；
 *   - tracingChannel 未实现（依赖上面那组 API），同样显式拒绝。
 */

import { Subscriber, ChannelStore } from './lib/diagnostics-channel-types';

const channels = new Map<string, Channel>();

class Channel {
    constructor(name: string) {
        this.name = name;
    }

    readonly name: string;
    subscribers: Subscriber[] = [];

    get hasSubscribers(): boolean {
        return this.subscribers.length > 0;
    }

    subscribe(onMessage: Subscriber): void {
        if (typeof onMessage !== 'function') {
            throw new TypeError('The "onMessage" argument must be of type function.');
        }
        if (this.subscribers.indexOf(onMessage) < 0) {
            this.subscribers.push(onMessage);
        }
    }

    unsubscribe(onMessage: Subscriber): void {
        const index = this.subscribers.indexOf(onMessage);
        if (index >= 0) {
            this.subscribers.splice(index, 1);
        }
    }

    publish(message: unknown): void {
        const listeners = this.subscribers.slice();
        for (let index = 0; index < listeners.length; index += 1) {
            listeners[index](message, this.name);
        }
    }

    bindStore(_store: ChannelStore, _transform?: unknown): void {
        throw onjUnsupported('diagnostics_channel.Channel.bindStore');
    }

    unbindStore(_store: ChannelStore): void {
        throw onjUnsupported('diagnostics_channel.Channel.unbindStore');
    }

    runStores(_context: unknown, _fn: Function, _thisArg?: unknown, ..._args: unknown[]): unknown {
        throw onjUnsupported('diagnostics_channel.Channel.runStores');
    }
}

function onjUnsupported(feature: string): Error {
    const failure = new Error(feature + ' 需要 AsyncLocalStorage（async_hooks），Android 的 QuickJS 运行时不提供异步钩子。');
    (failure as Error & { code?: string }).code = 'ONJ_UNSUPPORTED';
    return failure;
}

function channel(name: string): Channel {
    if (typeof name !== 'string' && typeof name !== 'symbol') {
        throw new TypeError('The "channel" argument must be of type string or symbol.');
    }
    const key = String(name);
    const existing = channels.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const created = new Channel(key);
    channels.set(key, created);
    return created;
}

function hasSubscribers(name: string): boolean {
    const existing = channels.get(String(name));
    return existing !== undefined && existing.hasSubscribers;
}

function subscribe(name: string, onMessage: Subscriber): void {
    channel(name).subscribe(onMessage);
}

function unsubscribe(name: string, onMessage: Subscriber): void {
    channel(name).unsubscribe(onMessage);
}

const diagnosticsChannel = {
    channel: channel,
    hasSubscribers: hasSubscribers,
    subscribe: subscribe,
    unsubscribe: unsubscribe,
    Channel: Channel
};

export = diagnosticsChannel;
