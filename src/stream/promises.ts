'use strict';

/**
 * `stream/promises` 子路径入口。
 *
 * pipeline / finished 的 Promise 版实现放在 stream.ts 里（避免与它循环依赖），
 * 这里只是把 `stream.promises` 暴露成子路径 —— 与 Node 的
 * `require('stream').promises` / `require('stream/promises')` 两条路径一致。
 */

import streamModule = require('../stream');

export = streamModule.promises;
