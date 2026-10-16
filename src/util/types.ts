'use strict';

/**
 * `util/types` 子路径入口：与 `require('util').types` 是同一个对象。
 *
 * 它是很多包的高频依赖（比如 `is-* 系列、`has-symbols` 这类能力探测），
 * 而且写法通常是 `require('util/types')` 而不是从 `util` 上取。
 */

import utilModule = require('../util');

export = utilModule.types;
