/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A ring of slots made once and written over forever.
 *
 * Both halves of this layer record at a rate where allocation is the cost that
 * decides whether the instrument can stay on: a log call on a hot path, a phase
 * closed many times per frame. So the storage is built at construction and a
 * writer fills the slot `next()` hands back, rather than pushing a record that
 * the collector then has to take away again.
 *
 * A slot is the ring's, not the caller's. Whoever reads one and intends to keep
 * it copies what it needs before the writer laps it.
 */

/**
 * @template T
 * @typedef {Object} Ring
 * @property {number} capacity                  How many slots exist.
 * @property {() => number} written             Total ever written; also the next sequence.
 * @property {() => T} next                     The slot to fill now.
 * @property {() => number} oldest              Sequence of the oldest slot still present.
 * @property {(from: number, visit: (slot: T, sequence: number) => void) => void} each
 * @property {() => void} clear
 */

/**
 * @template T
 * @param {number} capacity
 * @param {() => T} makeSlot
 * @returns {Ring<T>}
 */
export function createRing(capacity, makeSlot){
    const size = Math.max(1, Math.floor(capacity));
    /** @type {T[]} */
    const slots = new Array(size);
    for (let index = 0; index < size; index++)
    {
        slots[index] = makeSlot();
    }
    let written = 0;

    const oldest = ()=>Math.max(0, written - size);

    return {
        capacity: size,
        written: ()=>written,
        oldest,

        next(){
            const slot = slots[written % size];
            written++;
            return slot;
        },

        /**
         * Visits every slot from `from` onwards that has not been lapped yet,
         * oldest first. A `from` that fell off the ring starts at what is left:
         * a reader that was too slow gets the surviving tail, not nothing.
         *
         * @param {number} from
         * @param {(slot: T, sequence: number) => void} visit
         */
        each(from, visit){
            for (let sequence = Math.max(from, oldest()); sequence < written; sequence++)
            {
                visit(slots[sequence % size], sequence);
            }
        },

        clear(){
            written = 0;
        },
    };
}
