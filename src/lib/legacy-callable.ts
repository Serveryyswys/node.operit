'use strict';

/**
 * 让 class 写法的构造器**兼容老式"直接调用父类"用法**。
 *
 * 背景（真实故障）：
 *   很多老包写
 *       function PNG(options) { Stream.call(this, options); }
 *       util.inherits(PNG, Stream);
 *   这在 Node 上完全合法 —— Node 的 Stream / EventEmitter / Readable 都是**普通函数**，
 *   不用 new 也能调用。而本库这些类是用 class 写的，class 必须 new 才会执行构造体，
 *   在 QuickJS 上抛的正是 "class constructors must be invoked with 'new'"。
 *
 * 做法：
 *   - 有 this（即 X.call(this)）：把"构造器对实例做的初始化"作用到调用者的 this 上，
 *     然后返回这个 this。**不碰原型链** —— 调用方自己的 util.inherits 已经接好了，
 *     我们改反而会破坏它。
 *   - 没有 this（严格模式下裸调）：按 Node 的宽松语义，等价于 new 一个。
 *
 * 之所以能这样"重放初始化"：本库这些类的状态都是按对象惰性创建的
 * （stateOf(this)），初始化就是一次纯函数式调用，不依赖 class 的 this 绑定。
 *
 * **适用范围**：只给"初始化就等于整个构造函数体"的类用。
 * 目前用了两处 —— events.EventEmitter（构造体就是 stateOf(this)）与
 * stream.Stream（自己没有构造函数，直接继承 EventEmitter）。
 *
 * 构造函数还做别的事的类**不能**套这个包装：Readable/Writable 要在构造时搬运
 * options.read / options.destroy 等，走包装会漏掉那一步。那些类目前仍然
 * 只能 new —— 这是已知缺口，不是遗漏。
 */
export function makeLegacyCallable<T extends object>(
    Class: new (...args: never[]) => T,
    name: string,
    initialize: (self: object, args: unknown[]) => void
): new (...args: never[]) => T {
    const legacy = function legacyConstructor(this: unknown, ...args: unknown[]): unknown {
        if (this === undefined || this === null) {
            // 严格模式下的裸调：按 Node 的宽松语义等价于 new 一个
            return Reflect.construct(Class, args as never[], Class);
        }
        // X.call(this)：把初始化重放到调用者给的 this 上。
        //
        // 这里**刻意**不区分 new 与 .call —— 本包装只用于"初始化就等于构造函数体"
        // 的类（EventEmitter 是 stateOf(this)，Stream 直接继承 EventEmitter）。
        // 对构造函数还做别的事的类（Readable/Writable 要搬运 options），
        // 这样写会漏掉那部分，所以那些类不套这个包装 —— 见文件末尾的说明。
        initialize(this as object, args);
        return this;
    } as unknown as { new (...args: never[]): T; prototype: object; name: string };

    // 原型指向 class：instanceof 与 util.inherits(X, 这个) 都能成立
    legacy.prototype = Class.prototype;
    Object.defineProperty(legacy, 'name', { value: name, configurable: true });

    // 静态成员搬过去（defaultMaxListeners / once / on 之类）
    for (const key of Object.getOwnPropertyNames(Class)) {
        if (key === 'length' || key === 'name' || key === 'prototype') {
            continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(Class, key);
        if (descriptor !== undefined) {
            Object.defineProperty(legacy, key, descriptor);
        }
    }

    return legacy;
}
