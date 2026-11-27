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
 * the same bytes every frame. A room the cache has none for is refused
 * (`NoRoom`, counted): no memory of another kind stands in for it.
 *
 * The view `bytes` answers is valid until the next `bytes` of the same
 * scratch, or its `release`: a caller that holds two views at once holds two
 * scratches. What the view holds is what was last written into it while the
 * scratch did not grow; a grown room holds nothing a caller may read before
 * writing it.
 *
 * A hold (`hold`) is memory of one length kept for the life of what keeps
 * it - a Direct3D 10 resource's bytes - rather than between calls: held in
 * the cache the same way, and zero, as new memory is.
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
 *     next `bytes` of this scratch or its `release`; `NoRoom` thrown where the cache has none
 * @property {() => void} release  its room let go; a later `bytes` holds one anew
 */

/**
 * Memory one object keeps for its life (`hold`): `bytes` until `release`,
 * after which it is not touched again.
 *
 * @typedef {{ bytes: Uint8Array, release: () => void }} Held
 */

/**
 * @typedef {Object} ScratchFigures
 * @property {number} scratches  scratches made
 * @property {number} holds  holds made
 * @property {number} held  rooms held in the cache now
 * @property {number} heldBytes  their bytes
 * @property {number} grows  rooms made larger
 * @property {number} refused  rooms the cache had no room for (`NoRoom`)
 */

/**
 * A room the run's cache could not give: the budget spent on memory held, or
 * a process with no cache under it. Thrown where the room was asked for, so
 * the call that needed it fails where it is seen, never handed memory of
 * another kind.
 */
export class NoRoom extends RangeError {
    /** @param {string} name @param {number} length */
    constructor(name, length){
        super(`no room in the run's cache for ${length} bytes of ${name}`);
        this.name = 'NoRoom';
    }
}

/**
 * The scratches of one holder of the run's cache, held through `hold`; with
 * none (no cache under the holder), every room refused.
 *
 * @param {Hold | null} hold
 */
export function createScratches(hold){
    const counts = { scratches: 0, holds: 0, held: 0, heldBytes: 0, grows: 0, refused: 0 };
    /** The scratches and holds holding a room now, for `releaseAll`. @type {Set<() => void>} */
    const holding = new Set();
    /** @param {string} key @param {number} size */
    const take = (key, size)=>{
        const got = hold?.(key, size) ?? null;
        if (got === null)
        {
            counts.refused++;
            throw new NoRoom(key, size);
        }
        counts.held++;
        counts.heldBytes += size;
        return got;
    };
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
            let grows = 0;
            const release = ()=>{
                if (letGo !== null)
                {
                    counts.held--;
                    counts.heldBytes -= room.length;
                    letGo();
                }
                letGo = null;
                room = new Uint8Array(0);
                view = room;
                holding.delete(release);
            };
            return {
                bytes(length){
                    if (length > room.length)
                    {
                        const size = roomFor(length);
                        release();
                        counts.grows++;
                        // A name of its own each time: the cache lets a name's
                        // earlier hold go when it is held anew.
                        const got = take(`${name}/${number}/${++grows}`, size);
                        room = got.bytes;
                        view = room;
                        letGo = got.release;
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
        /**
         * Memory of `length` bytes, zero, kept until `release`: held in the
         * cache under `name`, in a block of it, which the figures count.
         * Every hold is one of its own, two of one name included.
         *
         * @param {string} name @param {number} length @returns {Held}
         */
        hold(name, length){
            const number = ++counts.holds;
            const size = roomFor(length);
            const got = take(`${name}/${number}`, size);
            // A block of the cache holds what its last holder left in it.
            const bytes = got.bytes.subarray(0, length).fill(0);
            const release = ()=>{
                if (holding.delete(release))
                {
                    counts.held--;
                    counts.heldBytes -= size;
                    got.release();
                }
            };
            holding.add(release);
            return { bytes, release };
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

/** The scratches of a holder with no cache under it (`noCache`'s): every room refused. */
export const noScratches = createScratches(null);
