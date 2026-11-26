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
 * The times are a Cellar journal (`vendor/cellar/`) of one Float64 a frame
 * (`performance.now()` of the presenting thread, which shares its time origin
 * with nothing - only the gaps between them mean anything): the presenter
 * never waits for a reader, and a reader on the page is never handed a time
 * being written over.
 */

import { createJournalMemory, openJournal } from '../../vendor/cellar/cellar.js';

/** Frames the clock keeps, the one being written next included: a little over 17 s at 60 fps. */
export const SLOTS = 1024;

/** A frame's record: its time. */
const RECORD = 8;

/** @param {DataView} record */
const timeOf = record=>record.getFloat64(0, true);

/** A clock to tick: its buffer goes to whoever reads it. */
export function createFrameClock(){
    // The newest SLOTS - 1 times are read, as the ring before kept them; their
    // records (16 bytes with a journal's header) fill SLOTS * 16 bytes.
    const memory = createJournalMemory({ records: SLOTS - 1, bytes: SLOTS * 16 });
    const journal = openJournal(memory);
    return {
        buffer: /** @type {SharedArrayBuffer} */ (memory.buffer),
        /** @param {number} at when the frame was put on the canvas */
        tick(at){
            journal.draft(RECORD).setFloat64(0, at, true);
            journal.commit();
        },
        /** Frames shown so far. */
        count: ()=>journal.written(),
    };
}

/**
 * The frames shown so far and the times of the newest of them, oldest first:
 * at most `SLOTS - 1`, and only those after the `since`-th frame when it is
 * given. A time the presenter wrote over while it was read is left out.
 *
 * @param {SharedArrayBuffer} buffer
 * @param {number} [since]  a count read before
 * @returns {{ count: number, times: number[] }}
 */
export function readFrameClock(buffer, since = 0){
    const journal = openJournal({ buffer });
    const count = journal.written();
    const from = Math.max(since, journal.oldest());
    const times = [];
    for (let n = from; n < count; n++)
    {
        const time = journal.read(n, timeOf);
        if (time !== undefined)
        {
            times.push(time);
        }
    }
    return { count, times };
}
