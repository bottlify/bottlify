/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How many bytes a function allocates a call, for a test that holds a hot
 * path to making no garbage: V8's sampling heap profiler, the objects
 * collected meanwhile included, over many calls, less what the same loop
 * makes around an empty function, the least of three samples. A sampled
 * estimate: a test bounds it with room for the sampler's noise (a few bytes a
 * call over thousands of calls), never asks it for an exact zero.
 */

import { Session } from 'node:inspector/promises';

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

/**
 * The bytes `body` allocates a call, measured over `calls` calls after as
 * many to warm it (so what the engine makes once, compiling it, is not
 * counted).
 *
 * @param {() => void} body
 * @param {{ calls?: number }} [options]
 * @returns {Promise<number>}
 */
export function bytesPerCall(body, { calls = 20000 } = {}){
    return measured(body, ()=>{}, calls, false);
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
 * @returns {Promise<number>}
 */
export function bytesPerAwait(body, { calls = 2000, empty = ()=>SETTLED } = {}){
    return measured(body, empty, calls, true);
}

/**
 * @param {() => void | Promise<unknown>} body @param {() => void | Promise<unknown>} empty
 * @param {number} calls @param {boolean} awaited
 * @returns {Promise<number>}
 */
async function measured(body, empty, calls, awaited){
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
        return Math.max(0, made - around) / calls;
    }
    finally
    {
        session.disconnect();
    }
}
