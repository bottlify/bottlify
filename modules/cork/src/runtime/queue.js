/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translator's candidates: the queue of addresses to form a region at,
 * in buckets by heat (the hottest formed first, the coldest evicted past
 * `maxQueued`), the addresses a region formed nothing at (`barren`), the
 * untranslated exits counted per address until one is a candidate of its own
 * (`misses`, `exitTargets`), the candidates already in a batch out
 * (`inFlight`) and the page watch that lets a write pass over pages holding
 * none of them. The run loop's `noteHot` and `missAt` feed it; forming takes
 * from it.
 */

import { ANY_TOP, keyOf } from './entries.js';

/**
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createQueue(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { counts, settings } = rt;
    /** @type {Map<number, number>} candidates not yet formed: key(eip, top) → eip */
    const queue = new Map();
    /** The candidates by heat: bucket b holds the ones whose heat (the
     * interpreter's visit count under cork, 0 from the sampler) is in
     * [2^b, 2^(b+1)), the last bucket everything from 256 up; each in arrival
     * order. A batch takes the hottest first, so a loader's run-twice code
     * waits behind the loop it ran a thousand times, and the queue is capped:
     * past `maxQueued` the coldest, oldest candidate is evicted -- the
     * interpreter keeps counting it and notes it again should it get hot.
     * @type {Map<number, number>[]} */
    const buckets = Array.from({ length: 9 }, ()=>new Map());
    /** The bucket from which a waiting candidate is hot (met eight times or more while it waits). */
    const HOT_BUCKET = 3;
    /** @type {Map<number, number>} key → its bucket */
    const heatOf = new Map();
    /** @param {number} hotness */
    const bucketOf = hotness=>{
        let b = 0;
        let h = hotness >>> 1;
        while (h > 0 && b < 8)
        {
            b++;
            h >>>= 1;
        }
        return b;
    };
    /** Removes a candidate from the queue and its bucket. @param {number} key */
    const unqueue = key=>{
        queue.delete(key);
        const b = heatOf.get(key);
        if (b !== undefined)
        {
            buckets[b].delete(key);
            heatOf.delete(key);
        }
    };
    /** Adds a candidate at its heat, evicting the coldest when the queue is full.
     * @param {number} key @param {number} eip @param {number} hotness */
    const enqueue = (key, eip, hotness)=>{
        if (queue.size >= settings.maxQueued)
        {
            for (const bucket of buckets)
            {
                if (bucket.size > 0)
                {
                    const [oldest] = bucket.keys();
                    unqueue(oldest);
                    dropKey(oldest);
                    counts.queueEvictions++;
                    break;
                }
            }
        }
        const b = bucketOf(hotness);
        noteWay(eip, 'queued');
        queue.set(key, eip);
        buckets[b].set(key, eip);
        heatOf.set(key, b);
        noteKey(key);
    };
    /** @type {Map<number, number>} key(eip, top) → eip of a candidate a region
     * formed nothing at, until its page moves. Per top: a region that formed
     * nothing at one top says nothing about a region for another -- the entry
     * block a top compiles empty is emptiness for that top alone. */
    const barren = new Map();
    /** @type {Map<number, Set<number>>} page → the queue/barren keys on it.
     * A host write invalidates its page every time, and copying two whole maps
     * per write (a loading run's writes are thousands a second) was the cost;
     * this clears a page's own keys instead. */
    const pageKeys = new Map();
    /**
     * Whether a write into a page is anything to the translator, a byte a page
     * of the address space: `WATCH_REGIONS` while a published region spans it
     * (`byPage`), `WATCH_KEYS` while a candidate or a barren address is filed
     * under it (`pageKeys`). The host invalidates every page it writes, and
     * nearly every such write is a call's answer into a stack or a buffer
     * where neither is: `invalidatePage` passes those over on this byte alone,
     * where it looked in three maps and moved the page's generation. That
     * generation is only read at a publication, of a region formed over the
     * page and published later, which the guest ran past meanwhile -- and such
     * a region is hashed again then, as for a guest store the page's code did
     * not watch.
     */
    const watched = new Uint8Array(1 << 20);
    const WATCH_REGIONS = 1;
    const WATCH_KEYS = 2;
    /** @param {number} key */
    // A key is eip * 16 + top, past 2^32 for an address above 256 MB, so its
    // page is a division rather than a shift, which would wrap there.
    const pageOfKey = key=>Math.floor(key / 65536);
    /** @param {number} key */
    const noteKey = key=>{
        const page = pageOfKey(key);
        let keys = pageKeys.get(page);
        if (!keys)
        {
            keys = new Set();
            pageKeys.set(page, keys);
            watched[page] |= WATCH_KEYS;
        }
        keys.add(key);
    };
    /** @param {number} key */
    const dropKey = key=>{
        const page = pageOfKey(key);
        const keys = pageKeys.get(page);
        if (keys)
        {
            keys.delete(key);
            if (keys.size === 0)
            {
                pageKeys.delete(page);
                watched[page] &= ~WATCH_KEYS;
            }
        }
    };
    /** Whether a candidate at this address is barren for this top.
     * @param {number} eip @param {number} top */
    const barrenHas = (eip, top)=>barren.has(keyOf(eip, top & 7));
    /** @param {number} eip @param {number} top */
    const barrenAdd = (eip, top)=>{
        if (top === ANY_TOP)
        {
            // A region indifferent to the stack is empty for every top.
            for (let t = 0; t < 8; t++)
            {
                const key = keyOf(eip, t);
                barren.set(key, eip);
                noteKey(key);
            }
            return;
        }
        const key = keyOf(eip, top & 7);
        barren.set(key, eip);
        noteKey(key);
    };
    /** Whether any top at this address is barren, for the diagnostics.
     * @param {number} eip */
    const barrenAt = eip=>{
        for (let top = 0; top < 8; top++)
        {
            if (barren.has(keyOf(eip, top)))
            {
                return true;
            }
        }
        return false;
    };
    /** @type {Map<number, number>} untranslated exits by target and top: a
     * count per key(eip, top), so misses at one top never stand in for
     * another's threshold. Keyed to the address for the histogram. */
    const misses = new Map();
    // The untranslated exits by target address over the whole run, for the
    // diagnostics' histogram: the misses are forgotten when they become
    // candidates, but what the translator never reached is exactly what this
    // is read for. Bounded like `misses`; the coldest target makes room. With
    // the count, the tops its exits were at, a bit each.
    /** @type {Map<number, { count: number, held: number, tops: number, first: number,
     *     last: number, way?: Record<string, number> }>} */
    const exitTargets = new Map();
    /** When the runtime was made, for the exits' times. */
    const bornAt = performance.now();
    /**
     * Where a target that exits waited for its translation (`way`, with
     * `timings`): the first time it was queued, taken into a batch (and the
     * batch's size), sent to a worker, answered, and published - so a stall on
     * cold code says whether the queue, the worker or the publishing held it.
     * @param {number} address @param {string} step @param {number} [value]
     */
    const noteWay = (address, step, value = Math.round(performance.now() - bornAt))=>{
        const target = exitTargets.get(address);
        if (settings.timings === true && target !== undefined)
        {
            target.way ??= {};
            target.way[step] ??= value;
        }
    };
    const EXIT_TARGETS_CAP = 4096;
    /**
     * How often the machine stood at an address that has a region for another
     * top (or a block with no entry of its own), per key(eip, top): the heat a
     * variant is noted with, so one the machine keeps arriving at climbs the
     * queue rather than waiting in its bottom bucket behind a loader's cold
     * starts while its code runs interpreted. Cleared past a cap.
     * @type {Map<number, number>}
     */
    const variantHeat = new Map();
    // How many addresses the untranslated-exit count holds at once. A real
    // program leaves for millions of addresses and the map filled in seconds;
    // the old rule stopped recording new ones once it did, so no address
    // reached after the fill could ever climb to the threshold and a
    // straight-line loader never became a candidate. The oldest is evicted
    // instead, and the counts halve every cap insertions so an address hit
    // once does not hold a slot against one hit often.
    const MISSES_CAP = 4096;
    const decayMisses = ()=>{
        for (const [key, count] of misses)
        {
            if (count <= 1)
            {
                misses.delete(key);
            }
            else
            {
                misses.set(key, count >> 1);
            }
        }
    };
    /** Candidates taken into a batch that has not published yet, by when: noted
     * again meanwhile they are not queued a second time (the interpreter keeps
     * meeting them while the batch is with the worker). A batch that never
     * comes back frees them once it is overdue.
     * @type {Map<number, number>} */
    const inFlight = new Map();
    /** When the host's event loop last came round, the two latest a tick armed here saw. */
    let turns = [0, 0];
    let tickArmed = false;
    const armTick = ()=>{
        if (tickArmed)
        {
            return;
        }
        tickArmed = true;
        setTimeout(()=>{
            tickArmed = false;
            turns = [turns[1], performance.now()];
        }, 0);
    };
    /**
     * Whether what went to the worker at `since` is overdue: past `inFlightMs`
     * by the clock, and the event loop come round twice since, in which an
     * answer already waiting would have been delivered. The clock alone gave
     * up answers that a long hold of the engine thread -- a slice, a shader's
     * compile -- had only kept in the queue, and threw their work away.
     * @param {number} since
     */
    const overdue = since=>{
        if (performance.now() - since < settings.inFlightMs)
        {
            return false;
        }
        if (turns[0] > since + settings.inFlightMs)
        {
            return true;
        }
        armTick();
        return false;
    };
    return {
        queue,
        buckets,
        HOT_BUCKET,
        heatOf,
        bucketOf,
        unqueue,
        enqueue,
        barren,
        pageKeys,
        watched,
        WATCH_REGIONS,
        WATCH_KEYS,
        dropKey,
        barrenHas,
        barrenAdd,
        barrenAt,
        misses,
        exitTargets,
        bornAt,
        noteWay,
        EXIT_TARGETS_CAP,
        variantHeat,
        MISSES_CAP,
        decayMisses,
        inFlight,
        overdue,
    };
}
