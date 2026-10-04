/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createRing } from './ring.js';

/**
 * Sound for a page that cannot share memory.
 *
 * The engine mixer writes into a ring on its own thread, and an audio worklet
 * cannot read it there. So the frames go to the worklet by message, straight
 * from this thread over a port the page made, and the worklet says back how
 * far it has played. That report is what the ring counts as consumed, and so
 * what a program's play cursor follows: frames posted but not yet heard keep
 * their room in the ring, as they would in a ring both threads could read.
 *
 * The worklet reports every few milliseconds, and each report tops the feed
 * up, so nothing here runs on a clock of its own: when the engine is busy the
 * reports wait for it, and the frames already posted are what plays meanwhile.
 * How far ahead of what was heard the feed may run is that cushion -- longer
 * than the engine ever goes without yielding, shorter than a delay a person
 * notices between a key and its sound.
 */

/** The cushion, in milliseconds of sound. */
export const FEED_AHEAD_MS = 160;

/**
 * @param {Object} options
 * @param {{ control: ArrayBufferLike, samples: ArrayBufferLike }} options.memory
 *     the engine mixer's ring storage
 * @param {number} options.channels
 * @param {any} options.port  this thread's end of the channel to the worklet
 * @param {number} options.aheadFrames
 */
export function createFeeder({ memory, channels, port, aheadFrames }){
    const ring = createRing({ channels, capacityFrames: 0, memory });
    let sent = ring.consumed();
    let posted = 0;
    let reports = 0;

    const top = ()=>{
        // A clear moved what counts as played past what was sent: what lay
        // between was thrown away and is not worth sending.
        sent = Math.max(sent, ring.consumed());
        const end = Math.min(ring.written(), ring.consumed() + aheadFrames);
        if (end <= sent)
        {
            return;
        }
        const frames = ring.peek(sent, end - sent);
        port.postMessage({ at: sent, frames }, [frames.buffer]);
        posted += end - sent;
        sent = end;
    };

    port.onmessage = (/** @type {any} */ event)=>{
        const report = event.data;
        reports++;
        ring.acknowledge(report.played);
        ring.reportStarved(report);
        top();
    };
    top();

    return {
        top,
        diagnostics: ()=>({ posted, reports, ahead: sent - ring.consumed() }),
        close(){
            port.onmessage = null;
            port.close();
        },
    };
}
