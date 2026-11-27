/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Scratch memory a layer keeps between calls - the room a blit copies its
 * source into, a level decoded on its way to the GPU, a staging mirror of a
 * GPU ring - held in the run's cache, so that it is counted in the run's one
 * budget and its one report rather than kept as a heap of its own.
 *
 * A scratch grows when a call asks for more than it holds: a larger room is
 * held (rounded up to the cache's next block, a power of two from a page)
 * and the old one let go, and the room is kept for the next call, which then
 * makes nothing: a program that blits its whole screen every frame asks for
 * the same bytes every frame. Without a cache, or without room in it, the
 * room is plain memory under the same contract, counted as such.
 *
 * The view `bytes` answers is valid until the next `bytes` of the same
 * scratch, or its `release`: a caller that holds two views at once holds two
 * scratches. What the view holds is what was last written into it while the
 * scratch did not grow; a grown room holds nothing a caller may read before
 * writing it.
 */

/** The smallest room: the cache's block, one page. */
const UNIT = 4096;

/**
 * The bytes a room for `length` takes: the cache's block for it, a power of
 * two from a page, so a room held is all of the block it is placed in.
 *
 * @param {number} length
 */
export const roomFor = length=>{
    if (length > 1 << 30)
    {
        // Past any block the cache has: a room of its own size.
        return length;
    }
    const units = Math.ceil(length / UNIT);
    return units <= 1 ? UNIT : UNIT << (32 - Math.clz32(units - 1));
};

/**
 * Memory of `length` bytes held under `key`, or null where there is none to
 * hold: a `CacheSpace`'s `hold`.
 *
 * @typedef {(key: string, length: number)
 *     => { bytes: Uint8Array, release: () => void } | null} Hold
 */

/**
 * @typedef {Object} Scratch
 * @property {(length: number) => Uint8Array} bytes  a view of `length` bytes, valid until the
 *     next `bytes` of this scratch or its `release`
 * @property {() => void} release  its room let go; a later `bytes` holds one anew
 */

/**
 * @typedef {Object} ScratchFigures
 * @property {number} scratches  scratches made
 * @property {number} held  rooms held in the cache now
 * @property {number} heldBytes  their bytes
 * @property {number} plain  rooms of plain memory now: no cache, no room in it
 * @property {number} plainBytes  their bytes
 * @property {number} grows  rooms made larger, in the cache or not
 * @property {number} plainGrows  of them, those that took plain memory
 */

/**
 * The scratches of one holder of the run's cache, held through `hold`; with
 * none, every room is plain memory.
 *
 * @param {Hold | null} hold
 */
export function createScratches(hold){
    const counts = { scratches: 0, held: 0, heldBytes: 0, plain: 0, plainBytes: 0, grows: 0,
        plainGrows: 0 };
    /** The scratches holding a room now, for `releaseAll`. @type {Set<() => void>} */
    const holding = new Set();
    return {
        /**
         * A scratch named `name` within this holder's names; two of one name
         * are two scratches.
         *
         * @param {string} name @returns {Scratch}
         */
        scratch(name){
            const number = ++counts.scratches;
            /** All of the room, as held. @type {Uint8Array} */
            let room = new Uint8Array(0);
            /** The last view answered, made again only when the length asked changes. */
            let view = room;
            /** @type {(() => void) | null} */
            let letGo = null;
            let inCache = false;
            let grows = 0;
            const release = ()=>{
                if (inCache)
                {
                    counts.held--;
                    counts.heldBytes -= room.length;
                }
                else if (room.length > 0)
                {
                    counts.plain--;
                    counts.plainBytes -= room.length;
                }
                letGo?.();
                letGo = null;
                inCache = false;
                room = new Uint8Array(0);
                view = room;
                holding.delete(release);
            };
            return {
                bytes(length){
                    if (length > room.length)
                    {
                        const size = roomFor(length);
                        // A name of its own each time: the cache lets a name's
                        // earlier hold go when it is held anew, and the old
                        // room is let go here, said in the figures.
                        const got = hold?.(`${name}/${number}/${++grows}`, size) ?? null;
                        release();
                        counts.grows++;
                        if (got)
                        {
                            room = got.bytes;
                            letGo = got.release;
                            inCache = true;
                            counts.held++;
                            counts.heldBytes += size;
                        }
                        else
                        {
                            room = new Uint8Array(size);
                            counts.plain++;
                            counts.plainBytes += size;
                            counts.plainGrows++;
                        }
                        view = room;
                        holding.add(release);
                    }
                    if (view.length !== length)
                    {
                        view = room.subarray(0, length);
                    }
                    return view;
                },
                release,
            };
        },
        /** @returns {ScratchFigures} */
        figures: ()=>({ ...counts }),
        /** Every room still held let go: the holder goes. */
        releaseAll(){
            for (const release of [...holding])
            {
                release();
            }
        },
    };
}

/**
 * Scratches of plain memory, for a holder with no cache at all (`noCache`'s,
 * a part built alone in a test): what a caller that was handed no scratch
 * takes, under the same contract.
 */
export const plainScratches = createScratches(null);
