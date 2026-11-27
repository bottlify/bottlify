/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's cache as a test makes it: a Cellar keeper on this thread over a
 * small budget, a clock the test moves, and a reader of the run's, so a test
 * of a layer that keeps something in the cache sees it kept, read in place,
 * let go when idle or short of room.
 */

import { createReader, openKeeper } from '@bottlify/cellar';
import { cacheSpace, createCacheModule } from './module.js';

/**
 * @param {{ budget?: number, segmentBytes?: number, coldAfterMs?: number }} [made]
 */
export async function testCache(made = {}){
    const { budget = 64 << 20, segmentBytes = 16 << 20, coldAfterMs = 1000 } = made;
    const clock = { time: 0 };
    /** @type {import('./module.js').Reader | null} */
    let reader = null;
    /** Threads joined (`join`), told of each segment made or let go. @type {Set<(message: any) => void>} */
    const told = new Set();
    const keeper = await openKeeper({
        budget, segmentBytes, coldAfterMs, now: ()=>clock.time,
        announce: message=>{
            reader?.adopt(message);
            told.forEach(tell=>tell(message));
        },
    });
    const opened = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, options)=>keeper.reserve(name, length, options),
            raise: (name, options)=>keeper.raise(name, options),
            raiseLater: ()=>{},
            drop: name=>{
                keeper.drop(name);
            },
        } });
    reader = opened;
    return {
        keeper, clock, reader: opened,
        /**
         * The cache layer's api over this cache, as a process's layers are
         * handed it: its spaces, and the scratches and holds it keeps.
         */
        api: await createCacheModule().create({ reader: opened }),
        /** @param {string} name @param {{ onlyCopy?: boolean, idle?: 'go' | 'stay' }} [options] */
        space: (name, options)=>cacheSpace(opened, name, options),
        /**
         * Another thread joined, as the run's `join` joins one.
         * @type {import('./module.js').Join}
         */
        join: post=>{
            told.add(post);
            return { shared: keeper.shared, segments: keeper.segmentBuffers(),
                leave: ()=>told.delete(post) };
        },
        /** The clock moved and the keeper's idle sweep run. @param {number} ms */
        idle(ms){
            clock.time += ms;
            keeper.sweep();
        },
    };
}

/**
 * One roomy cache a test file's layers share, made when the file first imports
 * this: what a layer built for a test is handed where the test is not about
 * the cache itself, so that it runs over the real one, as in a run.
 */
export const roomy = await testCache({ budget: 2 ** 30, segmentBytes: 64 << 20 });

let spaces = 0;

/**
 * A space of `roomy` no other made here shares, so that what one test keeps
 * is not another's hit.
 *
 * @param {string} name @param {{ onlyCopy?: boolean, idle?: 'go' | 'stay' }} [options]
 */
export const freshSpace = (name, options)=>roomy.api.space(`${name}/${++spaces}`, options);

/**
 * What a device that draws is handed from `roomy`: names of its own for the
 * texels it keeps, and the cache's scratches and holds.
 */
export const deviceRooms = ()=>({
    texelCache: /** @type {NonNullable<ReturnType<typeof roomy.api.owner>>} */ (
        roomy.api.owner('texels')),
    scratches: (/** @type {string} */ name)=>roomy.api.scratch(name),
    holds: (/** @type {string} */ name, /** @type {number} */ length)=>roomy.api.hold(name, length),
});
