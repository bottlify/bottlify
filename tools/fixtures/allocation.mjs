/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How many bytes a function allocates a call, for a test that holds a hot
 * path to making no garbage: V8's sampling heap profiler, the objects
 * collected meanwhile included, over many calls, less what the same loop
 * makes around an empty function. A sampled estimate: a test bounds it with
 * room for the sampler's noise (a few bytes a call over thousands of calls),
 * never asks it for an exact zero.
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
 * @param {Session} session @param {() => void} body @param {number} calls
 * @returns {Promise<number>}
 */
async function sampled(session, body, calls){
    await session.post('HeapProfiler.startSampling', { samplingInterval: INTERVAL,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < calls; i++)
    {
        body();
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
export async function bytesPerCall(body, { calls = 20000 } = {}){
    const session = new Session();
    session.connect();
    try
    {
        await session.post('HeapProfiler.enable');
        const empty = ()=>{};
        for (let i = 0; i < calls; i++)
        {
            body();
            empty();
        }
        const around = await sampled(session, empty, calls);
        const made = await sampled(session, body, calls);
        return Math.max(0, made - around) / calls;
    }
    finally
    {
        session.disconnect();
    }
}
