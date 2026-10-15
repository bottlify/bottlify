/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page-flag table: one byte per 4 KiB page of the 4 GiB address space,
 * living in the memory at `layout.tables`, read by translated code before
 * every access (`emit/memory.js`) and written from here.
 *
 * A page beyond RAM is inaccessible from the start. A page holding translated
 * code carries HAS_CODE so a store into it leaves translated code with a
 * `stale` exit and the runtime invalidates what it translated there. The
 * null page is *not* marked: the emulator lets a program read address 0
 * today and hybrid parity keeps it so; marking it, and the memory layer's
 * read-only regions, is the owner's policy switch.
 */

import { Tables, codeRangesAt, pageFlagsAt } from './layout.js';

/**
 * Page flag bits. CLOSED marks a page holding a block with no entry inside a
 * translated region's loop, which the runtime forms copies for once translated
 * code keeps leaving for it: the interpreter tier in wasm (`interp-wasm.c`, the
 * same bit) leaves a miss of the hash there to the host, which counts it.
 * NO_EXECUTE marks a page that reads but runs nothing -- the null range: a
 * fetch there leaves the wasm tier for the host, which faults it, and nothing
 * there is translated.
 */
export const PageFlag = Object.freeze({
    INACCESSIBLE: 1, HAS_CODE: 2, VOLATILE: 4, CLOSED: 8, NO_EXECUTE: 16,
});

/** Bytes in a guest page. */
export const GUEST_PAGE = 4096;

/**
 * @typedef {Object} PageTable
 * @property {(page: number, flag: number) => void} set
 * @property {(page: number, flag: number) => void} clear
 * @property {(page: number) => number} get
 * @property {(address: number, length: number) => void} markCode  the flag and the granules
 * @property {(page: number) => void} clearCode  the flag and the range
 * @property {(page: number) => [number, number]} codeRange  the page's code granules, [from, to)
 * @property {(address: number, length: number, flag: number) => void} markRange
 *     every page any byte of the range touches (the granularity is the page)
 * @property {(address: number, length: number, flag: number) => void} clearRange
 * @property {() => number} staleAddress  the lowest byte the stores into code pages since
 *     `clearStale` wrote
 * @property {() => number} staleSize     the bytes from it to the highest, 0 when none
 * @property {() => void} clearStale
 */

/**
 * @param {WebAssembly.Memory} memory
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {ReturnType<typeof import('./shared-code.js').createSharedCode> | null} [shared]
 *     the process's record of who holds code where, when other executors share the flags: a
 *     page keeps its flag and range while any of them still holds code on it
 * @returns {PageTable}
 */
export function createPageTable(memory, layout, shared = null){
    // Growing a memory detaches its old buffer, and a view over a detached
    // buffer has no bytes: the views are taken afresh then, and only then. A
    // view made per call costs more than the lookup it serves, and the runtime
    // asks once per untranslated start. A shared memory's old buffer is not
    // detached, and its views still cover the table, which never moves.
    //
    // The flags and ranges are the process's, written by every executor: each
    // change is one atomic operation, a page's range one 16-bit pair, so two
    // executors publishing on one page at once lose neither's flag nor its
    // granules -- a lost HAS_CODE left a store into the code unseen for good.
    let flagView = new Uint8Array(0);
    let rangePairs = new Uint16Array(0);
    let words = new DataView(new ArrayBuffer(0));
    const fresh = ()=>{
        const buffer = memory.buffer;
        flagView = new Uint8Array(buffer, pageFlagsAt(layout),
            Tables.PAGE_FLAGS_SIZE);
        rangePairs = new Uint16Array(buffer, codeRangesAt(layout), 1 << 20);
        words = new DataView(buffer);
    };
    const flags = ()=>{
        if (flagView.byteLength === 0)
        {
            fresh();
        }
        return flagView;
    };
    /** The ranges as one 16-bit pair a page, low granule in the low byte. */
    const pairs = ()=>{
        if (rangePairs.byteLength === 0)
        {
            fresh();
        }
        return rangePairs;
    };
    const tableWords = ()=>{
        if (words.byteLength === 0)
        {
            fresh();
        }
        return words;
    };
    const GRANULE = Tables.CODE_GRANULE_SHIFT;
    const ramPages = Math.ceil(layout.ramSize / GUEST_PAGE);
    flags().fill(PageFlag.INACCESSIBLE, ramPages);
    /** @param {number} address @param {number} length */
    const pagesOf = (address, length)=>{
        const first = address >>> 12;
        const last = length > 0 ? (address + length - 1) >>> 12 : first;
        return [first, last];
    };
    return {
        set(page, flag){
            Atomics.or(flags(), page, flag);
        },
        clear(page, flag){
            Atomics.and(flags(), page, ~flag);
        },
        get(page){
            return flags()[page];
        },
        /**
         * Marks the bytes as translated code: the flag on every page, and
         * each page's range widened to the granules the bytes fall in.
         *
         * @param {number} address @param {number} length
         */
        markCode(address, length){
            const [first, last] = pagesOf(address, length);
            const table = flags();
            const range = pairs();
            const end = address + length - 1;
            for (let page = first; page <= last; page++)
            {
                shared?.hold(page);
                const from = page === first ? (address & 0xfff) >>> GRANULE : 0;
                const to = (page === last ? (end & 0xfff) >>> GRANULE : (0xfff >>> GRANULE)) + 1;
                // Widened before the flag says there is code, so a reader that
                // sees the flag sees the granules with it.
                for (;;)
                {
                    const was = Atomics.load(range, page);
                    const lo = was & 0xff;
                    const hi = was >>> 8;
                    const now = (hi === 0 ? from : Math.min(lo, from))
                        | (hi === 0 ? to : Math.max(hi, to)) << 8;
                    if (now === was || Atomics.compareExchange(range, page, was, now) === was)
                    {
                        break;
                    }
                }
                Atomics.or(table, page, PageFlag.HAS_CODE);
            }
        },
        /** No translated code on the page: the flag and the range cleared. @param {number} page */
        clearCode(page){
            if (shared?.release(page) === true)
            {
                // Another executor's code is still on it: its granules too, so
                // the range stays as wide as it was.
                return;
            }
            Atomics.and(flags(), page, ~PageFlag.HAS_CODE);
            Atomics.store(pairs(), page, 0);
        },
        /** The page's code granules, [from, to). @param {number} page */
        codeRange(page){
            const pair = Atomics.load(pairs(), page);
            return [pair & 0xff, pair >>> 8];
        },
        markRange(address, length, flag){
            const [first, last] = pagesOf(address, length);
            const table = flags();
            for (let page = first; page <= last; page++)
            {
                Atomics.or(table, page, flag);
            }
        },
        clearRange(address, length, flag){
            const [first, last] = pagesOf(address, length);
            const table = flags();
            for (let page = first; page <= last; page++)
            {
                Atomics.and(table, page, ~flag);
            }
        },
        staleAddress(){
            return ~tableWords().getUint32(layout.tables + Tables.STALE_LOW, true) >>> 0;
        },
        staleSize(){
            const end = tableWords().getUint32(layout.tables + Tables.STALE_END, true);
            return end === 0 ? 0 : (end - this.staleAddress()) >>> 0;
        },
        clearStale(){
            tableWords().setUint32(layout.tables + Tables.STALE_LOW, 0, true);
            tableWords().setUint32(layout.tables + Tables.STALE_END, 0, true);
        },
    };
}
