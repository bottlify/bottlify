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

/**
 * @typedef {{ instructions: number, samples: number, eip: number, noted: number,
 *     due: boolean }} Bucket
 */

/** A fresh, empty sample table. */
export function createSampleTable(){
    return {
        /** @type {Map<number, Bucket>} */
        buckets: new Map(),
        /** The buckets past the hot threshold whose last address is not yet the one
         * handed over (`noted`), each once: what a feed looks at, rather than every
         * bucket -- a pass over all of them after every slice was most of a run's
         * thread time with the translator fed by slice. @type {Bucket[]} */
        due: [],
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
 * @param {number} [hot]  the instructions past which a bucket is due (`due`)
 */
export function creditSample(table, eip, instructions, hot = Infinity){
    table.slices++;
    const key = (eip >>> 0) >>> BUCKET_SHIFT;
    let bucket = table.buckets.get(key);
    if (bucket)
    {
        bucket.instructions += instructions;
        bucket.samples++;
        bucket.eip = eip >>> 0;
    }
    else if (table.buckets.size >= BUCKET_CAP)
    {
        table.overflow++;
        return;
    }
    else
    {
        // The exact address as well as the bucket: a translator's region starts
        // at an instruction, and the slice ended on one.
        bucket = { instructions, samples: 1, eip: eip >>> 0, noted: -1, due: false };
        table.buckets.set(key, bucket);
    }
    if (!bucket.due && bucket.instructions >= hot && bucket.noted !== bucket.eip)
    {
        bucket.due = true;
        table.due.push(bucket);
    }
}

/**
 * The buckets due since the last call, each at the address its last slice ended
 * on, marked as handed over there; a bucket ending somewhere new is due again.
 *
 * @param {ReturnType<typeof createSampleTable>} table
 * @returns {number[]}
 */
export function takeDue(table){
    const addresses = [];
    for (const bucket of table.due)
    {
        bucket.due = false;
        if (bucket.noted !== bucket.eip)
        {
            bucket.noted = bucket.eip;
            addresses.push(bucket.eip);
        }
    }
    table.due.length = 0;
    return addresses;
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
            samples: bucket.samples,
        }));
}
