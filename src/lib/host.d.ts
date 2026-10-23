/**
 * Operit 运行时给沙箱脚本提供的全局面。
 *
 * 这里只声明 node.operit 真正依赖的部分，并按"公开 / 内部"分组：
 * OperitPackageManager 的重写器与宿主能力都靠这些，改动集中在此文件。
 *
 * 对照 Operit 仓库的 types/core.d.ts 与 types/index.d.ts：
 *   - P1 组是官方 d.ts 已声明的契约
 *   - P2 组在源码里真实存在、Operit 自己的模块加载器也在用，但没有写进给开发者的 d.ts
 */

/**
 * CommonJS 的 require —— 由运行时的模块加载器作为**函数参数**注入
 * （JsExecutionScriptBuilder.kt 的 factory(module, exports, require, __operit_call_runtime)）。
 *
 * 这里声明出来是为了在必须**惰性加载**（避免循环依赖）时能用它，
 * 例如 fs 上的 promises 要指到 fs/promises，而后者自己又 require fs。
 */
declare function require(id: string): unknown;

/**
 * prelude 注入的 console（JsExecutionScriptBuilder.kt:53）。
 *
 * 只有这四个方法 —— 没有 debug / assert / table 等。
 * 需要完整 API 请用本库的 `console` 模块（它在这些方法之上补齐）。
 */
declare const console: {
    log(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
};

declare function queueMicrotask(callback: () => void): void;
declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): number;
declare function clearTimeout(timerId?: number): void;
declare function setInterval(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): number;
declare function clearInterval(timerId?: number): void;

declare const performance: { now(): number };

/**
 * 调用宿主工具（P1）。
 *
 * 返回 Promise，决议为工具结果：宿主会把 ToolResult 拆包，直接给出 data
 * （例如 http_request 给的就是 HttpResponseData）。定义见 JsInitRuntimeScriptBuilder.kt:461。
 */
declare function toolCall(name: string, params?: Record<string, unknown>): Promise<unknown>;

/** 读环境变量（P1）。对不存在的变量返回空串，无法与"设为空串"区分。 */
declare function getEnv(key: string): string | undefined;

/** 当前包的状态标识（P1）。 */
declare function getState(): string | undefined;

/** 当前语言（P1），缺省 'en'。 */
declare function getLang(): string;

/** 返回 `/sdcard/Download/Operit/plugins/<id>`；传空串时回落到当前 call 的包（P2）。 */
declare function getPluginConfigDir(pluginId?: string): string;

/** 下载目录（P1）。 */
declare const OPERIT_DOWNLOAD_DIR: string;

/** 退出即清理的目录（P1）。 */
declare const OPERIT_CLEAN_ON_EXIT_DIR: string;

/**
 * Java bridge 宿主对象。
 *
 * 所有方法都返回 JSON 字符串，形状为 `{ success, data?, error?, message? }`；
 * 参数方向只接受 JSON 值。未绑定宿主（例如桌面 Node）时为 undefined。
 */
declare const NativeInterface: OperitNativeInterface | undefined;

interface OperitNativeInterface {
    javaClassExists(className: string): boolean | string;
    javaCallStatic(className: string, methodName: string, argsJson: string): string;
    javaCallInstance(instanceHandle: string, methodName: string, argsJson: string): string;
    javaNewInstance(className: string, argsJson: string): string;
    javaGetStaticField(className: string, fieldName: string): string;
    javaSetStaticField(className: string, fieldName: string, valueJson: string): string;
    javaGetInstanceField(instanceHandle: string, fieldName: string): string;
    javaSetInstanceField(instanceHandle: string, fieldName: string, valueJson: string): string;
    javaGetApplicationContext(): string;
    javaGetCurrentActivity(): string;

    /** 写环境变量（P2：源码里真实存在，未写进官方 d.ts）。 */
    setEnv?(key: string, value: string | null): void;

    /** 批量写环境变量（P2）。 */
    setEnvs?(valuesJson: string): void;
}
