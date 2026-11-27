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
import { cacheSpace } from './module.js';

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
