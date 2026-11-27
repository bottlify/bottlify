/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The buffers a thread's frames cross in, taken in turn. A frame sent as
 * bytes is transferred, so the sender cannot keep its buffer; the receiver
 * copies it onto its device as the frame arrives and hands the buffer back
 * with its answer (`connect.js`'s `shown`), and the next frame of that size
 * is written into it. Two or three buffers then carry every frame instead of
 * one made per frame and left as garbage on the receiver.
 *
 * Nothing is waited on: a sender whose answers have not come back - a process
 * that blocks while it idles reads its port only when it wakes - makes a new
 * buffer and counts it (`made`). What comes back past `keep`, or at a size no
 * longer sent, is let go of (`dropped`), so the spares never outgrow the
 * rotation.
 */

/** The spares kept: one in flight, one shown and coming back, one written. */
const KEEP = 3;

/**
 * @typedef {Object} FrameRotation
 * @property {(length: number) => Uint8Array} bytes  a buffer of `length` bytes for the
 *     next frame, its contents left from an earlier one: the frame writes all of it
 * @property {(buffer: unknown) => void} give  a buffer handed back; anything else is ignored
 * @property {() => { made: number, reused: number, returned: number, dropped: number,
 *     spare: number }} figures
 */

/**
 * @param {number} [keep]  the spares kept at most
 * @returns {FrameRotation}
 */
export function createFrameRotation(keep = KEEP){
    /** @type {ArrayBuffer[]} */
    const spare = [];
    const counts = { made: 0, reused: 0, returned: 0, dropped: 0 };
    return {
        bytes(length){
            while (spare.length > 0)
            {
                const buffer = /** @type {ArrayBuffer} */ (spare.pop());
                if (buffer.byteLength === length)
                {
                    counts.reused++;
                    return new Uint8Array(buffer);
                }
                // A frame of another size: the window or mode changed, and
                // what was sent before will not be sent again.
                counts.dropped++;
            }
            counts.made++;
            return new Uint8Array(length);
        },
        give(buffer){
            if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0)
            {
                return;
            }
            counts.returned++;
            if (spare.length >= keep)
            {
                counts.dropped++;
                return;
            }
            spare.push(buffer);
        },
        figures: ()=>({ ...counts, spare: spare.length }),
    };
}
