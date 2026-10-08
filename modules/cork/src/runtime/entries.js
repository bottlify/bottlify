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

import { Tables } from './layout.js';

/** @param {number} eip @param {number} top */
const keyOf = (eip, top)=>eip * 16 + top;

/** The slot an address hashes to: the formula translated code probes with. */
export const slotOf = (/** @type {number} */ eip, shift = 16)=>Math.imul(eip, 0x9e3779b1) >>> shift;

const EMPTY = 0;
const REMOVED = 0xffffffff;

/**
 * @typedef {Object} Entry
 * @property {number} eip
 * @property {(label: number, budget: number, ...state: number[]) => number} fn
 *     the region function (`enterRegion` supplies the state)
 * @property {number} label    the block's label in the function's dispatcher
 * @property {number} page     the page the block starts in
 * @property {number} top      the x87 top it was compiled for, or ANY_TOP
 * @property {number} table    the region function's index in the function table, or -1
 * @property {number} slot     the entry's slot in the hash, or -1
 */

/**
 * @param {{ memory?: WebAssembly.Memory, hashBase?: number, shift?: number }} [hash]  the
 *     memory and the offset of the entry hash in it, and the layout's slot shift; without
 *     them the map alone answers
 */
export function createEntries({ memory, hashBase = -1, shift = 16 } = {}){
    const hashed = memory !== undefined && hashBase >= 0;
    // As many slots as the shift leaves bits for; past three quarters of them
    // live, entries stay in the map alone.
    const slotCount = 2 ** (32 - shift);
    const load = slotCount * 3 / 4;
    const view = ()=>new DataView(/** @type {WebAssembly.Memory} */ (memory).buffer);
    const clear = ()=>new Uint8Array(/** @type {WebAssembly.Memory} */ (memory).buffer)
        .fill(0, hashBase, hashBase + slotCount * Tables.HASH_SLOT);
    let inHash = 0;
    let removed = 0;
    if (hashed)
    {
        clear();
    }
    /** @param {number} eip @param {number} table @param {number} label @param {number} top */
    const insert = (eip, table, label, top)=>{
        if (!hashed || table < 0 || inHash >= load)
        {
            return -1;
        }
        const v = view();
        let slot = slotOf(eip, shift);
        for (;;)
        {
            const at = hashBase + slot * Tables.HASH_SLOT;
            const key = v.getUint32(at, true);
            if (key === EMPTY || key === REMOVED)
            {
                v.setUint32(at, eip, true);
                v.setUint32(at + 4, table, true);
                v.setUint16(at + 8, label, true);
                v.setUint8(at + 10, top);
                inHash++;
                if (key === REMOVED)
                {
                    removed--;
                }
                return slot;
            }
            slot = (slot + 1) & (slotCount - 1);
        }
    };
    /** @type {(Entry | null)[]} */
    const slots = [];
    /** @type {Map<number, number>} key(eip, top) → slot */
    const byEip = new Map();
    /** @type {Set<number>} addresses with an entry compiled for some top */
    const specialised = new Set();
    /**
     * Block starts some region holds but cannot enter itself -- a block the
     * x87 tracker reached with no known state, or one cut for a second top.
     * A miss at one is a candidate for a region of its own, compiled for the
     * top the machine has (`runtime.entryOf`), not a plain uncached address.
     * @type {Set<number>}
     */
    const blocked = new Set();
    /** @type {Map<number, Set<number>>} page → slots */
    const byPage = new Map();
    let live = 0;
    // The last entry found: the interpreter stops at an address it finds an
    // entry for, and the host's slice loop asks for the same one next.
    let lastEip = -1;
    let lastTop = -1;
    let lastEntry = -1;
    return {
        /**
         * Adds an entry and answers its index; an address already mapped
         * keeps its earlier entry.
         *
         * @param {number} eip @param {Entry['fn']} fn @param {number} label
         * @param {number} [top] @param {number} [table]  the region's function-table index
         */
        add(eip, fn, label, top = ANY_TOP, table = -1){
            const known = byEip.get(keyOf(eip, top));
            if (known !== undefined)
            {
                return known;
            }
            const page = eip >>> 12;
            const slot = insert(eip, table, label, top);
            const index = slots.push({ eip, fn, label, page, top, table, slot }) - 1;
            byEip.set(keyOf(eip, top), index);
            // One for the top alone comes before one for any top.
            lastEip = -1;
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
            if (eip === lastEip && top === lastTop)
            {
                return lastEntry;
            }
            const entry = byEip.get(keyOf(eip, top)) ?? byEip.get(keyOf(eip, ANY_TOP)) ?? -1;
            if (entry >= 0)
            {
                lastEip = eip;
                lastTop = top;
                lastEntry = entry;
            }
            return entry;
        },
        /** Whether some entry at the address was compiled for a top. @param {number} eip */
        isSpecialised(eip){
            return specialised.has(eip);
        },
        /**
         * Notes that a block starts here in some region but has no entry of
         * its own: entering it there is a miss the runtime should turn into a
         * region of its own, at the top the machine has.
         * @param {number} eip
         */
        noteStart(eip){
            blocked.add(eip);
        },
        /**
         * Whether some region holds a block here that has no entry of its own.
         * @param {number} eip
         */
        isBlocked(eip){
            return blocked.has(eip);
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
        /**
         * Moves an entry to another function-table index -- its region's function
         * in a relinked module -- in the map and in the hash translated code probes.
         *
         * @param {number} index @param {Entry['fn']} fn @param {number} table
         */
        retable(index, fn, table){
            const entry = slots[index];
            if (!entry)
            {
                return;
            }
            entry.fn = fn;
            entry.table = table;
            if (entry.slot >= 0)
            {
                view().setUint32(hashBase + entry.slot * Tables.HASH_SLOT + 4, table, true);
            }
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
            lastEip = -1;
            byPage.get(entry.page)?.delete(index);
            live--;
            if (entry.slot >= 0)
            {
                view().setUint32(hashBase + entry.slot * Tables.HASH_SLOT, REMOVED, true);
                inHash--;
                removed++;
                if (removed > slotCount / 4)
                {
                    // Removed slots lengthen every probe: the hash is rebuilt
                    // from the live entries.
                    clear();
                    inHash = 0;
                    removed = 0;
                    for (const kept of slots)
                    {
                        if (kept)
                        {
                            kept.slot = insert(kept.eip, kept.table, kept.label, kept.top);
                        }
                    }
                }
            }
        },
        /** How many entries the hash holds, for the diagnostics. */
        hashed(){
            return inHash;
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
