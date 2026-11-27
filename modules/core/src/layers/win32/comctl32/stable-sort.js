/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The sort the common controls share: DPA_Sort, a list view's LVM_SORTITEMS
 * and a tree view's TVM_SORTCHILDREN(CB) put their elements in the order a
 * comparison answers, and equal elements keep the order they had. A merge
 * sort, because the comparison is often the program's own, called in the
 * guest and awaited, and a merge asks it no more than n log n times.
 */

/**
 * @template T
 * @param {T[]} values
 * @param {(a: T, b: T) => number | Promise<number>} order  below, at or above zero
 * @returns {Promise<T[]>} a new array; `values` is left as it was
 */
export async function stableSort(values, order){
    if (values.length < 2)
    {
        return values.slice();
    }
    const middle = values.length >> 1;
    const left = await stableSort(values.slice(0, middle), order);
    const right = await stableSort(values.slice(middle), order);
    /** @type {T[]} */
    const merged = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length)
    {
        merged.push((await order(left[i], right[j]) | 0) <= 0 ? left[i++] : right[j++]);
    }
    return [...merged, ...left.slice(i), ...right.slice(j)];
}
