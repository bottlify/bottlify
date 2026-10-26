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
/**
 * Bytes it takes in the 64-bit layout: sixteen quadword registers and sixteen
 * XMM registers do not fit in 512. A thread's context is the whole block either way.
 */
export const STATE_BLOCK_SIZE_64 = 1024;

/** The state block's size in a layout. @param {{ bits: 32 | 64 }} layout */
export const stateBlockSize = layout=>(layout.bits === 64 ? STATE_BLOCK_SIZE_64 : STATE_BLOCK_SIZE);

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
    /** A call to a function that does nothing, returned from in the transfer (`emptyCalls`). */
    EMPTY_RETURN: 18,
    /** A call to a function that does nothing, returned from at the call (`emptySites`). */
    EMPTY_SITE: 19,
    /** A direct call that found its callee in its address's first slot and called it there. */
    CALL_LINKED: 20,
    // A jump back inside a region, by how it is taken (a jump forward is a branch, never
    // counted): what the layout of the region's blocks costs.
    /** to the head of a loop around it, a wasm loop: the budget test and a branch; */
    JUMP_LOOP: 21,
    /** through the function's dispatch: the budget test and a `br_table` on the label; */
    JUMP_DISPATCH: 22,
    /** to a block inside a loop only the region's copies hold: out of the function. */
    JUMP_OUT: 23,
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
 * Where the first executor's state page lies when guest RAM starts at the
 * memory's start (`ownLayout`'s `ramBase` 0): past the guest's first page,
 * whose reads through a null pointer -- a mixer thread's before its creator set
 * the pointer -- find the zeroes they find on a page nobody maps, and short of
 * 4 KiB in from it, so its words are reached by an arm64 load's own offset.
 */
export const LOW_STATE = 4096;

/**
 * Cork's own layout for a memory holding `ramSize` bytes of guest RAM.
 *
 * Guest RAM lies at `ramBase`: a page in, past the state page, unless the
 * guest maps nothing in its first 64 KiB -- a Windows program never does --
 * where it lies at 0 and the state page and the wasm interpreter's statics
 * lie inside that range, from `LOW_STATE`. RAM at 0 is RAM a load reaches
 * with no offset: on arm64 one instruction where the page's offset took two
 * more, and a store's bounds check -- arm64 checks a store wider than a byte,
 * which may otherwise write part of itself before it faults -- against a
 * limit one subtraction makes rather than a constant built in two.
 *
 * @param {{ ramSize: number, hashSlots?: number, processors?: number,
 *     ramBase?: number, bits?: 32 | 64 }} options
 *     `hashSlots`: the entry hash's, a power of two (`Tables.HASH_SLOTS` unless given);
 *     `processors`: the process's executors, which `cpuid` says the machine has --
 *     a field only past one, so one processor's layout, and its translations, are
 *     what they were;
 *     `ramBase`: `PAGE` (the default) or 0;
 *     `bits`: 64 for long mode's state block (`longLayout`), one executor's
 * @returns {import('../../../core/src/layers/cpu/engine.js').StateLayout}
 */
