'use strict';

/**
 * 运行时路径根的来源。只使用 Operit 已经声明的全局与本库的 bridge 层。
 *
 * 公开面（Operit 的 types/index.d.ts 已声明）：
 *   getPluginConfigDir(id) -> /sdcard/Download/Operit/plugins/<id>
 *   OPERIT_DOWNLOAD_DIR / OPERIT_CLEAN_ON_EXIT_DIR
 * 内部面（源码里真实存在、d.ts 未声明）：
 *   getPluginConfigDir('') 会回落到当前 call 的包名 —— packageName() 依赖这一行为。
 *   该依赖集中在本模块，若将来失效只需改这一处。
 */

import pathModule = require('../path');
import * as bridge from './bridge';
import { onjError } from './errors';

function resolvePluginConfigDir(packageId: string): string {
    if (typeof getPluginConfigDir !== 'function') {
        throw onjError('ONJ_MISSING_HOST', '全局 getPluginConfigDir 不可用。');
    }
    const dir = getPluginConfigDir(packageId);
    if (typeof dir !== 'string' || dir.length === 0) {
        throw onjError(
            'ONJ_MISSING_HOST',
            'getPluginConfigDir(' + (packageId.length > 0 ? packageId : '<当前包>') + ') 返回空。'
        );
    }
    return dir;
}

export function pluginConfigDir(packageId?: string): string {
    return resolvePluginConfigDir(packageId === undefined ? '' : String(packageId));
}

let cachedPackageName: string | null = null;

/** 当前包名：由 getPluginConfigDir('') 的返回路径反推。 */
export function packageName(): string {
    if (cachedPackageName === null) {
        cachedPackageName = pathModule.basename(pluginConfigDir());
    }
    return cachedPackageName;
}

export function downloadDir(): string {
    if (typeof OPERIT_DOWNLOAD_DIR === 'string' && OPERIT_DOWNLOAD_DIR.length > 0) {
        return OPERIT_DOWNLOAD_DIR;
    }
    throw onjError('ONJ_MISSING_HOST', '全局 OPERIT_DOWNLOAD_DIR 不可用。');
}

export function cleanOnExitDir(): string {
    if (typeof OPERIT_CLEAN_ON_EXIT_DIR === 'string' && OPERIT_CLEAN_ON_EXIT_DIR.length > 0) {
        return OPERIT_CLEAN_ON_EXIT_DIR;
    }
    throw onjError('ONJ_MISSING_HOST', '全局 OPERIT_CLEAN_ON_EXIT_DIR 不可用。');
}

export function appContext(): unknown {
    return bridge.getApplicationContext();
}

function contextDir(methodName: string): string {
    const context = bridge.getApplicationContext();
    const dir = bridge.callInstance(context, methodName, []);
    const absolute = bridge.callInstance(dir, 'getAbsolutePath', []);
    if (typeof absolute !== 'string' || absolute.length === 0) {
        throw onjError('ONJ_BRIDGE_PROTOCOL', 'Context.' + methodName + '() 未返回可用路径。');
    }
    return absolute;
}

export function filesDir(): string {
    return contextDir('getFilesDir');
}

export function cacheDir(): string {
    return contextDir('getCacheDir');
}
