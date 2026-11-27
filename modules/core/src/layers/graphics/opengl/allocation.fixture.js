/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { Session } from 'node:inspector/promises';

/**
 * Bytes `work` allocated, by V8's sampling heap profiler with the objects the
 * collector took meanwhile counted too: what a draw path leaves for the
 * collector, which a heap snapshot after it no longer shows. Sampled, so a
 * figure is a multiple of about `interval`; a path that allocates nothing
 * comes out at nothing or a sample or two.
 *
 * @param {() => unknown} work  awaited where it answers a promise
 * @param {{ interval?: number, within?: string }} [options]  `within`: only what
 *     functions of files whose URL holds it made themselves
 * @returns {Promise<number>}
 */
export async function bytesAllocatedBy(work, { interval = 1024, within = '' } = {}){
    const session = new Session();
    session.connect();
    try
    {
        await session.post('HeapProfiler.enable');
        await session.post('HeapProfiler.startSampling', { samplingInterval: interval,
            includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        await work();
        const { profile } = await session.post('HeapProfiler.stopSampling');
        let bytes = 0;
        /** @param {any} node */
        const walk = node=>{
            if (node.callFrame.url.includes(within))
            {
                bytes += node.selfSize;
            }
            node.children.forEach(walk);
        };
        walk(profile.head);
        return bytes;
    }
    finally
    {
        session.disconnect();
    }
}