export function ownLayout({ ramSize, hashSlots = Tables.HASH_SLOTS, processors = 1,
    ramBase = PAGE, bits = 32 })
{
    if (!(hashSlots >= 1 << 10 && hashSlots <= 1 << 26 && (hashSlots & (hashSlots - 1)) === 0))
    {
        throw new Error(`cork: ${hashSlots} entry hash slots is not a power of two`
            + ' from 2^10 to 2^26');
    }
    if (ramBase !== PAGE && ramBase !== 0)
    {
        throw new Error(`cork: guest RAM at ${ramBase}, not at 0 or one page in`);
    }
    const state = ramBase === 0 ? LOW_STATE : 0;
    if (bits === 64)
    {
        if (processors > 1)
        {
            throw new Error('cork: long mode runs on one executor so far');
        }
        return longLayout(state, ramBase, ramSize, hashSlots);
    }
    const fields = {
        bits: /** @type {32} */ (32),
        ramBase,
        ramSize,
        regs: state,
        eip: state + 32,
        previousIp: state + 36,
        eflags: state + 40,
        // The lazy flag record a region leaves (kind, result, two operands,
        // carry in), folded by whoever reads the word (`eflagsOf`).
        flagRecord: state + 44,
        flagsChanged: -1,
        x87: state + 64,
        x87Format: /** @type {'f64'} */ ('f64'),
        x87Top: state + 192,
        x87Empty: state + 193,
        x87Control: state + 194,
        x87Status: state + 196,
        // The registers holding a quadword `fild`'s integer, the integer in the
        // eight bytes past each register's double: an interpreter's run, or a
        // thread's slice, may end between the load and the store.
        x87Exact: state + 198,
        xmm: state + 208,
        mxcsr: state + 336,
        fsBase: state + 340,
        gsBase: -1,
        counter: state + 344,
        // The indirect calls' profile: a flag the runtime sets, a count, and
        // sixteen (address, target) pairs, the last calls made while it is set.
        callProfile: state + 352,
        // The budget the run started with, past the call profile's sixteen pairs.
        origin: state + 488,
        // Past the state block, so a thread switch does not carry it.
        nanFirst: state + 1024,
        tables: ramBase + ramSize,
        codePages: -1,
        // The entry hash's slot is the top bits of eip times the golden ratio,
        // as many as the hash has slots for.
        hashShift: 32 - Math.log2(hashSlots),
        // Past `nanFirst` and short of the wasm interpreter's statics: a word
        // another executor stores when it needs this one's answer, which the
        // translated code reads at every back edge as the floor its budget is
        // looked at against (`spentTest`), so a slice ends there however long
        // it was given -- only where other executors run beside this one.
        ...processors > 1 ? { processors, processor: 0, interrupt: state + 2048 } : {},
    };
    return { ...fields, id: layoutId(fields) };
}

/**
 * The 64-bit state block (`STATE_BLOCK_SIZE_64`): the sixteen general
 * registers as quadwords, RIP, the flags word (eager: no record, which only
 * translated code leaves), the x87 block as the 32-bit layout has it, sixteen
 * XMM registers and FS's and GS's bases as quadwords; the counter, the call
 * profile and `origin` past them, `nanFirst` past the block.
 *
 * @param {number} state @param {number} ramBase @param {number} ramSize
 * @param {number} hashSlots
 * @returns {import('../../../core/src/layers/cpu/engine.js').StateLayout}
 */
function longLayout(state, ramBase, ramSize, hashSlots){
    const fields = {
        bits: /** @type {64} */ (64),
        ramBase,
        ramSize,
        regs: state,
        eip: state + 128,
        previousIp: state + 136,
        eflags: state + 144,
        flagsChanged: -1,
        x87: state + 160,
        x87Format: /** @type {'f64'} */ ('f64'),
        x87Top: state + 288,
        x87Empty: state + 289,
        x87Control: state + 290,
        x87Status: state + 292,
        x87Exact: state + 294,
        xmm: state + 304,
        mxcsr: state + 560,
        fsBase: state + 568,
        gsBase: state + 576,
        counter: state + 584,
        callProfile: state + 592,
        origin: state + 728,
        // Translated long-mode code's pending flag record (`long/emit.js`):
        // kind, width, two operands, result, carry in, the flags it writes.
        longFlagRecord: state + 736,
        nanFirst: state + STATE_BLOCK_SIZE_64,
        tables: ramBase + ramSize,
        codePages: -1,
        hashShift: 32 - Math.log2(hashSlots),
    };
    return { ...fields, id: layoutId(fields) };
}

/** The fields of a layout that lie in an executor's state page, each its own. */
const STATE_FIELDS = Object.freeze(['regs', 'eip', 'previousIp', 'eflags', 'flagRecord',
    'flagsChanged', 'x87', 'x87Top', 'x87Empty', 'x87Control', 'x87Status', 'x87Exact', 'xmm',
    'mxcsr', 'fsBase', 'gsBase', 'counter', 'callProfile', 'origin', 'nanFirst', 'interrupt']);

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
 * Where the first executor's state page lies, which `executorLayout` and
 * `sharedLayout` take every state field's place in a page from.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout  `ownLayout`'s
 */
