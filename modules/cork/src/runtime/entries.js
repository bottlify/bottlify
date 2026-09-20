/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The entry map: guest address and x87 top → the translated function that
 * starts a block there, and the block's label in it. What `entryOf` answers
 * to the host's slice loop, and what an invalidation removes by page. A
 * region without x87 instructions is entered with any top: its entries are
 * added under `ANY_TOP` and found whatever the top asked.
 */

/** The top a region indifferent to the x87 stack is registered under. */
export const ANY_TOP = 8;

/** @param {number} eip @param {number} top */
const keyOf = (eip, top)=>eip * 16 + top;

/**
 * @typedef {Object} Entry
 * @property {number} eip
 * @property {(label: number, budget: number) => number} fn   the region function
 * @property {number} label    the block's label in the function's dispatcher
 * @property {number} page     the page the block starts in
 * @property {number} top      the x87 top it was compiled for, or ANY_TOP
 */

export function createEntries(){
    /** @type {(Entry | null)[]} */
    const slots = [];
    /** @type {Map<number, number>} key(eip, top) → slot */
    const byEip = new Map();
    /** @type {Set<number>} addresses with an entry compiled for some top */
    const specialised = new Set();
    /** @type {Map<number, Set<number>>} page → slots */
    const byPage = new Map();
    let live = 0;
    return {
        /**
         * Adds an entry and answers its index; an address already mapped
         * keeps its earlier entry.
         *
         * @param {number} eip @param {Entry['fn']} fn @param {number} label
         * @param {number} [top]
         */
        add(eip, fn, label, top = ANY_TOP){
            const known = byEip.get(keyOf(eip, top));
            if (known !== undefined)
            {
                return known;
            }
            const page = eip >>> 12;
            const index = slots.push({ eip, fn, label, page, top }) - 1;
            byEip.set(keyOf(eip, top), index);
            if (top !== ANY_TOP)
            {
                specialised.add(eip);
            }
            let set = byPage.get(page);
            if (!set)
            {
                set = new Set();
                byPage.set(page, set);
            }
            set.add(index);
            live++;
            return index;
        },
        /**
         * The entry for an address at a top: compiled for that top, or for any.
         *
         * @param {number} eip @param {number} [top] @returns {number} the index, or -1
         */
        entryOf(eip, top = 0){
            return byEip.get(keyOf(eip, top)) ?? byEip.get(keyOf(eip, ANY_TOP)) ?? -1;
        },
        /** Whether some entry at the address was compiled for a top. @param {number} eip */
        isSpecialised(eip){
            return specialised.has(eip);
        },
        /** @param {number} index */
        at(index){
            const entry = slots[index];
            if (!entry)
            {
                throw new Error(`cork: entry ${index} is not live`);
            }
            return entry;
        },
        /** Removes one entry. @param {number} index */
        remove(index){
            const entry = slots[index];
            if (!entry)
            {
                return;
            }
            slots[index] = null;
            byEip.delete(keyOf(entry.eip, entry.top));
            byPage.get(entry.page)?.delete(index);
            live--;
        },
        /**
         * Drops every entry that starts in the page; answers how many.
         *
         * @param {number} page
         */
        removePage(page){
            const set = byPage.get(page);
            if (!set)
            {
                return 0;
            }
            const count = set.size;
            for (const index of [...set])
            {
                this.remove(index);
            }
            byPage.delete(page);
            return count;
        },
        count(){
            return live;
        },
    };
}
