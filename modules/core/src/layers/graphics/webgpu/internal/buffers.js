/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Dynamic buffers and the lock contract.
 *
 * A dynamic vertex or index buffer is locked dozens of times per frame, and the
 * flags on the lock are a promise about what the guest is going to do with the
 * bytes. Honouring them is the difference between uploading the ranges that
 * changed and uploading the whole buffer every time:
 *
 * - `DISCARD` -- the old contents are gone. The buffer is renamed, and only the
 *   bytes written since the rename have to travel.
 * - `NOOVERWRITE` -- the guest promises not to touch bytes that recorded draws
 *   still read. Nothing is renamed and the newly written ranges are enough.
 * - neither -- the guest may write anywhere. Only if a draw of a frame not yet
 *   submitted reads this buffer is that a hazard; the buffer is then renamed,
 *   and because the old contents stay observable through the new one the whole
 *   buffer has to be resent. When no such draw has read it, the write goes into
 *   the live backing and only the locked range travels, which is the ordinary
 *   case of a program that fills a buffer and then draws from it. `markRead` is
 *   how a recorder says a draw has read the current backing; the flag is
 *   dropped at `endFrame`, once the frames that read it are submitted.
 *
 * Two consequences that are easy to get subtly wrong and are asserted in the
 * tests: the uploaded range is aligned *outward*, because trimming it inward
 * loses written bytes; and it is uploaded from its own offset, not from zero.
 */

/** What the guest promised when it took the lock. */
export const LockFlags = {
    NONE: 0,
    DISCARD: 1,
    NOOVERWRITE: 2,
    /**
     * A caller that knows a recorded draw reads the bytes it is about to
     * overwrite and wants the backing renamed. Not a guest flag: a guest with
     * neither flag leaves the decision to `readSinceSubmit`, while a caller
     * that tracks the range itself says so here.
     */
    RENAME: 4,
};

/** `writeBuffer` wants both the destination offset and the size in whole words. */
export const UPLOAD_ALIGNMENT = 4;

/**
 * Grows a range to the alignment on both sides. Never inward: a byte the guest
 * wrote that falls outside the aligned range is a byte the GPU never sees.
 *
 * @param {number} start
 * @param {number} end
 * @param {number} alignment
 * @returns {{ start: number, end: number }}
 */
export function alignOutward(start, end, alignment){
    return {
        start: start - (start % alignment),
        end: Math.ceil(end / alignment) * alignment,
    };
}

/**
 * @param {Object} options
 * @param {import('../contract.js').GpuDeviceLike} options.device
 * @param {import('../contract.js').GpuQueueLike} options.queue
 * @param {number} options.size
 * @param {number} options.usage
 * @param {string} [options.label]
 * @param {number} [options.alignment]
 * @param {(label: string, bytes: number)=>void} [options.onUpload]
 * @returns {any}
 */
