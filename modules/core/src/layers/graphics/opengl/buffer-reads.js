/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which byte ranges of one buffer object the recorded draws of frames not yet
 * flushed read: what decides whether a write into the buffer must rename it
 * (`gpu.js`, `bufferFor`).
 *
 * Two costs this keeps bounded, both of which grew with the draws a frame
 * makes:
 *
 * - **Memory.** A frame's ranges are dropped once it has flushed, at the next
 *   frame's first read of the buffer and not only when the buffer is written:
 *   a buffer drawn every frame and never written again would otherwise keep
 *   every draw's range for the life of the run.
 * - **Time per write.** A write is checked against each frame's hull before
 *   any of its ranges. A program that fills a buffer at rising offsets between
 *   its draws -- a vertex cache for one frame's generated vertices -- writes
 *   past everything the frame has read so far, and scanning the frame's ranges
 *   for each such write made a frame cost the square of its draws.
 */

/**
 * @typedef {Object} FrameReads
 * @property {number} frame
 * @property {number} start  the hull of the frame's ranges
 * @property {number} end
 * @property {number[]} spans  start/end pairs; the last one extended in place
 *           when a draw reads on from where the previous one stopped
 */

/**
 * @param {(frame: number) => boolean} unflushed  whether a frame's draws may
 *        still read the buffer's current backing
 */
export function createBufferReads(unflushed){
    /** @type {FrameReads[]} oldest first */
    const frames = [];
    let ranges = 0;
    let examined = 0;

    const prune = ()=>{
        let kept = 0;
        for (let i = 0; i < frames.length; i++)
        {
            if (unflushed(frames[i].frame))
            {
                frames[kept++] = frames[i];
            }
            else
            {
                ranges -= frames[i].spans.length / 2;
            }
        }
        if (kept < frames.length)
        {
            frames.length = kept;
        }
    };

    return {
        /**
         * A draw of `frame` reads `[start, end)`.
         *
         * @param {number} frame @param {number} start @param {number} end
         */
        note(frame, start, end){
            const last = frames.length > 0 ? frames[frames.length - 1] : null;
            if (last === null || last.frame !== frame)
            {
                prune();
                frames.push({ frame, start, end, spans: [start, end] });
                ranges++;
                return;
            }
            last.start = Math.min(last.start, start);
            last.end = Math.max(last.end, end);
            const spans = last.spans;
            const at = spans.length - 2;
            if (start <= spans[at + 1] && end >= spans[at])
            {
                spans[at] = Math.min(spans[at], start);
                spans[at + 1] = Math.max(spans[at + 1], end);
                return;
            }
            spans.push(start, end);
            ranges++;
        },

        /**
         * Whether a draw of an unflushed frame read any byte of `[start, end)`.
         *
         * @param {number} start @param {number} end
         * @returns {boolean}
         */
        overlaps(start, end){
            prune();
            for (const frameReads of frames)
            {
                if (frameReads.start >= end || start >= frameReads.end)
                {
                    continue;
                }
                const spans = frameReads.spans;
                for (let i = 0; i < spans.length; i += 2)
                {
                    examined++;
                    if (spans[i] < end && start < spans[i + 1])
                    {
                        return true;
                    }
                }
            }
            return false;
        },

        /** The backing was renamed: nothing recorded reads the new one. */
        clear(){
            frames.length = 0;
            ranges = 0;
        },

        /** The ranges held, and how many a write has been compared against in all. */
        stats: ()=>({ ranges, examined }),
    };
}
