/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Room in one segment of the cache's hot part, in blocks of a power of two
 * from `UNIT` to the segment's size: a block given back joins its twin when
 * the twin is free too, so a segment whose bodies all went is one free block
 * again and can be let go whole. The price is the rounding: a body takes the
 * block of the next power of two (`wasted` counts it).
 *
 * Only the keeper places and frees; nothing here is shared between threads.
 */

/** The smallest block: one page. */
export const UNIT = 4096;

/** @param {number} n */
const log2 = n=>31 - Math.clz32(n);

/**
 * @param {number} bytes  the segment's size, a power of two at least `UNIT`
 */
export function createBuddy(bytes){
    if (bytes < UNIT || (bytes & (bytes - 1)) !== 0)
    {
        throw new RangeError(
            `cache: a segment of ${bytes} bytes is not a power of two from ${UNIT}`);
    }
    const top = log2(bytes / UNIT);
    /** Free blocks by order (block = UNIT << order), as offsets. @type {Set<number>[]} */
    const free = Array.from({ length: top + 1 }, ()=>new Set());
    free[top].add(0);
    /** The order of each block handed out, by offset. @type {Map<number, number>} */
    const given = new Map();
    let used = 0;
    let asked = 0;

    /** @param {number} length */
    const orderOf = length=>{
        const units = Math.ceil(length / UNIT);
        return units <= 1 ? 0 : log2(units - 1) + 1;
    };

    return {
        bytes,
        /**
         * A block holding `length` bytes: its offset, or -1 where none is free.
         *
         * @param {number} length
         */
        place(length){
            if (!(length > 0) || length > bytes)
            {
                return -1;
            }
            const order = orderOf(length);
            let at = order;
            while (at <= top && free[at].size === 0)
            {
                at++;
            }
            if (at > top)
            {
                return -1;
            }
            const offset = /** @type {number} */ (free[at].values().next().value);
            free[at].delete(offset);
            // Split down to the order asked, the upper halves left free.
            while (at > order)
            {
                at--;
                free[at].add(offset + (UNIT << at));
            }
            given.set(offset, order);
            used += UNIT << order;
            asked += length;
            return offset;
        },
        /**
         * Gives back the block at `offset`, which held `length` bytes.
         *
         * @param {number} offset @param {number} length
         */
        give(offset, length){
            let order = given.get(offset);
            if (order === undefined)
            {
                throw new Error(`cache: no block at ${offset} to give back`);
            }
            given.delete(offset);
            used -= UNIT << order;
            asked -= length;
            let at = offset;
            while (order < top)
            {
                const twin = at ^ (UNIT << order);
                if (!free[order].delete(twin))
                {
                    break;
                }
                at = Math.min(at, twin);
                order++;
            }
            free[order].add(at);
        },
        /** No block handed out: the segment can be let go whole. */
        empty: ()=>given.size === 0,
        /** Bytes in blocks handed out. */
        used: ()=>used,
        /** Bytes of those blocks the bodies do not fill. */
        wasted: ()=>used - asked,
        /** The largest block free now. */
        largest(){
            for (let order = top; order >= 0; order--)
            {
                if (free[order].size > 0)
                {
                    return UNIT << order;
                }
            }
            return 0;
        },
    };
}

/** @typedef {ReturnType<typeof createBuddy>} Buddy */
