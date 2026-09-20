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
