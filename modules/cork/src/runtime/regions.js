/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The region table: every published region's record (`RegionRecord`), by its
 * entry and top and by each page it spans, the blocks closed in its loops,
 * the code granules it covers on each page, and `unpublish`, which takes
 * regions out -- their entries, their function-table slots and their pages'
 * code marks. What publishes a region fills it; a store into code, an
 * eviction or a variant's switch empties it.
 */

import { PageFlag } from './pages.js';
import { Tables } from './layout.js';

/** @typedef {import('./state.js').RegionRecord} RegionRecord */

/**
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createRegions(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { codePages, entries, layout, table, view
    } = /** @type {import('./state.js').Base} */ (state);
    const { WATCH_REGIONS, counts, freeTable, leaveHeld, leaveModule, recordAt, watched } = rt;
    /** @type {Set<RegionRecord>} */
    const regions = new Set();
    /**
     * By C runtime operation (`emit/crt.js`), the calls formed as it in the
     * regions published, each publication of a region counted.
     * @type {Record<string, number>}
     */
    const crtFormed = {};
    /** @type {Map<number, RegionRecord>} entry index → the region that made it */
    const recordOf = new Map();
    /**
     * Blocks of a region that left held at their own start, entered there with nothing
     * run, by eip * 16 + the entry's top (`heldOnEntry`): no entry of their region's
     * from then on, but a region of their own.
     * @type {Set<number>}
     */
    const heldStarts = new Set();
    /**
     * A region entered at one of its inner blocks left held there, nothing run: the
     * windows the block takes from the blocks before it are tested at its start, and a
     * callee formed into its caller takes the caller's -- a store through a register
     * after the call returns. Another caller entering the callee there, with that
     * register holding something else (a loop index of 0), leaves on every call for a
     * store it never makes, its `ret` going elsewhere. The entry goes, and the block is
     * a start of a region of its own (`noteStart`), which tests only its own windows.
     * One that leaves at its own region's entry is left as it is: formed again, it would
     * test the same windows (`missAt`).
     *
     * @param {number} index  the entry run @param {import('./entries.js').Entry} one
     */
    const heldOnEntry = (index, one)=>{
        const record = recordOf.get(index);
        if (record === undefined || record.entry === one.eip
            || view().getUint32(layout.eip, true) !== one.eip)
        {
            return;
        }
        heldStarts.add(one.eip * 16 + one.top);
        entries.remove(index);
        recordOf.delete(index);
        record.slots = record.slots.filter(slot=>slot !== index);
        entries.noteStart(one.eip);
        counts.heldEntries++;
    };
    /** By the start of a block inside a structured region's loop that has no entry, the
     * regions holding it so. @type {Map<number, Set<RegionRecord>>} */
    const closedIn = new Map();
    /** By page, the closed starts on it: those pages carry `PageFlag.CLOSED`, and the
     * interpreter tier in wasm runs no miss of the hash there, which the host must count
     * (`missAt`) for the copies. @type {Map<number, number>} */
    const closedPages = new Map();
    /** @param {number} start @param {RegionRecord} record */
    const forgetClosed = (start, record)=>{
        const holders = closedIn.get(start);
        holders?.delete(record);
        if (holders?.size === 0)
        {
            closedIn.delete(start);
            const page = start >>> 12;
            const left = (closedPages.get(page) ?? 1) - 1;
            if (left > 0)
            {
                closedPages.set(page, left);
            }
            else
            {
                closedPages.delete(page);
                codePages.clear(page, PageFlag.CLOSED);
            }
        }
    };
    /** The regions to form again with copies of those blocks. @type {Set<RegionRecord>} */
    const copiesWanted = new Set();
    /** @type {Map<number, Set<RegionRecord>>} page → regions on it */
    const byPage = new Map();
    const GRANULES = 1 << (12 - Tables.CODE_GRANULE_SHIFT);
    /**
     * By code page, how many regions' extents there start at each granule and
     * end at each: the page's code range is the first start and the last end,
     * so a region that goes takes its own out rather than the range being made
     * again from every region left -- a page of small functions formed into
     * their callers holds nearly every region there is, and making its range
     * again was a pass over all of them each time one went.
     * @type {Map<number, Uint32Array>}  granule g's starts at g, its ends at GRANULES + 1 + g
     */
    const pageExtents = new Map();
    /** @param {RegionRecord} record @param {1 | -1} sign */
    const countExtents = (record, sign)=>{
        for (const [page, [from, to]] of record.extents)
        {
            let tally = pageExtents.get(page);
            if (tally === undefined)
            {
                tally = new Uint32Array(2 * GRANULES + 2);
                pageExtents.set(page, tally);
            }
            tally[from] += sign;
            tally[GRANULES + 1 + to] += sign;
        }
    };

    /**
     * Takes regions out: their entries, their function-table slots, and the
     * code marks of their pages, which keep the range of the regions still on
     * each.
     *
     * @param {RegionRecord[]} records
     */
    const unpublish = records=>{
        // The pages the dropped regions spanned, taken before the records
        // leave their sets.
        const touched = new Set(records.flatMap(record=>[...record.pages]));
        for (const record of records)
        {
            for (const slot of record.slots)
            {
                entries.remove(slot);
                recordOf.delete(slot);
            }
            if (table && record.table >= 0)
            {
                // The entries are out of the hash first: nothing finds
                // the slot before it is emptied.
                table.set(record.table, null);
                recordAt.delete(record.table);
                if (record.module === undefined)
                {
                    freeTable.push(record.table);
                }
            }
            leaveModule(record);
            leaveHeld(record);
            for (const p of record.pages)
            {
                byPage.get(p)?.delete(record);
            }
            countExtents(record, -1);
            for (const start of record.closed ?? [])
            {
                forgetClosed(start, record);
            }
            copiesWanted.delete(record);
            regions.delete(record);
        }
        for (const p of touched)
        {
            const left = byPage.get(p);
            codePages.clearCode(p);
            if (!left?.size)
            {
                watched[p] &= ~WATCH_REGIONS;
                pageExtents.delete(p);
                continue;
            }
            // The page's range from the extents of the regions still on it.
            const tally = pageExtents.get(p);
            if (tally === undefined)
            {
                continue;
            }
            let from = 0;
            while (from < GRANULES && tally[from] === 0)
            {
                from++;
            }
            let to = GRANULES;
            while (to > from && tally[GRANULES + 1 + to] === 0)
            {
                to--;
            }
            if (to > from)
            {
                codePages.markCode(p * 4096 + (from << Tables.CODE_GRANULE_SHIFT),
                    (to - from) << Tables.CODE_GRANULE_SHIFT);
            }
        }
    };
    return {
        regions,
        crtFormed,
        recordOf,
        heldStarts,
        heldOnEntry,
        closedIn,
        closedPages,
        forgetClosed,
        copiesWanted,
        byPage,
        GRANULES,
        countExtents,
        unpublish,
    };
}
