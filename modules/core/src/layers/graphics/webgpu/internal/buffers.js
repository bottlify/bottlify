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
 * - neither -- a write into a buffer earlier draws in this frame already read is
 *   a hazard, so the buffer is renamed; but the old contents stay observable
 *   through the new one, so the whole buffer has to be resent. A rename is not
 *   a licence to send less, only `DISCARD` is.
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
    /** @type {any[]} */
    const retiredThisFrame = [];
    let generation = 0;
    let renames = 0;
    let dirtyStart = -1;
    let dirtyEnd = -1;
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
        retiredThisFrame.push(gpu);
        gpu = available.length > 0 ? available.shift() : allocate();
        renames++;
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
            else if (!(flags & LockFlags.NOOVERWRITE))
            {
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
         * Buffers retired during a frame may still be read by draws recorded in
         * it, so they only become reusable once that frame has been submitted.
         */
        endFrame(){
            while (retiredThisFrame.length > 0)
            {
                available.push(retiredThisFrame.shift());
            }
        },

        diagnostics(){
            return {
                label,
                size: options.size,
                renames,
                pooled: available.length + retiredThisFrame.length,
                dirty: dirtyStart < 0 ? 0 : dirtyEnd - dirtyStart,
            };
        },
    };
}
