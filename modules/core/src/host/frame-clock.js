/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * frame-clock - when each frame reached the canvas, in memory a page reads
 * without asking the engine.
 *
 * The presenter ticks it at the one place every frame of every API and every
 * path goes through on its way to the canvas (`presenter.js`, the canvas
 * copy); a page given the buffer reads the count and the times on its own
 * animation frames. Nothing crosses a thread and no profiler is involved: an
 * fps meter that asked the engine once a second took the engine's thread for
 * the asking, and one fed by the profiler's per-frame sampler read zero where
 * frames came through the graphics worker.
 *
 * Layout: an Int32 count of frames shown so far at the start, then a ring of
 * `SLOTS` Float64 times (`performance.now()` of the presenting thread, which
 * shares its time origin with nothing - only the gaps between them mean
 * anything) where frame n is at n % SLOTS.
 */

/** Frames the ring keeps: a little over 17 s at 60 fps. */
export const SLOTS = 1024;

const HEADER_BYTES = 8;

/** A clock to tick: its buffer goes to whoever reads it. */
export function createFrameClock(){
    const buffer = new SharedArrayBuffer(HEADER_BYTES + SLOTS * 8);
    const count = new Int32Array(buffer, 0, 1);
    const times = new Float64Array(buffer, HEADER_BYTES, SLOTS);
    return {
        buffer,
        /** @param {number} at when the frame was put on the canvas */
        tick(at){
            const n = Atomics.load(count, 0);
            times[n % SLOTS] = at;
            Atomics.store(count, 0, n + 1);
        },
        /** Frames shown so far. */
        count: ()=>Atomics.load(count, 0),
    };
}

/**
 * The frames shown so far and the times of the newest of them, oldest first:
 * at most `SLOTS`, and only those after the `since`-th frame when it is given.
 *
 * @param {SharedArrayBuffer} buffer
 * @param {number} [since]  a count read before
 * @returns {{ count: number, times: number[] }}
 */
export function readFrameClock(buffer, since = 0){
    const count = Atomics.load(new Int32Array(buffer, 0, 1), 0);
    const ring = new Float64Array(buffer, HEADER_BYTES, SLOTS);
    const from = Math.max(since, count - SLOTS + 1, 0);
    const times = [];
    for (let n = from; n < count; n++)
    {
        times.push(ring[n % SLOTS]);
    }
    return { count, times };
}
