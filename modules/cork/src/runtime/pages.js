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
 * read-only regions, is the owner's policy switch (`docs/core/cpu.md`).
 */

import { Tables } from './layout.js';

/** Page flag bits. */
export const PageFlag = Object.freeze({ INACCESSIBLE: 1, HAS_CODE: 2, VOLATILE: 4 });

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
 * @property {() => number} staleAddress  the address of the last store into a code page
 * @property {() => number} staleSize     and its width
 */

/**
 * @param {WebAssembly.Memory} memory
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {PageTable}
 */
export function createPageTable(memory, layout){
    // The buffer object changes when the memory grows: the view is taken afresh.
    const flags = ()=>new Uint8Array(memory.buffer, layout.tables + Tables.PAGE_FLAGS,
        Tables.PAGE_FLAGS_SIZE);
    const ranges = ()=>new Uint8Array(memory.buffer, layout.tables + Tables.CODE_RANGES,
        1 << 21);
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
            flags()[page] |= flag;
        },
        clear(page, flag){
            flags()[page] &= ~flag;
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
            const range = ranges();
            const end = address + length - 1;
            for (let page = first; page <= last; page++)
            {
                table[page] |= PageFlag.HAS_CODE;
                const from = page === first ? (address & 0xfff) >>> GRANULE : 0;
                const to = (page === last ? (end & 0xfff) >>> GRANULE : (0xfff >>> GRANULE)) + 1;
                const lo = range[page * 2];
                const hi = range[page * 2 + 1];
                range[page * 2] = hi === 0 ? from : Math.min(lo, from);
                range[page * 2 + 1] = hi === 0 ? to : Math.max(hi, to);
            }
        },
        /** No translated code on the page: the flag and the range cleared. @param {number} page */
        clearCode(page){
            flags()[page] &= ~PageFlag.HAS_CODE;
            ranges()[page * 2] = 0;
            ranges()[page * 2 + 1] = 0;
        },
        /** The page's code granules, [from, to). @param {number} page */
        codeRange(page){
            return [ranges()[page * 2], ranges()[page * 2 + 1]];
        },
        markRange(address, length, flag){
            const [first, last] = pagesOf(address, length);
            const table = flags();
            for (let page = first; page <= last; page++)
            {
                table[page] |= flag;
            }
        },
        clearRange(address, length, flag){
            const [first, last] = pagesOf(address, length);
            const table = flags();
            for (let page = first; page <= last; page++)
            {
                table[page] &= ~flag;
            }
        },
        staleAddress(){
            return new DataView(memory.buffer)
                .getUint32(layout.tables + Tables.STALE_ADDRESS, true);
        },
        staleSize(){
            return new DataView(memory.buffer)
                .getUint32(layout.tables + Tables.STALE_SIZE, true);
        },
    };
}
