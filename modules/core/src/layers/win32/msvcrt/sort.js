/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The searches and the sort that hand the comparator a context: `qsort_s`
 * and `_lfind_s`, with `_lfind` beside them.
 *
 * `qsort_s` sorts as msvcrt's own sort does, comparison for comparison: a
 * run of eight or fewer elements by moving its largest to its end, again
 * and again; a longer one split around the median of its first, middle and
 * last elements, the smaller side sorted first. A program cannot tell two
 * sorts apart by their result alone, but it can by the order its comparator
 * is called in and by where equal elements land, and Wine's test of it
 * checks both. Each comparison is a call into the program, made from here
 * and waited for; these are rare enough that the round trip is not worth
 * code in the guest.
 */

import { EINVAL } from './globals.js';

/** The longest run sorted by moving its largest element to the end. */
const SHORT_RUN = 8;

/**
 * @typedef {Object} SortHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} callGuest
 * @property {() => any} [currentThread]
 * @property {(code: number) => void} [errno]
 */

/**
 * @param {SortHost} host
 */
export function createSortFunctions(host){
    /**
     * @param {number} argBytes
     * @param {(args: number[]) => number | Promise<number>} handler
     */
    const cdecl = (argBytes, handler)=>({ convention: 'cdecl', argBytes, handler });

    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /** Two elements exchanged in place. @param {number} a @param {number} b @param {number} width */
    const swap = (a, b, width)=>{
        if (a === b)
        {
            return;
        }
        const left = host.readMemory(a, width).slice();
        const right = host.readMemory(b, width).slice();
        host.writeMemory(a, right);
        host.writeMemory(b, left);
    };

    /**
     * qsort_s's body.
     *
     * @param {number} base @param {number} num @param {number} width
     * @param {(left: number, right: number) => Promise<number>} compare
     */
    const sort = async(base, num, width, compare)=>{
        if (num < 2 || width === 0)
        {
            return;
        }
        /** @type {[number, number][]} */
        const pending = [[base, base + (num - 1) * width]];
        while (pending.length > 0)
        {
            let [lo, hi] = /** @type {[number, number]} */ (pending.pop());
            for (;;)
            {
                const size = (hi - lo) / width + 1;
                if (size <= SHORT_RUN)
                {
                    // The largest of lo..hi to hi, then of lo..hi-1, and on.
                    for (let end = hi; end > lo; end -= width)
                    {
                        let max = lo;
                        for (let p = lo + width; p <= end; p += width)
                        {
                            if (await compare(p, max) > 0)
                            {
                                max = p;
                            }
                        }
                        swap(max, end, width);
                    }
                    break;
                }
                let mid = lo + Math.floor(size / 2) * width;
                if (await compare(lo, mid) > 0)
                {
                    swap(lo, mid, width);
                }
                if (await compare(lo, hi) > 0)
                {
                    swap(lo, hi, width);
                }
                if (await compare(mid, hi) > 0)
                {
                    swap(mid, hi, width);
                }
                let low = lo;
                let high = hi;
                for (;;)
                {
                    if (mid > low)
                    {
                        do {
                            low += width;
                        } while (low < mid && await compare(low, mid) <= 0);
                    }
                    if (mid <= low)
                    {
                        do {
                            low += width;
                        } while (low <= hi && await compare(low, mid) <= 0);
                    }
                    do {
                        high -= width;
                    } while (high > mid && await compare(high, mid) > 0);
                    if (high < low)
                    {
                        break;
                    }
                    swap(low, high, width);
                    if (mid === high)
                    {
                        mid = low;
                    }
                }
                // Past the elements equal to the partition's, which are in place.
                high += width;
                if (mid < high)
                {
                    do {
                        high -= width;
                    } while (high > mid && await compare(high, mid) === 0);
                }
                if (mid >= high)
                {
                    do {
                        high -= width;
                    } while (high > lo && await compare(high, mid) === 0);
                }
                // The smaller side now, the larger one kept for later.
                if (high - lo >= hi - low)
                {
                    if (lo < high)
                    {
                        pending.push([lo, high]);
                    }
                    if (low < hi)
                    {
                        lo = low;
                        continue;
                    }
                }
                else
                {
                    if (low < hi)
                    {
                        pending.push([low, hi]);
                    }
                    if (lo < high)
                    {
                        hi = high;
                        continue;
                    }
                }
                break;
            }
        }
    };

    /**
     * The comparator's answer, the signed int it returns.
     *
     * @param {number} compare @param {number[]} args @param {any} thread
     */
    const ask = async(compare, args, thread)=>(await host.callGuest(compare, args, thread)) | 0;

    /**
     * _lfind's and _lfind_s's body: the first element the comparator calls
     * equal to the key, or null.
     *
     * @param {number} key @param {number} base @param {number} count @param {number} width
     * @param {(element: number) => Promise<number>} compare
     */
    const find = async(key, base, count, width, compare)=>{
        for (let i = 0; i < count; i++)
        {
            const element = (base + i * width) >>> 0;
            if (await compare(element) === 0)
            {
                return element;
            }
        }
        return 0;
    };

    return {
        /**
         * void qsort_s(void *base, size_t num, size_t width,
         *              int (*compare)(void *context, const void *, const void *),
         *              void *context)
         *
         * No array for a count, a width of zero or no comparator is EINVAL,
         * nothing sorted.
         */
        qsort_s: cdecl(20, ([base, num, width, compare, context])=>{
            if (((base >>> 0) === 0 && (num >>> 0) !== 0) || (width >>> 0) === 0
                || (compare >>> 0) === 0)
            {
                host.errno?.(EINVAL);
                return 0;
            }
            const thread = host.currentThread?.();
            return sort(base >>> 0, num >>> 0, width >>> 0,
                (left, right)=>ask(compare, [context, left >>> 0, right >>> 0], thread))
                .then(()=>0);
        }),

        /**
         * void *_lfind_s(const void *key, const void *base, unsigned int *num,
         *                size_t width,
         *                int (*compare)(void *context, const void *, const void *),
         *                void *context)
         *
         * A linear search, the key the comparator's first element: null with
         * EINVAL for no key, array, count, width or comparator.
         */
        _lfind_s: cdecl(24, ([key, base, num, width, compare, context])=>{
            if ((key >>> 0) === 0 || (base >>> 0) === 0 || (num >>> 0) === 0
                || (width >>> 0) === 0 || (compare >>> 0) === 0)
            {
                host.errno?.(EINVAL);
                return 0;
            }
            const thread = host.currentThread?.();
            return find(key, base >>> 0, readU32(num), width >>> 0,
                element=>ask(compare, [context, key >>> 0, element], thread));
        }),

        /**
         * void *_lfind(const void *key, const void *base, unsigned int *num,
         *              unsigned int width, int (*compare)(const void *, const void *))
         */
        _lfind: cdecl(20, ([key, base, num, width, compare])=>{
            if ((num >>> 0) === 0 || (compare >>> 0) === 0)
            {
                host.errno?.(EINVAL);
                return 0;
            }
            const thread = host.currentThread?.();
            return find(key, base >>> 0, readU32(num), width >>> 0,
                element=>ask(compare, [key >>> 0, element], thread));
        }),

        /**
         * void *_lsearch(const void *key, void *base, unsigned int *num,
         *                unsigned int width, int (*compare)(const void *, const void *))
         *
         * _lfind, and a key not found appended to the array, the count raised.
         */
        _lsearch: cdecl(20, ([key, base, num, width, compare])=>{
            if ((num >>> 0) === 0 || (compare >>> 0) === 0)
            {
                host.errno?.(EINVAL);
                return 0;
            }
            const thread = host.currentThread?.();
            const count = readU32(num);
            return find(key, base >>> 0, count, width >>> 0,
                element=>ask(compare, [key >>> 0, element], thread)).then(found=>{
                if (found !== 0)
                {
                    return found;
                }
                const end = (base + count * width) >>> 0;
                host.writeMemory(end, host.readMemory(key >>> 0, width >>> 0).slice());
                writeU32(num, count + 1);
                return end;
            });
        }),
    };
}
