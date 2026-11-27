/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How many bytes a function allocates a call, for a test that holds a hot
 * path to making no garbage, as two figures. `heap`: V8's sampling heap
 * profiler, the objects collected meanwhile included, over many calls, less
 * what the same loop makes around an empty function, the least of three
 * samples. `buffers`: the backing stores of ArrayBuffers and typed arrays,
 * which live outside the JS heap - the sampler sees a 3 MiB Uint8Array as its
 * header of a few hundred bytes - read as the growth of
 * `process.memoryUsage().arrayBuffers` across each call between forced
 * collections, less the same around the empty function, the least of three.
 * Both are estimates: a test bounds them with room for noise, never
 * asks for an exact zero. A figure that cannot be read is an error, not 0.
 */

import { Session } from 'node:inspector/promises';
import { PerformanceObserver } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';

/** Bytes between two samples: small, so a few bytes a call still show. */
const INTERVAL = 64;

/**
 * Sum of the sampled bytes of `profile`'s tree.
 * @param {any} node
 * @returns {number}
 */
const total = node=>node.selfSize
    + node.children.reduce((/** @type {number} */ sum, /** @type {any} */ child)=>sum + total(child), 0);

/**
 * @param {Session} session @param {() => void | Promise<unknown>} body @param {number} calls
 * @param {boolean} awaited  each call's promise awaited before the next
 * @returns {Promise<number>}
 */