export const statePageOf = layout=>layout.regs;

/**
 * A layout's fields as a state block's views read them: each state field from
 * the start of its executor's state page rather than from the memory's -- the
 * same on every executor, which a thread's context taken from one block and
 * put into another depends on.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout  `ownLayout`'s
 * @returns {import('../../../core/src/layers/cpu/engine.js').StateLayout}
 */
export function blockFields(layout){
    /** @type {Record<string, any>} */
    const fields = { ...layout };
    for (const name of STATE_FIELDS)
    {
        if (typeof fields[name] === 'number' && fields[name] >= 0)
        {
            fields[name] -= statePageOf(layout);
        }
    }
    return /** @type {any} */ (fields);
}

/**
 * Cork's own layout moved to another executor's state page at `base`, a
 * multiple of `PAGE`: the state fields from `base` as the first executor's are
 * from its own page's start, the tables past the page. Translated code addresses all of them by
 * constants, so a translation is the executor's own and the layout's id tells.
 * The page flags and the code granules stay the first executor's: whether a
 * page may be read, and whether a store into it reaches code some executor
 * runs, is the process's, and a store on any executor has to find it. The
 * executor is processor `index` of the layout's (`processors`), the one `cpuid`
 * names to code translated for it.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout  the first
 *     executor's (`ownLayout`)
 * @param {number} base
 * @param {number} [index]  which executor: 1 for the first past the process's own
 * @returns {import('../../../core/src/layers/cpu/engine.js').StateLayout}
 */
export function executorLayout(layout, base, index = 1){
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
            fields[name] += base - statePageOf(layout);
        }
    }
    fields.tables = base + PAGE;
    if (layout.processors !== undefined)
    {
        if (!(index >= 1 && index < layout.processors))
        {
            throw new Error(`layout: executor ${index} of ${layout.processors}`);
        }
        fields.processor = index;
    }
    fields.pageFlags = pageFlagsAt(layout);
    fields.codeRanges = codeRangesAt(layout);
    return /** @type {any} */ ({ ...fields, id: layoutId(fields) });
}

/**
 * The process's shared layout over `layout`, its first executor's (`ownLayout`): the
 * state fields where they are in every executor's state page, the tables at 0 --
 * both offsets from the bases each instance is given (`emit/bases.js`) -- and the
 * page flags and code granules where they are, the process's own. A translation
 * made for it runs on every executor of the process, so it is made, kept and
 * compiled once; its id is the same on all of them. No processor is named in it:
 * which executor runs a translation is not known when it is made.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {import('../../../core/src/layers/cpu/engine.js').StateLayout}
 */
export function sharedLayout(layout){
    if (layout.pageFlags !== undefined)
    {
        throw new Error('layout: the shared layout is made from the first executor\'s');
    }
    /** @type {Record<string, any>} */
    const fields = { ...layout };
    delete fields.id;
    delete fields.processor;
    // Each field where it lies in a state page, from the page's start.
    for (const name of STATE_FIELDS)
    {
        if (typeof fields[name] === 'number' && fields[name] >= 0)
        {
            fields[name] -= statePageOf(layout);
        }
    }
    // The other executors are not interrupted: the process ends a chain of
    // their slices at a slice's end (`goOn`), and their back edges stay as
    // one executor's are.
    delete fields.interrupt;
    fields.pageFlags = pageFlagsAt(layout);
    fields.codeRanges = codeRangesAt(layout);
    fields.tables = 0;
    fields.shared = true;
    return /** @type {any} */ ({ ...fields, id: layoutId(fields) });
}

/**
 * Where an executor's state block and tables are, as the shared layout's
 * instances are given them: `layout` is the executor's own (`executorLayout`).
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {{ stateBase: number, tablesBase: number }}
 */
export const basesOf = layout=>({ stateBase: layout.regs, tablesBase: layout.tables });

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
