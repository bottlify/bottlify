/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The entry map: guest address → the translated function that starts a
 * block there, and the block's label in it. What `entryOf` answers to the
 * host's slice loop, and what an invalidation removes by page.
 */

/**
 * @typedef {Object} Entry
 * @property {number} eip
 * @property {(label: number, budget: number) => number} fn   the region function
 * @property {number} label    the block's label in the function's dispatcher
 * @property {number} page     the page the block starts in
 */

export function createEntries(){
    /** @type {(Entry | null)[]} */
    const slots = [];
    /** @type {Map<number, number>} eip → slot */
    const byEip = new Map();
    /** @type {Map<number, Set<number>>} page → slots */
    const byPage = new Map();
    let live = 0;
    return {
        /**
         * Adds an entry and answers its index; an address already mapped
         * keeps its earlier entry.
         *
         * @param {number} eip @param {Entry['fn']} fn @param {number} label
         */
        add(eip, fn, label){
            const known = byEip.get(eip);
            if (known !== undefined)
            {
                return known;
            }
            const page = eip >>> 12;
            const index = slots.push({ eip, fn, label, page }) - 1;
            byEip.set(eip, index);
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
        /** @param {number} eip @returns {number} the index, or -1 */
        entryOf(eip){
            return byEip.get(eip) ?? -1;
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
            byEip.delete(entry.eip);
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
