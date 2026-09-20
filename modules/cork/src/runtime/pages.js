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
 * @property {(address: number, length: number, flag: number) => void} markRange
 *     every page any byte of the range touches (the granularity is the page)
 * @property {(address: number, length: number, flag: number) => void} clearRange
 * @property {() => number} staleAddress  the address of the last store into a code page
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
    };
}