async function sampled(session, body, calls, awaited){
    await session.post('HeapProfiler.startSampling', { samplingInterval: INTERVAL,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < calls; i++)
    {
        if (awaited)
        {
            await body();
        }
        else
        {
            body();
        }
    }
    const { profile } = await session.post('HeapProfiler.stopSampling');
    return total(profile.head);
}

/** The buffer bytes are read over this many calls at most. */
const BUFFER_CALLS = 1000;

/** Forced collections a reading may take before it says it cannot answer. */
const ATTEMPTS = 16;

/** Clean calls a reading needs at least; with fewer it cannot answer. */
const ENOUGH = 16;

/** Milliseconds to wait for the gc entries of an attempt's last calls. */
const GC_ENTRY_DELAY = 50;

/** @type {(() => void) | null} */
let collect = null;

/**
 * A full collection, synchronous but for the sweep of the backing stores it frees.
 * @returns {() => void}
 */
function collector(){
    if (!collect)
    {
        v8.setFlagsFromString('--expose-gc');
        collect = vm.runInNewContext('gc');
    }
    return /** @type {() => void} */ (collect);
}

/** Milliseconds between two readings of the count while a sweep settles. */
const SWEEP_DELAY = 2;

/**
 * A forced collection and the sweep of the backing stores it freed, which
 * finishes on another thread after the collection returns: the count is
 * read until it stops falling.
 * @param {() => void} gc
 */
async function settled(gc){
    gc();
    let count = process.memoryUsage().arrayBuffers;
    for (;;)
    {
        await setTimeout(SWEEP_DELAY);
        const now = process.memoryUsage().arrayBuffers;
        if (now === count)
        {
            return;
        }
        count = now;
    }
}

/**
 * The buffer bytes `body` adds a call. Each attempt starts on a forced full
 * collection, which leaves nothing to sweep, and counts only the calls before
 * the next collection: from that one on, the count also falls by what earlier
 * calls dropped (some of it swept later, on another thread, with no gc entry
 * of its own), so a call that made 3 MiB while 3 MiB were freed would read 0.
 *
 * @param {() => void | Promise<unknown>} body @param {number} calls @param {boolean} awaited
 * @returns {Promise<number>}
 */
async function buffered(body, calls, awaited){
    const gc = collector();
    /** @type {number[]} */
    const collections = [];
    const observer = new PerformanceObserver(list=>{
        for (const entry of list.getEntries())
        {
            collections.push(entry.startTime);
        }
    });
    observer.observe({ entryTypes: ['gc'] });
    const ends = new Float64Array(calls);
    const grown = new Float64Array(calls);
    let sum = 0;
    let counted = 0;
    try
    {
        for (let attempt = 0; attempt < ATTEMPTS && counted < calls; attempt++)
        {
            await settled(gc);
            const start = performance.now();
            const want = calls - counted;
            let made = 0;
            while (made < want)
            {
                const before = process.memoryUsage().arrayBuffers;
                if (awaited)
                {
                    await body();
                }
                else
                {
                    body();
                }
                ends[made] = performance.now();
                grown[made] = process.memoryUsage().arrayBuffers - before;
                if (grown[made++] < 0)
                {
                    break;
                }
            }
            // A gc entry reaches the observer some milliseconds after the
            // collection, past the next turn of the loop.
            await setTimeout(GC_ENTRY_DELAY);
            const next = collections.reduce((first, at)=>(at > start && at < first ? at : first),
                Infinity);
            for (let i = 0; i < made && ends[i] < next && grown[i] >= 0; i++)
            {
                sum += grown[i];
                counted++;
            }
        }
    }
    finally
    {
        observer.disconnect();
    }
    if (counted < Math.min(calls, ENOUGH))
    {
        throw new Error(`buffer bytes not measured: ${counted} of ${calls} calls ran clear `
            + 'of a collection');
    }
    return sum / counted;
}

/**
 * @typedef {object} Allocation
 * @property {number} heap  bytes of JS objects a call
 * @property {number} buffers  bytes of ArrayBuffer backing stores a call
 */

/**
 * What `body` allocates a call, measured over `calls` calls after as many to
 * warm it (so what the engine makes once, compiling it, is not counted).
 *
 * @param {() => void} body
 * @param {{ calls?: number }} [options]
 * @returns {Promise<Allocation>}
 */
export function allocationPerCall(body, { calls = 20000 } = {}){
    return measured(body, ()=>{}, calls, false);
}

/**
 * The JS heap alone `body` allocates a call, for a body whose every call
 * collects garbage within itself, so that no call runs clear of a collection
 * and its buffers cannot be read (`allocationPerCall` throws "not measured"
 * for it): the caller says why at the call, and reads the buffers another way.
 *
 * @param {() => void} body
 * @param {{ calls?: number }} [options]
 * @returns {Promise<number>}
 */
export async function heapPerCall(body, { calls = 20000 } = {}){
    return (await measured(body, ()=>{}, calls, false, false)).heap;
}

/**
 * The bytes `body` allocates a call, the JS heap's and the buffers' together
 * (`allocationPerCall` gives them apart).
 *
 * @param {() => void} body
 * @param {{ calls?: number }} [options]
 * @returns {Promise<number>}
 */
export async function bytesPerCall(body, options){
    const { heap, buffers } = await allocationPerCall(body, options);
    return heap + buffers;
}

/** A promise settled once, what the empty body of an awaited loop answers. */
const SETTLED = Promise.resolve();

/**
 * The bytes an asynchronous `body` allocates a call, each call's promise
 * awaited before the next: a wait, a yield, a call answered later. Less what
 * the same loop makes awaiting a promise already settled, so what is counted
 * is the body's own, not the loop's await - or less what `empty` makes, the
 * same body without what is measured (an async function's own promise, say).
 *
 * @param {() => Promise<unknown>} body
 * @param {{ calls?: number, empty?: () => Promise<unknown> }} [options]
 * @returns {Promise<Allocation>}
 */
export function allocationPerAwait(body, { calls = 2000, empty = ()=>SETTLED } = {}){
    return measured(body, empty, calls, true);
}

/**
 * The bytes an asynchronous `body` allocates a call, the JS heap's and the
 * buffers' together (`allocationPerAwait` gives them apart).
 *
 * @param {() => Promise<unknown>} body
 * @param {{ calls?: number, empty?: () => Promise<unknown> }} [options]
 * @returns {Promise<number>}
 */
export async function bytesPerAwait(body, options){
    const { heap, buffers } = await allocationPerAwait(body, options);
    return heap + buffers;
}

/**
 * @param {() => void | Promise<unknown>} body @param {() => void | Promise<unknown>} empty
 * @param {number} calls @param {boolean} awaited
 * @param {boolean} [withBuffers]  false: the heap alone, the buffers left unread (NaN)
 * @returns {Promise<Allocation>}
 */
async function measured(body, empty, calls, awaited, withBuffers = true){
    const session = new Session();
    session.connect();
    try
    {
        await session.post('HeapProfiler.enable');
        for (let i = 0; i < calls; i++)
        {
            await body();
            await empty();
        }
        // The least of three: the sampler counts every allocation of the
        // thread, and work another test left running only ever adds to it.
        let around = Infinity;
        let made = Infinity;
        for (let round = 0; round < 3; round++)
        {
            around = Math.min(around, await sampled(session, empty, calls, awaited));
            made = Math.min(made, await sampled(session, body, calls, awaited));
        }
        if (!withBuffers)
        {
            return { heap: Math.max(0, made - around) / calls, buffers: Number.NaN };
        }
        const reads = Math.min(calls, BUFFER_CALLS);
        let bufferAround = Infinity;
        let bufferMade = Infinity;
        for (let round = 0; round < 3; round++)
        {
            bufferAround = Math.min(bufferAround, await buffered(empty, reads, awaited));
            bufferMade = Math.min(bufferMade, await buffered(body, reads, awaited));
        }
        return { heap: Math.max(0, made - around) / calls,
            buffers: Math.max(0, bufferMade - bufferAround) };
    }
    finally
    {
        session.disconnect();
    }
}
