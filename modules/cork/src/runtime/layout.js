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
    HASH_SLOTS: 1 << 20,
    HASH_SLOT: 12,
    // A diagnostic block profile (`blockProfile`), past the tables
    // (`blockProfileAt`) and only in a memory a profiling host sized for it: a
    // slot per hashed block start (`blockSlot`) of its address, its executions
    // and whether another block shared the slot.
    BLOCK_SLOTS: 1 << 20,
    BLOCK_SLOT: 12,
    // Past the slots, the same run's count of each `Mechanism`, a 64-bit word
    // each: a run of minutes makes billions of calls.
    MECHANISMS: 32,
    // Past the counts, the addresses the shared transfer went to by its hash
    // probe, a slot per hashed address (`blockSlot`): the address and how
    // many times -- the jumps between regions that no direct link took.
    TRANSFER_SLOT: 8,
    BLOCK_PROFILE_SIZE: (1 << 20) * 12 + 32 * 8 + (1 << 20) * 8,
});

/**
 * What a profiling run (`blockProfile`) counts beside its blocks, by the word
 * each takes past the slots (`mechanismAt`): how calls and returns went --
 * formed into the region, a wasm call, or a way out -- and the other
 * crossings whose cost a profile of the regions' functions cannot tell apart
 * from the guest's own work.
 */
export const Mechanism = Object.freeze({
    /** A transfer through the entry hash: a call out, or a jump to another region. */
    TRANSFER: 0,
    /** A direct call to a callee formed into the region: a jump. */
    CALL_FORMED: 1,
    /** A direct call out of the region as a wasm call (`callReturn`). */
    CALL_REL: 2,
    /** An indirect call out of the region as a wasm call. */
    CALL_INDIRECT: 3,
    /** A call that leaves the region to the host's dispatch. */
    CALL_LEFT: 4,
    /** An indirect call whose target was one of the callees formed in (`callTargets`). */
    CALL_PREDICTED: 5,
    /** A wasm call that came back other than by its `ret`: an exit gone up through it. */
    CALL_ELSEWHERE: 6,
    /** A `ret` back to a call whose callee is formed in: a jump. */
    RET_FORMED: 7,
    /** A `ret` that answered the wasm call waiting for it. */
    RET_TO_CALL: 8,
    /** A `ret` that left the region to the host's dispatch. */
    RET_LEFT: 9,
    /** An `rdtsc`, each a call into the host's clock. */
    RDTSC: 10,
    // A call out of its region -- a wasm call or a way out -- by why its
    // callee was not formed in (`Apart`), so the calls forming could take in
    // are told from the ones it cannot:
    /** more blocks than a callee formed in may have; */
    APART_BLOCKS: 11,
    /** more bytes; */
    APART_BYTES: 12,
    /** a way out other than `ret` and direct branches (an API call among them); */
    APART_SHAPE: 13,
    /** a call inside a callee already formed in; */
    APART_NESTED: 14,
    /** an indirect call with no callee predicted; */
    APART_UNPREDICTED: 15,
    /** a callee that would have been formed in, but the region was full; */
    APART_FULL: 16,
    /** an indirect call to none of the callees predicted and formed in. */
    APART_MISSED: 17,
});

/** The names of `Mechanism`'s counts, by index. */
export const MECHANISM_NAMES = Object.freeze(Object.keys(Mechanism));

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
 * Where a profiling run's count of a `Mechanism` is, from the tables' start:
 * past the block profile's slots.
 *
 * @param {{ hashShift?: number }} layout @param {number} mechanism
 */
export const mechanismAt = (layout, mechanism)=>blockProfileAt(layout)
    + Tables.BLOCK_SLOTS * Tables.BLOCK_SLOT + mechanism * 8;

/**
 * Where a profiling run's slot of a transfer target is, from the tables'
 * start: past the counts of the mechanisms.
 *
 * @param {{ hashShift?: number }} layout @param {number} slot  a `blockSlot`
 */
export const transferTargetAt = (layout, slot)=>mechanismAt(layout, Tables.MECHANISMS)
    + slot * Tables.TRANSFER_SLOT;

/**
 * About one indirect call in this many is kept in the call profile's sixteen
 * pairs, picked by a hash of the count (`profileCall` in emit/integer.js): the
 * pairs then hold calls spread over the last thousand rather than the last
 * sixteen before a reading.
 */
export const CALL_STRIDE = 64;

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

/** The fields of a layout that lie in an executor's state page, each its own. */
const STATE_FIELDS = Object.freeze(['regs', 'eip', 'previousIp', 'eflags', 'flagRecord',
    'flagsChanged', 'x87', 'x87Top', 'x87Empty', 'x87Control', 'x87Status', 'x87Exact', 'xmm',
    'mxcsr', 'fsBase', 'gsBase', 'counter', 'callProfile', 'origin', 'nanFirst']);

/**
 * Where the page flags lie: the process's, which every executor of it reads and
 * writes (`executorLayout`), or the layout's own tables'.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 */
export const pageFlagsAt = layout=>layout.pageFlags ?? layout.tables + Tables.PAGE_FLAGS;

/**
 * Where the pages' code granules lie, as the page flags.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 */
export const codeRangesAt = layout=>layout.codeRanges ?? layout.tables + Tables.CODE_RANGES;

/**
 * Bytes an executor past the first keeps of a memory for its own, past the
 * first executor's: a state page -- the state block, `nanFirst`, the wasm
 * interpreter's statics -- then tables of its own, as large as the layout's.
 * Its translations, its entry hash and its call stack are its own; guest RAM
 * is the process's.
 *
 * @param {{ hashShift?: number }} layout
 */
export const executorBytes = layout=>PAGE + Math.ceil(tablesSize(layout) / PAGE) * PAGE;

/**
 * Cork's own layout moved to another executor's state page at `base`, a
 * multiple of `PAGE`: the state fields from `base` as the first executor's are
 * from 0, the tables past the page. Translated code addresses all of them by
 * constants, so a translation is the executor's own and the layout's id tells.
 * The page flags and the code granules stay the first executor's: whether a
 * page may be read, and whether a store into it reaches code some executor
 * runs, is the process's, and a store on any executor has to find it.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout  the first
 *     executor's (`ownLayout`)
 * @param {number} base
 * @returns {import('../../../core/src/layers/cpu/engine.js').StateLayout}
 */
export function executorLayout(layout, base){
    if (base % PAGE !== 0 || base < layout.tables + tablesSize(layout))
    {
        throw new Error(`layout: an executor's page at ${base} is not one past the first's`);
    }
    /** @type {Record<string, any>} */
    const fields = { ...layout };
    delete fields.id;
    for (const name of STATE_FIELDS)
    {
        if (typeof fields[name] === 'number' && fields[name] >= 0)
        {
            fields[name] += base;
        }
    }
    fields.tables = base + PAGE;
    fields.pageFlags = pageFlagsAt(layout);
    fields.codeRanges = codeRangesAt(layout);
    return /** @type {any} */ ({ ...fields, id: layoutId(fields) });
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
