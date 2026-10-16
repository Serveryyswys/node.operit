'use strict';

/** util.inspect 的选项（导出型别，供 console 等模块复用）。 */
export interface InspectOptions {
    depth?: number | null;
    colors?: boolean;
    showHidden?: boolean;
    compact?: boolean | number;
    breakLength?: number;
    sorted?: boolean;
    maxArrayLength?: number;
    maxStringLength?: number | null;
    getters?: boolean;
    showProxy?: boolean;
}