export function createDynamicBuffer(options){
    const alignment = options.alignment === undefined ? UPLOAD_ALIGNMENT : options.alignment;
    const label = options.label === undefined ? 'buffer' : options.label;
    // The shadow copy is padded so an outward-aligned upload of the tail cannot
    // run past the allocation.
    const capacity = Math.ceil(options.size / alignment) * alignment;
    const shadow = new Uint8Array(capacity);

    /** @type {any[]} */
    const available = [];
    // A backing retired by a rename is still read by the draws recorded before
    // it, which submit when their frame does. So it is tagged with the number
    // of frames presented before it was retired, and returns to the pool only
    // once that many frames have been submitted -- not at the next submit,
    // which with several frames in flight is one belonging to a later frame
    // that has not been drawn yet. Reusing it then is what made a textured
    // model flicker: the draw that still pointed at it read the next frame's
    // vertices instead.
    /** @type {{ gpu: any, at: number }[]} */
    const retired = [];
    let presents = 0;
    let submits = 0;
    let generation = 0;
    let renames = 0;
    let dirtyStart = -1;
    let dirtyEnd = -1;
    // Whether a draw recorded in a frame not yet submitted read the live
    // backing. A lock that would overwrite bytes such a draw still reads has to
    // rename; otherwise the write can go into the backing in place.
    let readSinceSubmit = false;
    /** @type {any} */
    let held = null;

    const allocate = ()=>options.device.createBuffer({
        label: `${label}#${generation++}`,
        size: capacity,
        usage: options.usage,
    });

    let gpu = allocate();

    const flush = ()=>{
        if (dirtyStart < 0)
        {
            return 0;
        }
        const range = alignOutward(dirtyStart, dirtyEnd, alignment);
        const bytes = Math.min(range.end, capacity) - range.start;
        options.queue.writeBuffer(gpu, range.start, shadow, range.start, bytes);
        dirtyStart = -1;
        dirtyEnd = -1;
        if (options.onUpload)
        {
            options.onUpload(label, bytes);
        }
        return bytes;
    };

    /**
     * @param {boolean} discard whether the guest gave up the old contents
     */
    const rename = discard=>{
        // Whatever is still dirty belongs to the generation being retired: draws
        // already recorded read that buffer object, not the new one.
        flush();
        retired.push({ gpu, at: presents });
        gpu = available.length > 0 ? available.shift() : allocate();
        renames++;
        // Nothing has read the replacement yet.
        readSinceSubmit = false;
        if (discard)
        {
            return;
        }
        dirtyStart = 0;
        dirtyEnd = capacity;
    };

    return {
        get gpu(){
            return gpu;
        },
        get renames(){
            return renames;
        },
        size: options.size,
        label,

        /**
         * @param {number} offset
         * @param {number} length
         * @param {number} flags
         * @returns {import('../contract.js').BufferLock}
         */
        lock(offset, length, flags){
            if (held)
            {
                throw new Error(`Buffer "${label}" is already locked`);
            }
            if (!(length > 0) || offset < 0 || offset + length > options.size)
            {
                throw new Error(
                    `Lock of ${length} bytes at ${offset} is out of range for "${label}"`
                    + ` (${options.size} bytes)`);
            }
            if (flags & LockFlags.DISCARD)
            {
                rename(true);
            }
            else if (flags & LockFlags.RENAME)
            {
                rename(false);
            }
            else if (!(flags & LockFlags.NOOVERWRITE) && readSinceSubmit)
            {
                // A draw not yet submitted read the bytes this lock may
                // overwrite, and the old contents stay observable, so the
                // backing is renamed and all of it is resent through the new
                // one.
                rename(false);
            }
            held = { data: shadow.subarray(offset, offset + length), offset, length, flags };
            return held;
        },

        /**
         * @param {import('../contract.js').BufferLock} lock
         */
        unlock(lock){
            if (!held || lock !== held)
            {
                throw new Error(`Unlock of "${label}" without a matching lock`);
            }
            const end = lock.offset + lock.length;
            dirtyStart = dirtyStart < 0 ? lock.offset : Math.min(dirtyStart, lock.offset);
            dirtyEnd = Math.max(dirtyEnd, end);
            held = null;
        },

        flush,

        /**
         * A draw of the frame being recorded reads the live backing. A later
         * lock with neither flag then has to rename instead of writing in
         * place, because the bytes it overwrites are still observed by that
         * draw at replay.
         */
        markRead(){
            readSinceSubmit = true;
        },

        /**
         * Buffers retired during a frame may still be read by draws recorded in
         * it, so they only become reusable once that frame has been submitted.
         */
        /**
         * A frame was recorded and handed to the chain. What renames retire
         * from here on belongs to it, not to the frames already in flight.
         */
        markPresent(){
            presents++;
        },

        /** A frame was submitted; the backings its draws read are free now. */
        endFrame(){
            submits++;
            // Every frame that could have read the live backing is submitted by
            // the time this runs (the replay chain is serial), so a lock is
            // free to write in place again.
            readSinceSubmit = false;
            for (let index = retired.length - 1; index >= 0; index--)
            {
                if (retired[index].at < submits)
                {
                    available.push(retired[index].gpu);
                    retired.splice(index, 1);
                }
            }
        },

        diagnostics(){
            return {
                label,
                size: options.size,
                renames,
                pooled: available.length + retired.length,
                dirty: dirtyStart < 0 ? 0 : dirtyEnd - dirtyStart,
            };
        },
    };
}
