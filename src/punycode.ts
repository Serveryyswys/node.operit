'use strict';

/**
 * punycode（已废弃，但仍被不少包直接 require）。
 *
 * 实现复用 lib/punycode.ts —— url 模块内部也在用它，所以这里不重复一份。
 * 与 Node 的差异：`version` 报 '2.1.1'（Node 内置的是同一个算法实现的 2.x）。
 */

import punycodeCore = require('./lib/punycode');

/** UTF-16 码元序列（Node 的 punycode.ucs2.decode 返回的是码元，不是码点）。 */
function ucs2decode(value: string): number[] {
    const output: number[] = [];
    let counter = 0;
    while (counter < value.length) {
        const first = value.charCodeAt(counter);
        counter += 1;
        if (first >= 0xd800 && first <= 0xdbff && counter < value.length) {
            const second = value.charCodeAt(counter);
            if ((second & 0xfc00) === 0xdc00) {
                counter += 1;
                output.push(((first & 0x3ff) << 10) + (second & 0x3ff) + 0x10000);
                continue;
            }
        }
        output.push(first);
    }
    return output;
}

function ucs2encode(codePoints: readonly number[]): string {
    let output = '';
    for (let index = 0; index < codePoints.length; index += 1) {
        const value = codePoints[index];
        if (value > 0xffff) {
            const adjusted = value - 0x10000;
            output += String.fromCharCode((adjusted >>> 10) + 0xd800, (adjusted % 0x400) + 0xdc00);
        } else {
            output += String.fromCharCode(value);
        }
    }
    return output;
}

const punycode = {
    version: '2.1.1',
    ucs2: {
        decode: ucs2decode,
        encode: ucs2encode
    },
    decode: punycodeCore.decode,
    encode: punycodeCore.encode,
    toASCII: punycodeCore.toASCII,
    toUnicode: punycodeCore.toUnicode
};

export = punycode;
