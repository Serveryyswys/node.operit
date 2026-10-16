'use strict';

/**
 * 已废弃的 `sys` 模块。
 *
 * Node 里它就是 `util` 的**同一个对象**（`require('sys') === require('util')`），
 * 历史上是 util 的前身。仍有老包 require 它，所以保持这个别名。
 */

import utilModule = require('./util');

export = utilModule;
