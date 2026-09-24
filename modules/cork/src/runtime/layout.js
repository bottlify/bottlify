/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where the machine's state lives in the memory translated code runs over.
 *
 * Translated code addresses every register by a constant offset, so the
 * layout is data the emitter takes rather than something it knows: the
 * core's `StateLayout` (its `engine.js`) names the fields, and this module
 * makes the two layouts cork runs with. `ownLayout` is cork's own -- a
 * state block at the start of a memory cork allocates, the guest's RAM
 * after it, cork's tables after that. The hybrid layout, read off the
 * emulator's typed views so the state block *is* the emulator's register
 * file, is built by the core's hybrid host from the same field names.
 */

/** Bytes the state block takes in cork's own layout. */
export const STATE_BLOCK_SIZE = 512;

/** A wasm page. */
export const PAGE = 65536;

/**
 * What lies at `layout.tables`, as offsets from it: the page-flag table
 * (one byte per 4 KiB page of the 4 GiB space), the address of the last
 * store into a code page, the undo ring a differential build fills
 * (a count, then entries of address, size and sixteen old bytes), and the
 * entry hash: open addressing over the guest address, slots of the
 * address, the region's index in the function table, the block's label
 * and the x87 top it was compiled for (8 for any); an empty slot holds
 * address 0, a removed one all ones. Last, two bytes per page: the first
 * and one past the last 32-byte granule of the page that holds translated
 * code, so a store into the page's data beside its code is not a store
 * into code.
 */
export const Tables = Object.freeze({
    PAGE_FLAGS: 0,
    PAGE_FLAGS_SIZE: 1 << 20,
    STALE_ADDRESS: 1 << 20,
    STALE_SIZE: (1 << 20) + 4,
    // Transfers between regions through the hash, counted when a run asks.
    TRANSFERS: (1 << 20) + 12,
    UNDO_HEAD: (1 << 20) + 8,
    UNDO_RING: (1 << 20) + 16,
    UNDO_ENTRIES: 4096,
    UNDO_ENTRY: 24,
    HASH: (1 << 20) + 16 + 4096 * 24,
    HASH_SLOTS: 262144,
    HASH_SLOT: 12,
    CODE_RANGES: (1 << 20) + 16 + 4096 * 24 + 262144 * 12,
    CODE_GRANULE_SHIFT: 5,
    SIZE: (1 << 20) + 16 + 4096 * 24 + 262144 * 12 + (1 << 21),
});

/**
 * Cork's own layout for a memory holding `ramSize` bytes of guest RAM.
 *
 * @param {{ ramSize: number }} options
 * @returns {import('../../../core/src/layers/cpu/engine.js').StateLayout}
 */
export function ownLayout({ ramSize }){
    const ramBase = PAGE;
    const fields = {
        bits: /** @type {32} */ (32),
        ramBase,
        ramSize,
        regs: 0,
        eip: 32,
        previousIp: 36,
        eflags: 40,
        flagsChanged: -1,
        x87: 64,
        x87Format: /** @type {'f64'} */ ('f64'),
        x87Top: 192,
        x87Empty: 193,
        x87Control: 194,
        x87Status: 196,
        xmm: 208,
        mxcsr: 336,
        fsBase: 340,
        gsBase: -1,
        counter: 344,
        tables: ramBase + ramSize,
        codePages: -1,
        // The entry hash's slot is the top bits of eip times the golden ratio,
        // as many as the hash has slots for (2^18).
        hashShift: 14,
    };
    return { ...fields, id: layoutId(fields) };
}

/**
 * The identity of a layout, for cache keys: every field's value, hashed.
 *
 * @param {Record<string, number | string>} fields
 */
export function layoutId(fields){
    let hash = 0x811c9dc5;
    for (const key of Object.keys(fields).sort())
    {
        for (const char of `${key}=${fields[key]};`)
        {
            hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
        }
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * How many wasm pages a memory with this layout needs.
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {number} tablesSize
 */
export function pagesFor(layout, tablesSize){
    return Math.ceil((layout.tables + tablesSize) / PAGE);
}
