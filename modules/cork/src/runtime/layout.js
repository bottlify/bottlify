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
 * (one byte per 4 KiB page of the 4 GiB space), the bytes the stores into
 * code pages since the runtime last looked span (the lowest address,
 * complemented so that zero is none, and one past the highest), the undo
 * ring a differential build fills
 * (a count, then entries of address, size and sixteen old bytes), and the
 * entry hash: open addressing over the guest address, slots of the
 * address, the region's index in the function table, the block's label
 * and the x87 top it was compiled for (8 for any); an empty slot holds
 * address 0, a removed one all ones. Last, two bytes per page: the first
 * and one past the last 32-byte granule of the page that holds translated
 * code, so a store into the page's data beside its code is not a store
 * into code.
 */
const CODE_RANGES = (1 << 20) + 16 + 4096 * 24;
/** The entry hash, last of the tables: its size is the layout's (`hashSlots`). */
const HASH = CODE_RANGES + (1 << 21);

export const Tables = Object.freeze({
    PAGE_FLAGS: 0,
    PAGE_FLAGS_SIZE: 1 << 20,
    STALE_LOW: 1 << 20,
    STALE_END: (1 << 20) + 4,
    // Transfers between regions through the hash, counted when a run asks.
    TRANSFERS: (1 << 20) + 12,
    UNDO_HEAD: (1 << 20) + 8,
    UNDO_RING: (1 << 20) + 16,
    UNDO_ENTRIES: 4096,
    UNDO_ENTRY: 24,
    CODE_RANGES,
    CODE_GRANULE_SHIFT: 5,
    HASH,
    /**
     * The entry hash's slots unless a layout says otherwise. A program of a
     * dozen large libraries has hundreds of thousands of block starts, and an
     * entry the hash has no room for is reached from translated code only
     * through the host: Gothic 3's filled 2^18 slots to their three quarters
     * and left translated code 42.7 million times in four minutes for
     * addresses it had translated long before.
     */
    HASH_SLOTS: 1 << 22,
    HASH_SLOT: 12,
    // A diagnostic block profile (`blockProfile`), past the tables
    // (`blockProfileAt`) and only in a memory a profiling host sized for it: a
    // slot per hashed block start (`blockSlot`) of its address, its executions
    // and whether another block shared the slot.
    BLOCK_SLOTS: 1 << 20,
    BLOCK_SLOT: 12,
    BLOCK_PROFILE_SIZE: (1 << 20) * 12,
});

/**
 * The entry hash's slots under a layout: its slot shift says how many.
 *
 * @param {{ hashShift?: number }} layout
 */
export const hashSlotsOf = layout=>2 ** (32 - (layout.hashShift ?? 16));

/**
 * The tables' bytes under a layout, the entry hash last.
 *
 * @param {{ hashShift?: number }} layout
 */
export const tablesSize = layout=>Tables.HASH + hashSlotsOf(layout) * Tables.HASH_SLOT;

/**
 * Where a profiling run's block profile starts, from the tables' start: past them.
 *
 * @param {{ hashShift?: number }} layout
 */
export const blockProfileAt = layout=>tablesSize(layout);

/**
 * The block profile's slot for a block start: the top twenty bits of the
 * address times the golden ratio.
 *
 * @param {number} address
 */
export const blockSlot = address=>Math.imul(address, 0x9e3779b1) >>> 12;

/**
 * Cork's own layout for a memory holding `ramSize` bytes of guest RAM.
 *
 * @param {{ ramSize: number, hashSlots?: number }} options  `hashSlots`: the entry
 *     hash's, a power of two (`Tables.HASH_SLOTS` unless given)
 * @returns {import('../../../core/src/layers/cpu/engine.js').StateLayout}
 */
export function ownLayout({ ramSize, hashSlots = Tables.HASH_SLOTS }){
    if (!(hashSlots >= 1 << 10 && hashSlots <= 1 << 26 && (hashSlots & (hashSlots - 1)) === 0))
    {
        throw new Error(`cork: ${hashSlots} entry hash slots is not a power of two`
            + ' from 2^10 to 2^26');
    }
    const ramBase = PAGE;
    const fields = {
        bits: /** @type {32} */ (32),
        ramBase,
        ramSize,
        regs: 0,
        eip: 32,
        previousIp: 36,
        eflags: 40,
        // The lazy flag record a region leaves (kind, result, two operands,
        // carry in), folded by whoever reads the word (`eflagsOf`).
        flagRecord: 44,
        flagsChanged: -1,
        x87: 64,
        x87Format: /** @type {'f64'} */ ('f64'),
        x87Top: 192,
        x87Empty: 193,
        x87Control: 194,
        x87Status: 196,
        // The registers holding a quadword `fild`'s integer, the integer in the
        // eight bytes past each register's double: an interpreter's run, or a
        // thread's slice, may end between the load and the store.
        x87Exact: 198,
        xmm: 208,
        mxcsr: 336,
        fsBase: 340,
        gsBase: -1,
        counter: 344,
        // The indirect calls' profile: a flag the runtime sets, a count, and
        // sixteen (address, target) pairs, the last calls made while it is set.
        callProfile: 352,
        // The budget the run started with, past the call profile's sixteen pairs.
        origin: 488,
        // Past the state block, so a thread switch does not carry it.
        nanFirst: 1024,
        tables: ramBase + ramSize,
        codePages: -1,
        // The entry hash's slot is the top bits of eip times the golden ratio,
        // as many as the hash has slots for.
        hashShift: 32 - Math.log2(hashSlots),
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
 * @param {number} bytes  the tables' and what lies past them
 */
export function pagesFor(layout, bytes){
    return Math.ceil((layout.tables + bytes) / PAGE);
}
