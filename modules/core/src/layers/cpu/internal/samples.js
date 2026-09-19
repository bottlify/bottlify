/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where the guest ran, sampled at the boundary of every slice rather than
 * per instruction or per block: `runSlice` already reads EIP and counts a
 * slice's retired instructions for its own bookkeeping, and crediting a
 * bucket here costs one more register read and one table update -- nothing
 * that scales with instructions or blocks.
 *
 * Bucketed to 64 bytes (`eip >>> BUCKET_SHIFT`) rather than kept by exact
 * address, so the few thousand addresses a hot loop actually touches fold
 * into the handful of buckets it occupies. Capped at `BUCKET_CAP` distinct
 * buckets -- a working set that keeps growing stops growing the table and
 * is counted as overflow instead, so a long run's memory here is bounded no
 * matter how much guest code it touches.
 */

/** Buckets are 2**this many bytes: 64. */
const BUCKET_SHIFT = 6;

/** Distinct buckets kept before a new one is refused and counted instead. */
export const BUCKET_CAP = 16384;

/** A fresh, empty sample table. */
export function createSampleTable(){
    return {
        /** @type {Map<number, { instructions: number, ms: number, samples: number }>} */
        buckets: new Map(),
        slices: 0,
        overflow: 0,
    };
}

/**
 * Credits one slice's instructions and wall time to the bucket its EIP
 * falls in. The only allocation this can ever cause is a new `Map` entry
 * for a bucket never seen before, and only until the cap is reached -- an
 * existing bucket's own update allocates nothing.
 *
 * @param {ReturnType<typeof createSampleTable>} table
 * @param {number} eip
 * @param {number} instructions
 * @param {number} ms
 */
export function creditSample(table, eip, instructions, ms){
    table.slices++;
    const key = (eip >>> 0) >>> BUCKET_SHIFT;
    const bucket = table.buckets.get(key);
    if (bucket)
    {
        bucket.instructions += instructions;
        bucket.ms += ms;
        bucket.samples++;
        return;
    }
    if (table.buckets.size >= BUCKET_CAP)
    {
        table.overflow++;
        return;
    }
    table.buckets.set(key, { instructions, ms, samples: 1 });
}

/**
 * The heaviest buckets by instructions, for a diagnostics reader.
 *
 * Reported by the bucket's own address rather than by rank: a caller that
 * takes two readings a second apart (the overlay's own pattern, `rise()`
 * over two `diagnostics()` snapshots) matches a bucket across the two by
 * that address, and a bucket whose rank moved between readings must not
 * read as a different one.
 *
 * @param {ReturnType<typeof createSampleTable>} table
 * @param {number} [count]
 */
export function topSamples(table, count = 64){
    return [...table.buckets]
        .sort((left, right)=>right[1].instructions - left[1].instructions)
        .slice(0, count)
        .map(([key, bucket])=>({
            address: key * (1 << BUCKET_SHIFT),
            instructions: bucket.instructions,
            ms: bucket.ms,
            samples: bucket.samples,
        }));
}
