/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Memory access in translated code: the page-flag test before every load
 * and store, the precise fault it leads to, the `stale` exit after a store
 * into a page that holds translated code, and the undo log a differential
 * build records before every store.
 *
 * Every access goes through the wasm memory's own bounds check as well; the
 * page test is what makes a fault precise (a wasm trap unwinds the function
 * and the registers held in locals with it), what makes a store into
 * translated code visible, and what will carry the memory layer's
 * protections. The test is a shift, a halfword load and a branch per access,
 * or per window of accesses (see the groups below).
 */

import { registerLocal } from './width.js';
import { Body, EMPTY, ValType } from '../wasm/encoder.js';
import { DF } from '../decode/table.js';
import { isX87Opcode } from '../decode/decoder.js';
import { Tables, codeRangesAt, pageFlagsAt } from '../runtime/layout.js';
import { PageFlag, STORE_FLAGS } from '../runtime/pages.js';
import { I32, I64 } from './flags.js';
import { Exit, Local } from './region.js';
import { atTables } from './bases.js';

/** @typedef {import('./region.js').RegionEmitter} E */

/**
 * The vector of an untranslated exit that goes back to the host rather than
 * through the epilogue's hash probe (`transfer` probes only a bare
 * untranslated code).
 */
export const HELD = 1;

/**
 * The vector of an untranslated exit a region compiled for the wide precision
 * controls (`wide`) takes when it finds single precision set: back to the
 * host, which runs the instruction and has the runtime translate with the
 * rounding from then on.
 */
export const PRECISION = 2;

/**
 * Whether an instruction that only reads is left untested, its address wrapped
 * into RAM (`wrapIntoRam`): not under `precise`, nor `checkReads`, where a page
 * the program cannot read faults.
 *
 * @param {{ precise?: boolean, checkReads?: boolean }} context
 */
export function readsWrapped(context){
    return context.precise !== true && context.checkReads !== true;
}

/**
 * Wraps the address in the i32 local `addr` into RAM for a read left
 * untested: with RAM a power of two, one `and`; with any other size, an
 * address past RAM is taken modulo the largest power of two below it, and one
 * inside RAM is left as it is, without a branch. Both read RAM where the
 * access would have raised #GP. A RAM of 1.5 or 3 GB tested every read before
 * (the access's page flags loaded and tested, an exit for the fault): a load
 * was 46 bytes of wasm. The long-mode emitter wraps its reads the same way.
 *
 * @param {import('./region.js').RegionEmitter['b']} b
 * @param {number} ramSize
 * @param {number} [addr]  the local, the 32-bit emitter's `Local.addr` unless given
 */
export function wrapIntoRam(b, ramSize, addr = Local.addr){
    if ((ramSize & ramSize - 1) === 0)
    {
        b.localGet(addr).i32const(ramSize - 1).op(I32.and).localSet(addr);
        return;
    }
    const below = 2 ** Math.floor(Math.log2(ramSize));
    b.localGet(addr);
    b.localGet(addr).i32const(below - 1).op(I32.and);
    b.localGet(addr).i32const(ramSize | 0).op(I32.ltU);
    b.select().localSet(addr);
}

/**
 * Whether the current instruction's access goes untested, its address wrapped
 * into RAM. Outside `precise` an instruction that only reads is not tested: the
 * one page flag a read can find is INACCESSIBLE, which only the pages past RAM
 * carry, so its address is wrapped into RAM instead (`wrapIntoRam`), in place of
 * a shift, a load and a branch. A read past the end of guest memory then reads
 * RAM where it raised #GP -- in long mode one past the 4 GiB window too, as a
 * 32-bit address wraps at 4 GiB.
 *
 * @param {E} e @param {boolean} store
 */
export function wrapsRead(e, store){
    return !store && readsWrapped(e.context) && e.layout.codePages < 0 && readsOnly(e.current);
}

/**
 * The flags of the page whose index is on the stack, as `type` loads them:
 * on an arm64 host the table's address joined to the index by `or` where its
 * low 20 bits are clear, which an arm64 `orr` takes as an immediate where an
 * offset that large is a constant moved into a register and an add; as the
 * load's offset otherwise, which an x86-64 load takes into its address for
 * nothing (V8 14.6: a store's test 6 instructions with the `or`, 5 without).
 *
 * @param {E} e @param {number} table @param {'i32_8u' | 'i32_16u'} type
 */
function loadFlags(e, table, type){
    const { b } = e;
    if ((table & 0xfffff) === 0 && e.context.features?.armHost === true)
    {
        return b.i32const(table | 0).op(I32.or).load(type, { offset: 0 });
    }
    return b.load(type, { offset: table });
}

/**
 * Stores whose code note `checkAccess` already made, by the instruction they
 * belong to: `noteStore` for that instruction only keeps the undo log.
 *
 * @type {WeakMap<E, object>}
 */
const noted = new WeakMap();

/**
 * With the address of a `size`-byte access in `addr`: reads the page flags
 * of its first and its last byte into `pflags` and leaves with #GP, before
 * the instruction, when either page is inaccessible.
 *
 * The common case is one test: the flags of the access's page and of the
 * next one, read as a halfword (the last byte lies in one of the two),
 * against INACCESSIBLE -- and for `store` against HAS_CODE and WATCH too
 * (`STORE_FLAGS`), the store's code note and its mark of a watched page made
 * here rather than in a second test in `noteStore`. The bits stand in every
 * byte of the mask, which tests a halfword's two all the same and is one an
 * arm64 `tst` holds in the instruction.
 * Only when a flag is up are the last byte's own flags read, so an access
 * beside an unmapped page or a code page is neither a fault nor a note
 * unless it reaches it.
 *
 * In long mode (`window`, the whole address in `t64`, `windowAddress`) the
 * address's high half is joined to that test: an access past the 4 GiB
 * window finds a flag up, and the test under it faults. One that starts
 * inside the window and ends past it starts on the window's last page, which
 * no RAM reaches (`longLayout`), so its own flags fault it.
 *
 * @param {E} e @param {number} size
 * @param {{ counted?: boolean, store?: boolean, window?: boolean }} [options]  `counted`
 *     false inside a `rep` loop, where the instruction is not counted and a fault
 *     leaves at it without uncounting; `store` when the access is only
 *     written and its `noteStore` follows with no exit between; `window` for long
 *     mode's address (`windowAddress`)
 */
export function checkAccess(e, size, { counted = true, store = false, window = false } = {}){
    const { b } = e;
    if (planned(e, size, store))
    {
        // The group's test covered the window too.
        return;
    }
    if (wrapsRead(e, store))
    {
        if (window)
        {
            windowTest(e, size, counted);
        }
        wrapIntoRam(b, e.layout.ramSize);
        return;
    }
    const table = pageFlagsAt(e.layout);
    const noting = store && e.layout.codePages < 0 && size <= 16;
    const bits = PageFlag.INACCESSIBLE | (noting ? STORE_FLAGS : 0);
    b.localGet(Local.addr).i32const(12).op(I32.shrU);
    loadFlags(e, table, size > 1 ? 'i32_16u' : 'i32_8u')
        .localTee(Local.pflags).i32const(size > 1 ? bits * 0x01010101 : bits).op(I32.and);
    if (window)
    {
        b.localGet(Local.t64).i64const(32n).op(I64.shrU).op(I64.wrap).op(I32.or);
    }
    e.openGuard('flagged', EMPTY);
    if (window)
    {
        b.localGet(Local.t64).i64const(32n).op(I64.shrU).op(I64.wrap);
        e.openGuard('beyond', EMPTY);
        faultHere(e, counted);
        e.close();
    }
    if (size > 1)
    {
        b.localGet(Local.addr).i32const(12).op(I32.shrU).load('i32_8u', { offset: table });
        b.localGet(Local.addr).i32const(size - 1).op(I32.add).i32const(12).op(I32.shrU)
            .load('i32_8u', { offset: table }).op(I32.or).localSet(Local.pflags);
    }
    b.localGet(Local.pflags).i32const(PageFlag.INACCESSIBLE).op(I32.and);
    e.openGuard('inaccessible', EMPTY);
    faultHere(e, counted);
    e.close();
    if (noting)
    {
        b.localGet(Local.pflags).i32const(STORE_FLAGS).op(I32.and);
        e.openGuard('maybeCode', EMPTY);
        noteCodeStore(e, size);
        e.close();
        noted.set(e, e.current);
    }
    e.close();
}

/**
 * Before a store of `size` bytes at `addr`, whose page flags `checkAccess`
 * left in `pflags`: records the old bytes when the module keeps an undo
 * log, and when the page holds translated code notes the address and
 * raises `stale`, which the block turns into a `stale` exit right after the
 * instruction (`emitStaleExit`) and every other exit folds in.
 *
 * @param {E} e @param {number} size
 */
export function noteStore(e, size){
    const { b } = e;
    if (e.context.undo !== undefined)
    {
        b.localGet(Local.addr).i32const(size).call(e.context.undo);
    }
    const plan = e.memPlan;
    if (plan !== null && plan.used)
    {
        // The group's check at its first access tested this store against
        // code, to the granule.
        if (!plan.store)
        {
            throw new Error(`memory plan: ${e.current.op} at ${e.current.eip.toString(16)} stores`);
        }
        return;
    }
    if (noted.get(e) === e.current)
    {
        noted.delete(e);
        return;
    }
    if (e.layout.codePages < 0)
    {
        // Only this engine's code to look for: `checkAccess` left both pages'
        // flags in `pflags`, and a store to a page without code -- nearly
        // every store -- goes on with no call.
        b.localGet(Local.pflags);
        if (size > 16)
        {
            // A state save (fsave, fnstenv): its access was checked at the
            // operand's size, so its last page's flags are read here.
            b.localGet(Local.addr).i32const(size - 1).op(I32.add).i32const(12).op(I32.shrU)
                .load('i32_8u', { offset: pageFlagsAt(e.layout) }).op(I32.or);
        }
        // The next page's flag too: a wide access's halfword holds it.
        b.i32const(STORE_FLAGS * 0x01010101).op(I32.and);
        e.openGuard('maybeCode', EMPTY);
        noteCodeStore(e, size);
        e.close();
        return;
    }
    noteCodeStore(e, size);
}

/**
 * The granule test of a store and the `stale` note when it hits code.
 *
 * @param {E} e @param {number} size
 */
function noteCodeStore(e, size){
    const { b } = e;
    // This engine's own code, to the granule: the page's flag and then its
    // range, for the store's first byte, its last, and one byte in every
    // granule between -- a state save (`fnsave`) spans several.
    b.localGet(Local.addr).call(e.context.codeHit);
    const granule = 1 << Tables.CODE_GRANULE_SHIFT;
    for (let at = granule; at < size - 1; at += granule)
    {
        b.localGet(Local.addr).i32const(at).op(I32.add).call(e.context.codeHit).op(I32.or);
    }
    if (size > 1)
    {
        b.localGet(Local.addr).i32const(size - 1).op(I32.add).call(e.context.codeHit).op(I32.or);
    }
    if (e.layout.codePages >= 0)
    {
        // The other executor's own table too, for the store's first page and
        // its last: its compiled page is as much code as this engine's, and
        // the runtime dirties its cache.
        b.localGet(Local.addr).i32const(12).op(I32.shrU)
            .load('i32_8u', { offset: e.layout.codePages }).op(I32.or);
        if (size > 1)
        {
            b.localGet(Local.addr).i32const(size - 1).op(I32.add).i32const(12).op(I32.shrU)
                .load('i32_8u', { offset: e.layout.codePages }).op(I32.or);
        }
    }
    e.openGuard('code', EMPTY);
    b.i32const(1).localSet(Local.stale);
    // The span grows rather than being overwritten: one instruction stores
    // into code more than once before the exit after it -- a `rep movs` or
    // `rep stos` element after element, page after page; `pushad` across two
    // pages -- and every page each store reached is code to drop.
    const low = e.layout.tables + Tables.STALE_LOW;
    const end = e.layout.tables + Tables.STALE_END;
    // Unsigned maxima of the complemented lowest byte and of the end, each
    // read twice: no scratch local is free across every store's emission.
    const higher = (/** @type {() => void} */ value, /** @type {number} */ offset)=>{
        atTables(e.context, b);
        value();
        atTables(e.context, b).load('i32', { offset });
        value();
        atTables(e.context, b).load('i32', { offset }).op(I32.gtU);
        b.select().store('i32', { offset });
    };
    higher(()=>b.localGet(Local.addr).i32const(-1).op(I32.xor), low);
    higher(()=>b.localGet(Local.addr).i32const(size).op(I32.add), end);
    e.close();
    e.staleCheck = true;
}

/**
 * Adds the helper `codeHit(address) -> 0|1`: whether the byte lies in
 * translated code -- its page flagged, and its 32-byte granule within the
 * page's code range. A store's every flagged page comes here, so here too a
 * watched page is marked written (`PageFlag.WATCH` to `WRITTEN`, as
 * `markWritten` does): in one compare-and-swap on a memory other executors
 * share, a plain store on one only this one writes.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {boolean} [shared]  whether the memory is shared
 * @returns {number} the function index
 */
export function addCodeHitHelper(m, layout, shared = false){
    const type = m.type({ params: [ValType.i32], results: [ValType.i32] });
    const b = new Body();
    const flags = pageFlagsAt(layout);
    const ranges = codeRangesAt(layout);
    // local 1: the page; local 2: the granule; local 3: the page's flags
    b.localGet(0).i32const(12).op(I32.shrU).localSet(1);
    b.localGet(1).load('i32_8u', { offset: flags }).localTee(3)
        .i32const(PageFlag.WATCH).op(I32.and);
    b.if(EMPTY);
    /** The flags with the page marked written. */
    const marked = ()=>b.localGet(3).i32const(~PageFlag.WATCH & 0xff).op(I32.and)
        .i32const(PageFlag.WRITTEN).op(I32.or);
    if (shared)
    {
        b.block(EMPTY);
        b.loop(EMPTY);
        b.localGet(1).localGet(3);
        marked();
        b.atomic('cmpxchg_i32_8', { offset: flags }).localTee(2);
        b.localGet(3).op(I32.eq).brIf(1);
        // Changed under it: tried again while still watched.
        b.localGet(2).localTee(3).i32const(PageFlag.WATCH).op(I32.and).op(I32.eqz).brIf(1);
        b.br(0);
        b.end();
        b.end();
    }
    else
    {
        b.localGet(1);
        marked();
        b.store('i32_8', { offset: flags });
    }
    b.end();
    b.localGet(3).i32const(PageFlag.HAS_CODE).op(I32.and);
    b.op(I32.eqz);
    b.if(EMPTY);
    b.i32const(0).op(0x0f); // return
    b.end();
    b.localGet(0).i32const(Tables.CODE_GRANULE_SHIFT).op(I32.shrU)
        .i32const(0xfff >>> Tables.CODE_GRANULE_SHIFT).op(I32.and).localSet(2);
    b.localGet(2).localGet(1).i32const(1).op(I32.shl).load('i32_8u', { offset: ranges })
        .op(I32.geU);
    b.localGet(2).localGet(1).i32const(1).op(I32.shl).load('i32_8u', { offset: ranges + 1 })
        .op(I32.ltU);
    b.op(I32.and);
    return m.function(type, [ValType.i32, ValType.i32, ValType.i32], b.toBytes());
}

/**
 * Adds the helper `spanHit(lo, hi) -> 0|1`: whether a store to the bytes `lo`
 * to `hi` reaches translated code -- `codeHit` at `lo`, at every 32 bytes past
 * it and at `hi`, so one byte of every granule the bytes lie in.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m @param {number} codeHit
 * @returns {number} the function index
 */
export function addSpanHitHelper(m, codeHit){
    const type = m.type({ params: [ValType.i32, ValType.i32], results: [ValType.i32] });
    const b = new Body();
    // local 2: the granules past `lo` still to look at, counted rather than
    // compared, so a span that wraps at 4 GiB ends.
    b.localGet(1).localGet(0).op(I32.sub).i32const(5).op(I32.shrU).localSet(2);
    b.loop(EMPTY);
    b.localGet(0).call(codeHit);
    b.if(EMPTY);
    b.i32const(1).op(0x0f); // return
    b.end();
    b.localGet(2);
    b.if(EMPTY);
    b.localGet(0).i32const(32).op(I32.add).localSet(0);
    b.localGet(2).i32const(1).op(I32.sub).localSet(2);
    b.br(1);
    b.end();
    b.end();
    b.localGet(1).call(codeHit);
    return m.function(type, [ValType.i32], b.toBytes());
}

/**
 * Adds the helper `windowHit(address, last, from, to) -> 0|1`, the test of an
 * access group's window once its pages are flagged (`emitGroupChecks`):
 * whether the page of its first byte or of its byte `last` past it is
 * inaccessible, or a store to its bytes `from` to `to` past it reaches
 * translated code (none when `from` is past `to`).
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {number} spanHit
 * @returns {number} the function index
 */
export function addWindowHitHelper(m, layout, spanHit){
    const i32 = ValType.i32;
    const type = m.type({ params: [i32, i32, i32, i32], results: [i32] });
    const b = new Body();
    const flags = pageFlagsAt(layout);
    b.localGet(0).i32const(12).op(I32.shrU).load('i32_8u', { offset: flags });
    b.localGet(0).localGet(1).op(I32.add).i32const(12).op(I32.shrU)
        .load('i32_8u', { offset: flags });
    b.op(I32.or).i32const(PageFlag.INACCESSIBLE).op(I32.and);
    b.if(EMPTY);
    b.i32const(1).op(0x0f); // return
    b.end();
    b.localGet(2).localGet(3).op(I32.gtS);
    b.if(EMPTY);
    b.i32const(0).op(0x0f); // return
    b.end();
    b.localGet(0).localGet(2).op(I32.add);
    b.localGet(0).localGet(3).op(I32.add);
    b.call(spanHit);
    return m.function(type, [], b.toBytes());
}

/**
 * The bytes a group's stores write, past its window's first, as the fewest
 * spans: stores that touch or overlap are one span.
 *
 * @param {{ off: number, size: number, store: boolean }[]} list @param {number} lo
 * @returns {[number, number][]}  each span's first byte and its last
 */
function storeSpans(list, lo){
    /** @type {[number, number][]} */
    const spans = [];
    const stores = list.filter(access=>access.store)
        .map(access=>[access.off - lo, access.off - lo + access.size - 1])
        .sort((x, y)=>x[0] - y[0]);
    for (const [from, to] of stores)
    {
        const last = spans[spans.length - 1];
        if (last !== undefined && from <= last[1] + 1)
        {
            last[1] = Math.max(last[1], to);
        }
        else
        {
            spans.push([from, to]);
        }
    }
    return spans;
}

// --- the region's access groups ---
//
// Most accesses go off a register the code does not change in between -- a
// frame through esp or ebp, a struct through one pointer, an array through a
// base and an index -- or off an address in the instruction. Such a group's
// accesses lie in a window known from the register values at its first
// access, and a window of at most 4096 bytes spans at most two pages. So the
// group is checked once, at its first access: the flags of its page and the
// next against INACCESSIBLE and, for a group that stores, HAS_CODE and WATCH
// -- then, only when one is up, the window's own pages and the stores'
// granules, through `codeHit`, which marks a watched page written and goes
// on. A clean window leaves every access of the group with no test at all.
// A window that would fault or note a store into code leaves the region
// before that first access, untranslated, and the interpreter runs on from
// there with a check on every access: the fault is raised at its
// instruction and the note made at its store, as they would be here.
//
// A group reaches past its block into the blocks that take their windows
// from it (`planRegion`): what is accessible changes inside a run only in the
// host's trap, which no such edge crosses, and a store into code leaves at
// once. The planner follows what each register holds -- a value it cannot
// see into, moved by known amounts, copied by `mov` and `lea` -- so a frame
// through esp and ebp is one window, and so is a struct whose pointer moved
// to another register. A block entered any other way -- the dispatch,
// another region, the host -- tests, before its first instruction, the part
// of those windows it and the blocks after it reach, placed from what the
// registers hold at its start, and leaves untranslated there when it is not
// clean. The plan is made from the decoded operands before the region is
// emitted, and the emitter's own calls are held to it -- an access the plan
// did not foresee, or a store it took for a load, is an error rather than a
// check left out.

/** Integer operations whose memory destination is read and written. */
const INT_RW = new Set([
    'add', 'sub', 'adc', 'sbb', 'and', 'or', 'xor', 'inc', 'dec', 'not', 'neg',
    'shl', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr', 'shld', 'shrd',
]);
/** Integer operations whose memory source is read. */
const INT_READ = new Set([
    'mov', 'movzx', 'movsx', 'movsxd', 'add', 'sub', 'adc', 'sbb', 'and', 'or', 'xor', 'cmp',
    'test', 'imul', 'bsf', 'bsr', 'cvttss2si', 'cvtss2si', 'cvttsd2si', 'cvtsd2si',
]);
/** Integer operations that write their first operand and no other register. */
const INT_WRITE_DST = new Set([
    ...INT_RW, 'mov', 'movzx', 'movsx', 'movsxd', 'imul', 'bsf', 'bsr', 'bswap',
    'cvttss2si', 'cvtss2si', 'cvttsd2si', 'cvtsd2si', 'movmskps', 'movmskpd', 'pmovmskb',
]);
/** Integer operations that write no register. */
const INT_PURE = new Set(['cmp', 'test', 'nop', 'bt']);
const X87_LOAD = new Set([
    'fld', 'fild', 'fadd', 'fsub', 'fsubr', 'fmul', 'fdiv', 'fdivr', 'fcom', 'fcomp',
    'fiadd', 'fisub', 'fisubr', 'fimul', 'fidiv', 'fidivr', 'ficom', 'ficomp', 'fldcw',
]);
const X87_STORE = new Set(['fst', 'fstp', 'fist', 'fistp', 'fisttp', 'fnstcw', 'fnstsw']);
const SSE_STORE = new Set([
    'movaps', 'movups', 'movapd', 'movupd', 'movdqa', 'movdqu', 'movss', 'movsd',
    'movlps', 'movlpd', 'movhps', 'movhpd', 'movq', 'movd', 'movntps', 'movntpd', 'movntdq',
]);
/** The string instructions by the pointers they move. */
const STRING_POINTERS = new Map([
    ['movs', [6, 7]], ['cmps', [6, 7]], ['lods', [6]], ['stos', [7]], ['scas', [7]],
]);
/**
 * The accesses each string instruction makes through its pointers, in the
 * order the emitter makes them: `[register, store]`.
 *
 * @type {Map<string, [number, boolean][]>}
 */
const STRING_ACCESSES = new Map([
    ['movs', [[6, false], [7, true]]], ['cmps', [[6, false], [7, false]]], ['lods', [[6, false]]],
    ['stos', [[7, true]]], ['scas', [[7, false]]],
]);
/** What `leave` reads: the saved ebp the frame pointer points at. */
const SAVED_EBP = /** @type {import('../decode/decoder.js').Operand} */ ({
    kind: 'mem', size: 4, base: 5, index: -1, scale: 1, disp: 0, segment: 3, addressSize: 32,
});
/** Long mode's: the saved rbp. */
const SAVED_RBP = /** @type {import('../decode/decoder.js').Operand} */ ({
    ...SAVED_EBP, size: 8, addressSize: 64,
});

/**
 * @typedef {{ block: number, i: number, off: number, size: number, store: boolean }} Access
 *     the access of instruction `i` of a block: `off` from the values the
 *     group's registers held where the group began
 * @typedef {{ base: number, index: number, scale: number, db: number, di: number,
 *     first: number, list: Access[], lo: number, width: number }} Group
 *     a window as tested: `base` and `index` the registers it is computed from
 *     there, `db` and `di` their offsets from those values
 * @typedef {Group & { block: number, depth: number, baseSym: number, indexSym: number,
 *     hi: number }} Growing
 *     a group being planned: the block it begins in, that block's depth in
 *     the tree of blocks taking windows, and the values it follows
 * @typedef {{ checks: Group[], access: Access | null, size: number, store: boolean,
 *     used: boolean }} Planned
 * @typedef {{ blocks: Map<number, Planned>[], entry: Group[][], inherit: number[] }} RegionPlan
 *     per block: its instructions' plans, the windows tested when it is entered
 *     other than from the block it takes them from, and that block (-1 for none)
 * @typedef {{ base: number, index: number, scale: number, disp: number, size: number,
 *     store: boolean }} Place
 * @typedef {Map<number, { group: Growing, access: Access }[]>} Joined
 *     a block's accesses by instruction, each with the group it joined
 * @typedef {{ sym: number[], delta: number[], next: { n: number }, isym?: number[],
 *     iscale?: number[], cuts?: Cut[] }} Values
 *     what each register holds: a value the planner cannot see into (`sym`),
 *     moved by a known amount (`delta`); in a long-mode loop's plan also
 *     another such value times a scale (`isym`, -1 for none, `iscale`), and
 *     the points where a dword write cut a value to its low half (`cuts`)
 * @typedef {{ sym: number, isym: number, iscale: number, d: number }} Cut
 *     a value a dword write took or made: the model holds it only while it
 *     lies in [0, 2^32)
 */

/**
 * The one access an instruction makes that a group can take, or null.
 *
 * @param {import('../decode/decoder.js').Instruction} ins
 * @param {4 | 8} [word]  the stack's slot: 8 in long mode, whose addresses a
 *     32-bit address size truncates (such an access is left to its own test)
 * @returns {{ operand: import('../decode/decoder.js').Operand | null, size: number,
 *     store: boolean, stack: number } | null}
 *     `stack`: the access's offset from esp for a push or pop, else 0
 */
function accessOf(ins, word = 4){
    const { op, operands } = ins;
    const [dst] = operands;
    if (ins.prefixes.operand && (op === 'call' || op === 'ret' || op === 'leave'))
    {
        return null;
    }
    if (op === 'call' && (dst.kind === 'rel' || dst.kind === 'reg'))
    {
        return { operand: null, size: word, store: true, stack: -word };
    }
    if (op === 'ret')
    {
        return { operand: null, size: word, store: false, stack: 0 };
    }
    if (op === 'leave')
    {
        return { operand: word === 8 ? SAVED_RBP : SAVED_EBP, size: word, store: false, stack: 0 };
    }
    if (op === 'push' && ins.size === word
        && (dst.kind === 'imm' || dst.kind === 'reg' && dst.size === word))
    {
        return { operand: null, size: word, store: true, stack: -word };
    }
    if (op === 'pop' && dst.kind === 'reg' && dst.size === word)
    {
        return { operand: null, size: word, store: false, stack: 0 };
    }
    const at = operands.findIndex(o=>o.kind === 'mem');
    if (at < 0 || operands.some((o, k)=>k !== at && o.kind === 'mem'))
    {
        return null;
    }
    const mem = operands[at];
    if (mem.addressSize === (word === 8 ? 32 : 16) || mem.segment === 4 || mem.segment === 5
        || ins.prefixes.rep
        || ins.prefixes.repne || ins.prefixes.lock)
    {
        return null;
    }
    /** @param {boolean} store */
    const access = store=>({ operand: mem, size: mem.size, store, stack: 0 });
    if (isX87Opcode(ins.opcode))
    {
        return X87_LOAD.has(op) ? access(false) : X87_STORE.has(op) ? access(true) : null;
    }
    if (operands.some(o=>o.kind === 'xmm') && !operands.some(o=>o.kind === 'mm'))
    {
        return at > 0 ? access(false) : SSE_STORE.has(op) ? access(true) : null;
    }
    if (operands.some(o=>o.kind === 'mm' || o.kind === 'xmm' || o.kind === 'seg'))
    {
        return null;
    }
    if (at === 0)
    {
        if ((op === 'shl' || op === 'shr' || op === 'sar') && operands[1].kind === 'imm'
            && (/** @type {number} */ (operands[1].value) & 31) === 0)
        {
            // A shift by a constant zero is no instruction at all to the emitter.
            return null;
        }
        if (op === 'mov' || op.startsWith('set'))
        {
            return access(true);
        }
        return INT_RW.has(op) ? access(true) : op === 'cmp' || op === 'test' ? access(false) : null;
    }
    return at === 1 && (INT_READ.has(op) || op.startsWith('cmov')) ? access(false) : null;
}

/**
 * Whether an instruction's memory operand is only read: an instruction whose
 * one access reads (`accessOf`), or a `jmp`, `call` or `push` through memory,
 * which reads its operand and stores, if at all, only to the stack -- a store
 * with a check of its own. A read and write of one operand (`add [m], r`) is
 * not: the read's test is the write's.
 *
 * @param {import('../decode/decoder.js').Instruction} ins
 */
export function readsOnly(ins){
    if (accessOf(ins)?.store === false)
    {
        return true;
    }
    const { op, operands } = ins;
    return (op === 'jmp' || op === 'call' || op === 'push') && operands[0]?.kind === 'mem';
}

/**
 * The accesses of an instruction a group can take: `accessOf`'s one, or the
 * two of a `push`, `call` or `jmp` through memory -- the operand read, then
 * the push.
 *
 * @param {import('../decode/decoder.js').Instruction} ins @param {4 | 8} [word]  (`accessOf`)
 * @returns {Place[]}
 */
function groupAccessesOf(ins, word = 4){
    const { op, operands, prefixes } = ins;
    if (!ins.memory && !STACK_OPS.has(op))
    {
        return NO_PLACES;
    }
    const [dst] = operands;
    if ((op === 'push' || op === 'call' || op === 'jmp') && dst?.kind === 'mem'
        && dst.size === word && !prefixes.operand && dst.addressSize !== (word === 8 ? 32 : 16)
        && dst.segment !== 4 && dst.segment !== 5)
    {
        const read = placeOf({ operand: dst, size: word, store: false, stack: 0 });
        return op === 'jmp' ? [read]
            : [read, placeOf({ operand: null, size: word, store: true, stack: -word })];
    }
    const access = accessOf(ins, word);
    return access === null ? NO_PLACES : [placeOf(access)];
}

/** The operations that reach the stack with no memory operand. */
const STACK_OPS = new Set(['push', 'pop', 'call', 'ret', 'leave']);
/** @type {Place[]} */
const NO_PLACES = [];

/**
 * Where an access lies: its registers, scale and displacement.
 *
 * @param {{ operand: import('../decode/decoder.js').Operand | null, size: number,
 *     store: boolean, stack: number }} access
 * @returns {Place}
 */
function placeOf({ operand, size, store, stack }){
    if (operand === null)
    {
        return { base: 4, index: -1, scale: 1, disp: stack, size, store };
    }
    const index = operand.index ?? -1;
    return { base: operand.base ?? -1, index, scale: index < 0 ? 1 : operand.scale ?? 1,
        disp: operand.disp ?? 0, size, store };
}

/**
 * The access groups of a region's blocks (see the section's head): per
 * block, the plan of each instruction -- the groups checked before it and
 * its own access -- and the windows to test when the block is entered other
 * than from the block it takes them from.
 *
 * @param {import('../region.js').Block[]} blocks  in address order
 * @param {{ entry?: number, backward?: boolean, heads?: Set<number>,
 *     returns?: Map<number, number[]>, reach?: boolean, masked?: boolean,
 *     long?: boolean }} [options]  entry:
 *     the region's entry; backward: a jump back can carry windows (the dispatch
 *     takes an inner label for it); heads: blocks that take none (a
 *     structured region's loop heads); returns: by ret block, the return
 *     addresses it jumps to (`inlineReturns`); reach: false keeps every group
 *     within its block; masked: a read is wrapped into RAM rather than tested
 *     (`checkAccess`): a group that only reads is no window, and a store is
 *     one on its own; long: long mode's sixteen registers and quadword stack slots
 * @returns {RegionPlan}
 */
export function planRegion(blocks, options = {}){
    const { entry = blocks[0]?.start ?? 0, backward = false, heads = new Set(),
        returns = new Map(), reach = true, masked = false, long = false } = options;
    const word = long ? 8 : 4;
    const regs = long ? 16 : 8;
    const inherit = reach ? inheritance(blocks, entry, backward, heads, returns)
        : blocks.map(()=>-1);
    // Most blocks take nothing and give nothing: what each keeps is made
    // only when it has something to keep.
    /** @type {(number[] | undefined)[]} */
    const children = [];
    inherit.forEach((p, s)=>{
        if (p >= 0)
        {
            (children[p] ??= []).push(s);
        }
    });
    const next = { n: 0 };
    /** @type {Growing[]} */
    const groups = [];
    /** @type {(Joined | undefined)[]} by block: each instruction's accesses and their groups */
    const joined = [];
    /** @type {(Place[][] | undefined)[]} by block and instruction: `groupAccessesOf`, which
     * the entry tests ask again for every block below one that has them */
    const placesOf = [];
    /**
     * Values split off at a block's start (`split`): the value each was, the
     * amount it was moved by, and that block's depth.
     * @type {Map<number, { sym: number, delta: number, depth: number }>}
     */
    const aliases = new Map();
    // Two registers holding one value at the start of a block that takes
    // windows were made so before it, which an entry from elsewhere does not
    // keep: a group begun in the block or after it that took both would be
    // tested from one and trusted for the other. All but the first are given
    // values of their own, aliases of what they held, and a group begun
    // before the block is still reached through an alias (its accesses there
    // are the entry test's).
    /** @param {Values} values @param {number} depth */
    const split = (values, depth)=>{
        const { sym, delta } = values;
        for (let r = 1; r < regs; r++)
        {
            for (let q = 0; q < r; q++)
            {
                if (sym[q] === sym[r])
                {
                    const own = values.next.n++;
                    aliases.set(own, { sym: sym[r], delta: delta[r], depth });
                    sym[r] = own;
                    delta[r] = 0;
                    break;
                }
            }
        }
    };
    /**
     * @param {number} s @param {Values} values @param {Map<number, Growing>} open
     * @param {number} depth
     */
    const walk = (s, values, open, depth)=>{
        if (depth > 0)
        {
            split(values, depth);
        }
        const { instructions } = blocks[s];
        /** @type {Place[][]} */
        const blockPlaces = placesOf[s] = [];
        for (let i = 0; i < instructions.length; i++)
        {
            const ins = instructions[i];
            const places = groupAccessesOf(ins, word);
            blockPlaces.push(places);
            for (let k = 0; k < places.length; k++)
            {
                const { base, index, scale, disp, size, store } = places[k];
                const baseSym = base < 0 ? -1 : values.sym[base];
                const indexSym = index < 0 ? -1 : values.sym[index];
                const db = base < 0 ? 0 : values.delta[base];
                const di = index < 0 ? 0 : values.delta[index];
                let off = disp + db + di * scale;
                const key = groupKey(baseSym, indexSym, scale);
                let group = open.get(key);
                if (group === undefined && aliases.size > 0)
                {
                    // A group begun before the block that split the value off.
                    let by = off;
                    for (let alias = aliases.get(baseSym); alias !== undefined;
                        alias = aliases.get(alias.sym))
                    {
                        by += alias.delta;
                        const older = open.get(groupKey(alias.sym, indexSym, scale));
                        if (older !== undefined && older.depth < alias.depth)
                        {
                            group = older;
                            off = by;
                            break;
                        }
                    }
                }
                if (group === undefined
                    || Math.max(group.hi, off + size) - Math.min(group.lo, off) > 4096)
                {
                    off = disp + db + di * scale;
                    group = { base, index, scale, db, di, first: i, block: s, depth, baseSym,
                        indexSym, list: [], lo: off, hi: off + size, width: 0 };
                    groups.push(group);
                    open.set(key, group);
                }
                group.lo = Math.min(group.lo, off);
                group.hi = Math.max(group.hi, off + size);
                const access = { block: s, i, off, size, store };
                group.list.push(access);
                const rows = joined[s] ??= new Map();
                const row = rows.get(i);
                if (row === undefined)
                {
                    rows.set(i, [{ group, access }]);
                }
                else
                {
                    row.push({ group, access });
                }
            }
            effect(ins, values, false, word);
        }
        // The last child goes on with the values and groups themselves:
        // nothing after it needs them.
        const kids = children[s] ?? [];
        for (let k = 0; k < kids.length; k++)
        {
            const last = k === kids.length - 1;
            walk(kids[k], last ? values : copyValues(values), last ? open : new Map(open),
                depth + 1);
        }
    };
    inherit.forEach((p, s)=>{
        if (p < 0)
        {
            walk(s, freshValues(next, regs), new Map(), 0);
        }
    });
    // A window's test costs what one access's does, where its exit is the
    // block's one and its slow test out of line; a single access's own test
    // carries its fault's exit and its code note inline, and the `stale` exit
    // after the instruction. Where reads are wrapped into RAM (`masked`) a
    // window is a store's, even of one access, and a read is never one.
    const kept = new Set(groups.filter(group=>(masked
        ? group.list.some(access=>access.store) : group.list.length >= 2)));
    // What each block's entry test covers: every access of a kept group in
    // the block or after it whose window was opened before it.
    /** @type {(Set<Access> | undefined)[]} */
    const reached = [];
    for (const group of kept)
    {
        for (const access of group.list)
        {
            for (let s = access.block; s !== group.block && s >= 0; s = inherit[s])
            {
                (reached[s] ??= new Set()).add(access);
            }
        }
    }
    /** @type {Set<Access>} accesses left to their own test (`entryTests`) */
    const dropped = new Set();
    const entries = blocks.map((_, s)=>{
        const covered = reached[s];
        return covered === undefined ? NO_TESTS
            : entryTests({ blocks, children, joined, placesOf, next, word }, s, covered, dropped);
    });
    /** @type {(Map<number, Planned> | undefined)[]} */
    const plans = [];
    /** @param {number} s @param {number} i */
    const at = (s, i)=>{
        const plan = plans[s] ??= new Map();
        let slot = plan.get(i);
        if (slot === undefined)
        {
            slot = { checks: [], access: null, size: 0, store: false, used: false };
            plan.set(i, slot);
        }
        return slot;
    };
    for (const group of kept)
    {
        group.width = group.hi - group.lo;
        at(group.block, group.first).checks.push(group);
    }
    joined.forEach((rows, s)=>rows?.forEach((pairs, i)=>{
        // Every access of the instruction in a kept group, of one size: the
        // plan cannot tell two of them apart, so it takes all or none.
        if (pairs.every(({ group, access })=>kept.has(group)
            && !dropped.has(access) && access.size === pairs[0].access.size))
        {
            const slot = at(s, i);
            slot.access = pairs[0].access;
            slot.size = pairs[0].access.size;
            slot.store = pairs.some(({ access })=>access.store);
        }
    }));
    return { blocks: blocks.map((_, s)=>plans[s] ?? NO_PLAN), entry: entries, inherit };
}

/**
 * A plan for a second function emitted from it (a region's copies): the
 * instructions' slots anew, whose `used` the emitting marks; the groups and the
 * accesses, which nothing writes, shared.
 *
 * @param {RegionPlan} plan
 * @returns {RegionPlan}
 */
export function copyPlan(plan){
    return {
        ...plan,
        blocks: plan.blocks.map(slots=>(slots === NO_PLAN ? slots
            : new Map([...slots].map(([i, slot])=>[i, { ...slot }])))),
    };
}

/** The plan of a block with no access planned; read, never written. */
/** @type {Map<number, Planned>} */
const NO_PLAN = new Map();
/** @type {Group[]} */
const NO_TESTS = [];
/** @type {number[]} */
const NO_TARGETS = [];

/**
 * A group's key: the values its base and index hold, and its scale.
 *
 * @param {number} baseSym @param {number} indexSym @param {number} scale
 */
function groupKey(baseSym, indexSym, scale){
    return ((baseSym + 1) * 0x1000000 + indexSym + 1) * 4 + (31 - Math.clz32(scale));
}

/**
 * The access groups of one block's instructions, by the instruction each
 * group is checked at and the instruction each access belongs to.
 *
 * @param {import('../decode/decoder.js').Instruction[]} instructions
 * @returns {Map<number, Planned>}
 */
export function planBlock(instructions){
    const block = { start: 0, end: 0, instructions,
        exit: { kind: /** @type {'cut'} */ ('cut'), targets: [], next: 0, backEdge: false } };
    return planRegion([block], { reach: false }).blocks[0];
}

/**
 * Which block each block takes windows from, or -1. Every other way into
 * the block -- the dispatch, another region, the way on past a trap, another
 * block of the region -- goes through its entry test, so the choice is only
 * of the way in the test is spared: the one way in where there is one; else,
 * unless a jump back reaches the block too, the block before it, else the
 * first block before it that jumps there. A call carries windows into its
 * callee with its push, and a formed-in return back to the block after the
 * call; a switch's jump carries none (it is taken from within its
 * instruction), nor a trap's way on, whose host call may change what is
 * accessible. The entry and a block that loops onto itself take none, and the
 * latter gives none either (its registers at its end are many turns'); a
 * jump back carries windows only where `backward` says the dispatch can take
 * it.
 *
 * @param {import('../region.js').Block[]} blocks @param {number} entry
 * @param {boolean} backward @param {Set<number>} heads
 * @param {Map<number, number[]>} returns  by ret block's start: the return
 *     addresses it jumps to inside the region
 * @returns {number[]}
 */
function inheritance(blocks, entry, backward, heads, returns){
    const count = blocks.length;
    /** @type {number[]} */
    const inherit = new Array(count).fill(-1);
    if (count < 2)
    {
        return inherit;
    }
    /** @type {Map<number, number>} */
    const index = new Map();
    const loops = new Uint8Array(count);
    for (let s = 0; s < count; s++)
    {
        index.set(blocks[s].start, s);
        loops[s] = loopsOnto(blocks[s]) ? 1 : 0;
    }
    // Each block's ways in: `2 * p + 1` for one that carries windows, `2 * p`
    // for one that does not.
    /** @type {number[][]} */
    const into = blocks.map(()=>[]);
    /** @param {number} p @param {number | undefined} target @param {boolean} carries */
    const edge = (p, target, carries)=>{
        const s = target === undefined ? undefined : index.get(target);
        if (s !== undefined)
        {
            into[s].push(2 * p + (carries ? 1 : 0));
        }
    };
    for (let p = 0; p < count; p++)
    {
        const block = blocks[p];
        const { kind, targets, next, table } = block.exit;
        if (kind === 'fallthrough' || kind === 'jump' || kind === 'call')
        {
            // The block after a call is reached by the callee's return.
            edge(p, targets[0], true);
        }
        else if (kind === 'jcc' || kind === 'loop')
        {
            edge(p, targets[0], true);
            edge(p, targets[1] ?? next, true);
        }
        else if (kind === 'trap')
        {
            edge(p, next, false);
        }
        for (const target of returns.get(block.start) ?? NO_TARGETS)
        {
            edge(p, target, true);
        }
        for (const target of table?.entries ?? NO_TARGETS)
        {
            edge(p, target, false);
        }
    }
    /** Whether a block takes its windows from its one way in. */
    const sole = new Uint8Array(count);
    for (let s = 0; s < count; s++)
    {
        const ways = into[s];
        if (ways.length === 0 || loops[s] === 1 || heads.has(s) || blocks[s].start === entry)
        {
            continue;
        }
        let one = true;
        let later = false;
        let before = -1;
        let lowest = -1;
        for (const way of ways)
        {
            const p = way >> 1;
            one &&= p === ways[0] >> 1;
            later ||= p >= s;
            if ((way & 1) === 1 && p !== s && loops[p] === 0 && (p < s || backward))
            {
                before = p === s - 1 ? p : before;
                lowest = lowest < 0 || p < lowest ? p : lowest;
            }
        }
        if (lowest < 0)
        {
            continue;
        }
        if (one)
        {
            sole[s] = 1;
            inherit[s] = lowest;
        }
        // A block a jump back reaches besides may be a loop's head, whose
        // turns would all pay the test, or the join of a way that comes back
        // rarely: it chooses none.
        else if (!later)
        {
            inherit[s] = before >= 0 ? before : lowest;
        }
    }
    // A chain that closes on itself (a loop whose blocks each take from the
    // one before) is cut at a block that had a choice: the one that took its
    // windows from a single way in keeps them.
    // Only a block taking from one after it can close one.
    // 1: on the chain being followed, 2: followed before.
    const seen = new Uint8Array(count);
    for (let s = inherit.some((p, t)=>p > t) ? 0 : count; s < count; s++)
    {
        /** @type {number[]} */
        const path = [];
        let t = s;
        while (t >= 0 && seen[t] === 0)
        {
            seen[t] = 1;
            path.push(t);
            t = inherit[t];
        }
        if (t >= 0 && seen[t] === 1)
        {
            const cycle = path.slice(path.indexOf(t));
            inherit[cycle.find(c=>!sole[c]) ?? cycle[0]] = -1;
        }
        path.forEach(p=>{
            seen[p] = 2;
        });
    }
    return inherit;
}

/**
 * Whether a block's branch goes back to its own start: a loop onto itself,
 * whose turns come back past its entry (a wasm loop of its own, `emitBlock`).
 *
 * @param {import('../region.js').Block} block
 */
function loopsOnto(block){
    return block.exit.targets[0] === block.start
        && (block.exit.kind === 'jcc' || block.exit.kind === 'loop' || block.exit.kind === 'jump');
}

/**
 * A block's entry test: windows over the accesses `reached` names, in the
 * block and the blocks that take their windows from it, each placed from
 * what a register holds at the block's start -- found by following the code
 * from that start alone, never from what the block's way in from the one it
 * takes from put in the registers, so the test holds however the block was
 * entered. An access no register at the start leads to is `dropped` to its
 * own test.
 *
 * @param {{ blocks: import('../region.js').Block[], children: (number[] | undefined)[],
 *     joined: (Joined | undefined)[], placesOf: (Place[][] | undefined)[],
 *     next: { n: number }, word: 4 | 8 }} walked
 *     the region's blocks, which take from which, the group of each access, and each
 *     instruction's accesses, and the stack's slot (`planRegion`'s `long`)
 * @param {number} s @param {Set<Access>} reached @param {Set<Access>} dropped
 * @returns {Group[]}
 */
function entryTests({ blocks, children, joined, placesOf, next, word }, s, reached, dropped){
    const regs = word === 8 ? 16 : 8;
    const values = freshValues(next, regs);
    const first = values.sym[0];
    /** The register a value was in at the start, or -1. @param {number} sym */
    const held = sym=>(sym >= first && sym < first + regs ? sym - first : -1);
    /** One window per group and register: each within its group's 4096 bytes, by
     * `(base + 1, index + 1, scale)`. */
    /** @type {Map<Growing, Map<number, Group & { hi: number }>>} */
    const windows = new Map();
    // Only the blocks below this one that hold an access it reaches, and the
    // ways down to them, are followed: nothing else adds a window or drops an
    // access, and a region's chain of blocks each taking from the one before
    // was followed to its end from every block of it.
    /** @type {Set<number>} */
    const holding = new Set();
    for (const access of reached)
    {
        holding.add(access.block);
    }
    /** 1: the block or one below it holds such an access, 2: none does. */
    const leads = new Uint8Array(blocks.length);
    /** @param {number} t @returns {boolean} */
    const needed = t=>{
        if (leads[t] === 0)
        {
            leads[t] = holding.has(t) || (children[t] ?? []).some(needed) ? 1 : 2;
        }
        return leads[t] === 1;
    };
    /** @param {number} t @param {Values} at */
    const visit = (t, at)=>{
        const { instructions } = blocks[t];
        for (let i = 0; i < instructions.length; i++)
        {
            const ins = instructions[i];
            const places = placesOf[t]?.[i] ?? groupAccessesOf(ins, word);
            for (let k = 0; k < places.length; k++)
            {
                const { base, index, scale, disp, size, store } = places[k];
                // The walk joined every access of every block to a group.
                const { group, access } = /** @type {{ group: Growing, access: Access }[]} */ (
                    /** @type {Joined} */ (joined[t]).get(i))[k];
                if (!reached.has(access))
                {
                    continue;
                }
                const from = base < 0 ? -1 : held(at.sym[base]);
                const by = index < 0 ? -1 : held(at.sym[index]);
                if ((base >= 0 && from < 0) || (index >= 0 && by < 0))
                {
                    dropped.add(access);
                    continue;
                }
                const off = disp + (base < 0 ? 0 : at.delta[base])
                    + (index < 0 ? 0 : at.delta[index] * scale);
                const own = windows.get(group) ?? new Map();
                windows.set(group, own);
                const key = ((from + 1) * 32 + by + 1) * 16 + scale;
                const window = own.get(key) ?? { base: from, index: by, scale, db: 0, di: 0,
                    first: 0, list: [], lo: off, hi: off + size, width: 0 };
                own.set(key, window);
                window.list.push({ block: t, i, off, size, store });
                window.lo = Math.min(window.lo, off);
                window.hi = Math.max(window.hi, off + size);
                window.width = window.hi - window.lo;
            }
            effect(ins, at, false, word);
        }
        for (const child of (children[t] ?? []).filter(needed))
        {
            visit(child, copyValues(at));
        }
    };
    visit(s, values);
    return [...windows.values()].flatMap(own=>[...own.values()]);
}

/**
 * The registers -- eight, or long mode's sixteen -- holding values of their own.
 *
 * @param {{ n: number }} next  the count the values are numbered from
 * @param {number} [regs]
 * @returns {Values}
 */
function freshValues(next, regs = 8){
    const n = next.n;
    next.n += regs;
    return { sym: Array.from({ length: regs }, (_, r)=>n + r), delta: new Array(regs).fill(0),
        next };
}

/** @param {Values} values @returns {Values} */
function copyValues(values){
    return { sym: values.sym.slice(), delta: values.delta.slice(), next: values.next };
}

/** Operations that write no general register. */
const FLAGS_ONLY = new Set(['cld', 'std', 'clc', 'stc', 'cmc', 'sahf']);
/** By operation, whether `effect` knows what it writes from the operation alone. */
/** @type {Map<string, boolean>} */
const KNOWN_OPS = new Map();

/**
 * What an instruction does to the registers the planner follows: a push, a
 * pop and an add, sub, inc or dec of a register by a constant move it by a
 * known amount; a `mov` from another register and a `lea` off one copy that
 * register's value with the offset; a write it cannot follow gives the
 * register a value of its own; an operation not known here gives every
 * register one.
 *
 * @param {import('../decode/decoder.js').Instruction} ins
 * @param {Values} values
 * @param {boolean} [forward]  DF is known clear: a string instruction with no
 *     repeat moves its pointers by its size rather than starting them afresh
 * @param {4 | 8} [word]  a register's width and the stack's slot: in long mode
 *     only a quadword write moves a register by a known amount, a dword one
 *     giving it a value of its own (it zero-extends)
 */
function effect(ins, values, forward = false, word = 4){
    const { op, operands, prefixes } = ins;
    const [dst, src] = operands;
    const { sym, delta } = values;
    const reg32 = dst?.kind === 'reg' && dst.size === word ? /** @type {number} */ (dst.reg) : -1;
    const from = src?.kind === 'reg' && src.size === word ? /** @type {number} */ (src.reg) : -1;
    const pointers = STRING_POINTERS.get(op);
    if (pointers !== undefined && !prefixes.address)
    {
        const repeat = prefixes.rep || prefixes.repne;
        for (const r of pointers)
        {
            if (forward && !repeat)
            {
                delta[r] += ins.size;
            }
            else
            {
                bumpReg(values, r);
            }
        }
        if (repeat)
        {
            bumpReg(values, 1);
        }
        if (op === 'lods')
        {
            bumpReg(values, 0);
        }
        return;
    }
    if (op === 'push' && (ins.size === word || ins.size === 2) && dst.kind !== 'seg')
    {
        delta[4] -= ins.size;
        return;
    }
    if (op === 'pop' && reg32 >= 0)
    {
        delta[4] += word;
        bumpReg(values, reg32);
        return;
    }
    if ((op === 'pushf' || op === 'popf' || op === 'call' || op === 'ret') && !prefixes.operand)
    {
        // A call pushes its return address; a return pops it, and imm16 more.
        delta[4] += op === 'pushf' || op === 'call' ? -word
            : word + (op === 'ret' && dst?.kind === 'imm' ? /** @type {number} */ (dst.value) : 0);
        return;
    }
    if (op === 'leave' && !prefixes.operand)
    {
        copyReg(values, 4, 5, word);
        bumpReg(values, 5);
        return;
    }
    if ((op === 'add' || op === 'sub') && reg32 >= 0 && src.kind === 'imm')
    {
        delta[reg32] += (op === 'add' ? 1 : -1) * /** @type {number} */ (src.value);
        return;
    }
    if ((op === 'inc' || op === 'dec') && reg32 >= 0)
    {
        delta[reg32] += op === 'inc' ? 1 : -1;
        return;
    }
    if (op === 'mov' && reg32 >= 0 && from >= 0)
    {
        copyReg(values, reg32, from, 0);
        return;
    }
    if (op === 'xchg' && reg32 >= 0 && from >= 0)
    {
        const [held, by] = [sym[reg32], delta[reg32]];
        const [heldIndex, heldScale] = [values.isym?.[reg32] ?? -1, values.iscale?.[reg32] ?? 1];
        copyReg(values, reg32, from, 0);
        sym[from] = held;
        delta[from] = by;
        if (values.isym && values.iscale)
        {
            values.isym[from] = heldIndex;
            values.iscale[from] = heldScale;
        }
        return;
    }
    if (op === 'lea' && reg32 >= 0)
    {
        if ((src.base ?? -1) >= 0 && (src.index ?? -1) < 0
            && src.addressSize !== (word === 8 ? 32 : 16) && !src.rip)
        {
            copyReg(values, reg32, /** @type {number} */ (src.base), src.disp ?? 0);
        }
        else
        {
            bumpReg(values, reg32);
        }
        return;
    }
    if (op === 'cdq' || op === 'cwde')
    {
        bumpReg(values, op === 'cdq' ? 2 : 0);
        return;
    }
    if ((op === 'imul' && operands.length === 1) || op === 'mul' || op === 'div'
        || op === 'idiv' || op === 'rdtsc')
    {
        // edx:eax.
        bumpReg(values, 0);
        bumpReg(values, 2);
        return;
    }
    if (op === 'loop' || op === 'loope' || op === 'loopne')
    {
        if (prefixes.address)
        {
            bumpReg(values, 1);
        }
        else
        {
            delta[1]--;
        }
        return;
    }
    if (FLAGS_ONLY.has(op))
    {
        return;
    }
    let byOp = KNOWN_OPS.get(op);
    if (byOp === undefined)
    {
        byOp = INT_WRITE_DST.has(op) || INT_PURE.has(op) || op.startsWith('j')
            || op.startsWith('set') || op.startsWith('cmov');
        KNOWN_OPS.set(op, byOp);
    }
    const known = byOp || isX87Opcode(ins.opcode) || operands.some(o=>o.kind === 'xmm');
    if (!known || op === 'push' || op === 'pop')
    {
        for (let r = 0; r < sym.length; r++)
        {
            bumpReg(values, r);
        }
        return;
    }
    if (dst?.kind === 'reg' && !INT_PURE.has(op))
    {
        bumpReg(values, /** @type {number} */ (dst.reg));
    }
}

/**
 * The registers a block leaves holding other values than it found (`effect`),
 * as a mask: one moved and moved back -- `add ebx, 4`, `sub ebx, 4` -- holds
 * its own again, one popped or written from memory never does.
 *
 * @param {import('../decode/decoder.js').Instruction[]} instructions
 * @param {4 | 8} [word]  (`effect`)
 */
export function registersChanged(instructions, word = 4){
    const values = freshValues({ n: 0 }, word === 8 ? 16 : 8);
    for (const ins of instructions)
    {
        effect(ins, values, false, word);
    }
    let mask = 0;
    for (let r = 0; r < values.sym.length; r++)
    {
        mask |= values.sym[r] !== r || values.delta[r] !== 0 ? 1 << r : 0;
    }
    return mask;
}

/**
 * By instruction of a block, each memory operand's registers as the values
 * they hold there (`effect`), as a key, null for an operand not in memory:
 * two operands off one register across a write of it -- `[rdx + 4]`,
 * `add rdx, 8`, `[rdx]` -- have keys of their own.
 *
 * @param {import('../decode/decoder.js').Instruction[]} instructions
 * @param {4 | 8} [word]  (`effect`)
 * @returns {(string | null)[][]}
 */
export function operandValues(instructions, word = 4){
    const values = freshValues({ n: 0 }, word === 8 ? 16 : 8);
    /** @param {number | undefined} r */
    const held = r=>((r ?? -1) < 0 ? '-'
        : `${values.sym[/** @type {number} */ (r)]}+${values.delta[/** @type {number} */ (r)]}`);
    return instructions.map(ins=>{
        const keys = ins.operands.map(operand=>(operand.kind === 'mem'
            ? `${held(operand.base)},${held(operand.index)},${operand.scale ?? 1},`
                + `${operand.segment ?? -1}` : null));
        effect(ins, values, false, word);
        return keys;
    });
}

/**
 * Long mode's writes a loop's plan follows besides `effect`'s: a dword `add`,
 * `sub`, `inc` or `dec` by a constant, a dword `mov` from a register and a
 * `lea` of one or two registers (a quadword one too) keep the value they move,
 * where `effect` gives a dword write a value of its own. A dword write cuts
 * its value to the low half, which the model holds only while the values it
 * took and made lie in [0, 2^32): each such value is a cut, tested before the
 * turns with the streams (`emitStreamWindow`). False for any other write,
 * left to `effect`.
 *
 * @param {import('../decode/decoder.js').Instruction} ins
 * @param {Values} values  with `isym`, `iscale` and `cuts`
 */
function longWrite(ins, values){
    const { op, operands } = ins;
    const [dst, src] = operands;
    const { sym, delta } = values;
    const isym = /** @type {number[]} */ (values.isym);
    const iscale = /** @type {number[]} */ (values.iscale);
    const cuts = /** @type {Cut[]} */ (values.cuts);
    if (dst?.kind !== 'reg' || (dst.size !== 4 && !(dst.size === 8 && op === 'lea')))
    {
        return false;
    }
    const r = /** @type {number} */ (dst.reg);
    /** @param {number} at */
    const cut = at=>cuts.push({ sym: sym[at], isym: isym[at], iscale: iscale[at], d: delta[at] });
    if ((op === 'add' || op === 'sub') && src.kind === 'imm' || op === 'inc' || op === 'dec')
    {
        cut(r);
        delta[r] += op === 'inc' ? 1 : op === 'dec' ? -1
            : (op === 'add' ? 1 : -1) * /** @type {number} */ (src.value);
        cut(r);
        return true;
    }
    if (op === 'mov' && src.kind === 'reg' && src.size === 4)
    {
        cut(/** @type {number} */ (src.reg));
        copyReg(values, r, /** @type {number} */ (src.reg), 0);
        return true;
    }
    if (op !== 'lea' || src.addressSize === 32 || src.rip)
    {
        return false;
    }
    const base = src.base ?? -1;
    const index = src.index ?? -1;
    const scale = index < 0 ? 1 : src.scale ?? 1;
    const disp = src.disp ?? 0;
    if (base >= 0 && index < 0 || base < 0 && index >= 0 && scale === 1)
    {
        copyReg(values, r, base >= 0 ? base : index, disp);
    }
    else if (base >= 0 && index >= 0 && isym[base] < 0 && isym[index] < 0)
    {
        delta[r] = delta[base] + delta[index] * scale + disp;
        isym[r] = sym[index];
        iscale[r] = scale;
        sym[r] = sym[base];
    }
    else
    {
        bumpReg(values, r);
        return true;
    }
    if (dst.size === 4)
    {
        cut(r);
    }
    return true;
}

/**
 * A register given a value of its own.
 *
 * @param {Values} values @param {number} r
 */
function bumpReg(values, r){
    values.sym[r] = values.next.n++;
    values.delta[r] = 0;
    if (values.isym)
    {
        values.isym[r] = -1;
    }
}

/**
 * A register given another's value, moved by `by`.
 *
 * @param {Values} values @param {number} r @param {number} from @param {number} by
 */
function copyReg(values, r, from, by){
    values.sym[r] = values.sym[from];
    values.delta[r] = values.delta[from] + by;
    if (values.isym && values.iscale)
    {
        values.isym[r] = values.isym[from];
        values.iscale[r] = values.iscale[from];
    }
}

/**
 * Pushes long mode's sum of a group's registers and `start`: the quadword's
 * (`wide`), or the dword of their low halves an access's own address sums
 * (`emitAddress`), which the host computes once for both.
 *
 * @param {E} e @param {{ base: number, index: number, scale: number }} group
 * @param {number} start @param {boolean} wide
 */
function groupSum(e, { base, index, scale }, start, wide){
    const { b } = e;
    const ops = wide ? I64 : I32;
    /** @param {number} r */
    const register = r=>{
        b.localGet(registerLocal(e, r));
        if (!wide)
        {
            b.op(I64.wrap);
        }
    };
    if (base >= 0)
    {
        register(base);
    }
    if (index >= 0)
    {
        register(index);
        if (scale > 1)
        {
            if (wide)
            {
                b.i64const(BigInt(Math.log2(scale)));
            }
            else
            {
                b.i32const(Math.log2(scale));
            }
            b.op(ops.shl);
        }
        if (base >= 0)
        {
            b.op(ops.add);
        }
    }
    if (wide)
    {
        b.i64const(BigInt(start));
    }
    else
    {
        b.i32const(start | 0);
    }
    if (base >= 0 || index >= 0)
    {
        b.op(ops.add);
    }
}

/**
 * The groups checked at the instruction about to be emitted: each window's
 * pages tested once, and the instruction left untranslated when one would
 * fault or a store would land in code. With `at`, the windows a block takes
 * from the one before it, tested at its start when it is entered otherwise:
 * a window not clean leaves there, with nothing of the block run.
 *
 * @param {E} e @param {Group[]} checks @param {number} [at]
 */
export function emitGroupChecks(e, checks, at = -1){
    if (e.context.looseStacks === true)
    {
        // A window off esp alone is a thread's stack, where no translated
        // code lies while the module is loose: neither a fault nor a code
        // store to find. The esp of a guest that moved it elsewhere goes
        // unwatched, which the runtime's `noteStack` accepts.
        checks = checks.filter(group=>group.base !== 4 || group.index >= 0);
        if (checks.length === 0)
        {
            return;
        }
    }
    const { b } = e;
    const table = pageFlagsAt(e.layout);
    // Held: the epilogue's hash probe would find this very address's entry
    // and tail-call it, whose check leaves again with nothing retired -- for
    // ever, the budget untouched. Back at the host, the interpreter runs it.
    const exit = ()=>{
        if (at >= 0)
        {
            e.exitAt(at, Exit.UNTRANSLATED, HELD);
            return;
        }
        e.blockRetired--;
        e.exitAt(e.current.eip, Exit.UNTRANSLATED, HELD);
        e.blockRetired++;
    };
    // Every window here leaves the same way: where there would be more than
    // one such exit, each window not clean branches to a single one (an exit
    // is the larger part of a test, the x87 stack's write-back with it).
    const shared = checks.length > 1 || checks.some(group=>group.list.some(access=>access.store));
    /** Leaves when the condition on the stack is not zero. @param {string} name */
    const leaveIf = name=>{
        if (shared)
        {
            b.unlikely().brIf(e.depthOf('windowHeld'));
            return;
        }
        e.openGuard(name, EMPTY);
        exit();
        e.close();
    };
    if (shared)
    {
        e.open('windowsClean', EMPTY);
        e.open('windowHeld', EMPTY);
    }
    for (const group of checks)
    {
        // The window's first byte: the registers now are their version's
        // value moved by what the block did to them since.
        const start = group.lo - group.db - group.di * group.scale;
        if (e.width.bits === 64)
        {
            // Long mode's quadword registers: a window past the 4 GiB one is
            // not clean (the interpreter faults its access). Its high half is
            // tested with the page flags, at one branch: a window that starts
            // inside 4 GiB and ends past it starts on the last page, which no
            // RAM reaches (`longLayout`), so it is flagged INACCESSIBLE. The
            // high half, of the quadword sum, is kept in `t64`; the low one is
            // the sum of the registers' low halves, as the accesses' own
            // addresses are (`emitAddress`), which the host computes once.
            groupSum(e, group, start, true);
            b.i64const(32n).op(I64.shrU).localSet(Local.t64);
            groupSum(e, group, start, false);
            b.localSet(Local.addr);
            b.localGet(Local.t64).op(I64.wrap);
        }
        else
        {
            if (group.base >= 0)
            {
                b.localGet(registerLocal(e, group.base));
            }
            else
            {
                b.i32const(0);
            }
            if (group.index >= 0)
            {
                b.localGet(registerLocal(e, group.index)).i32const(group.scale).op(I32.mul)
                    .op(I32.add);
            }
            b.i32const(start | 0).op(I32.add).localSet(Local.addr);
        }
        // The common case is one test, as for a single access: the flags of
        // the window's page and the next, read as a halfword (the window lies
        // in the two), against INACCESSIBLE -- and against HAS_CODE and WATCH
        // for a group that stores. Only when a flag is up are the window's own
        // pages and the stores' granules looked at.
        const stores = group.list.some(access=>access.store);
        const bits = PageFlag.INACCESSIBLE | (stores ? STORE_FLAGS : 0);
        b.localGet(Local.addr).i32const(12).op(I32.shrU);
        loadFlags(e, table, 'i32_16u').i32const(bits * 0x01010101).op(I32.and);
        if (e.width.bits === 64)
        {
            b.op(I32.or);
        }
        // Out of line: a window seldom finds a flag up, and its test inline
        // was most of the bytes of a region's stack accesses.
        e.openGuard('window', EMPTY);
        if (e.width.bits === 64)
        {
            b.localGet(Local.t64).op(I64.wrap);
            leaveIf('beyond');
        }
        const [first = [1, 0], ...more] = storeSpans(group.list, group.lo);
        b.localGet(Local.addr).i32const(group.width - 1).i32const(first[0]).i32const(first[1])
            .call(e.context.windowHit);
        for (const [from, to] of more)
        {
            b.localGet(Local.addr).i32const(from).op(I32.add)
                .localGet(Local.addr).i32const(to).op(I32.add)
                .call(e.context.spanHit).op(I32.or);
        }
        leaveIf('window');
        e.close();
    }
    if (shared)
    {
        b.br(e.depthOf('windowsClean'));
        e.close();
        exit();
        e.close();
    }
}

// --- a loop's access streams ---
//
// A block that loops onto itself moves the registers its accesses go off by
// the same amount every turn when it changes them only by push, pop, a
// constant add, sub, inc or dec, a copy from one that moves so, or a string
// instruction's element (by its size: the loop is planned for DF clear, and
// its test finds DF set not clean). Each such group of accesses (one base,
// one index, one scale) is then a stream: its window moves by a fixed stride
// a turn. The turns a stride of at most 4096 bytes takes span at most three
// pages beyond the window, so the pages the next `turns` of every stream
// reach are tested once, before them -- against INACCESSIBLE, and against
// code, at the page, for a stream with a store -- and those turns run a copy
// of the body with no test on the streams' accesses (`emitHoistedLoop` in
// `region.js`). A window that is not clean, or turns spent, go back to the
// test; a window not clean runs the checked copy to the loop's end. An access
// off a register the block changes in another way is left to its own test.

/**
 * @typedef {{ base: number, index: number, scale: number, lo: number, hi: number,
 *     stride: number, store: boolean, tested?: boolean }} Stream
 *     tested: some access of it is a read tested where reads go untested (a string
 *     instruction's), which a page's flags fault
 * @typedef {{ base: number, index: number, scale: number, lo: number, hi: number,
 *     stride: number }} Range
 *     the values a long-mode loop's dword writes cut (`longWrite`), off a base and an
 *     index register as the turn found them: from `lo` to `hi` past them in a turn
 */

/**
 * The accesses of a self-looping block that go off registers moved by a
 * fixed stride a turn, as streams, with the plan the unchecked copy is
 * emitted under and how many turns one test of the streams covers; null
 * when no access qualifies.
 *
 * @param {import('../decode/decoder.js').Instruction[]} instructions
 * @param {boolean} [long]  long mode's: sixteen registers, quadword pointers
 * @returns {{ plan: Map<number, Planned>, streams: Stream[], turns: number,
 *     forward: boolean, ranges: Range[] } | null}  `forward`: planned for DF clear;
 *     `ranges` the values the turns must keep in [0, 2^32) (long mode's dword writes)
 */
export function planLoop(instructions, long = false){
    const word = long ? 8 : 4;
    // A string instruction moves its pointers by its size a turn while DF is
    // clear, and a loop that writes no DF keeps it as it was found: such a
    // loop is planned for DF clear, and its window test takes DF too.
    const forward = instructions.every(ins=>(ins.flagsWritten & DF) === 0);
    const values = freshValues({ n: 0 }, long ? 16 : 8);
    const { sym: initial } = copyValues(values);
    const { delta } = values;
    if (long)
    {
        values.isym = new Array(16).fill(-1);
        values.iscale = new Array(16).fill(1);
        values.cuts = [];
    }
    const isym = values.isym ?? [];
    const iscale = values.iscale ?? [];
    /**
     * An access's registers as the turn found them: its base's and index's
     * values, a base that is itself a sum (`isym`) taking the index's place.
     *
     * @param {number} base @param {number} index @param {number} scale
     * @returns {{ base: number, index: number, scale: number } | null}
     */
    const rootsOf = (base, index, scale)=>{
        if (base >= 0 && (isym[base] ?? -1) >= 0)
        {
            return index >= 0 ? null : { base: initial.indexOf(values.sym[base]),
                index: initial.indexOf(isym[base]), scale: iscale[base] };
        }
        if (index >= 0 && (isym[index] ?? -1) >= 0)
        {
            return null;
        }
        return { base: base < 0 ? -1 : initial.indexOf(values.sym[base]),
            index: index < 0 ? -1 : initial.indexOf(values.sym[index]), scale };
    };
    /** @type {{ i: number, base: number, index: number, scale: number, off: number,
     *     size: number, store: boolean }[]} */
    const found = [];
    /** How many accesses each instruction makes that a stream could take. */
    const made = instructions.map(()=>0);
    instructions.forEach((ins, i)=>{
        const accesses = loopAccessesOf(ins, forward, word);
        made[i] = accesses.length;
        for (const { base, index, scale, disp, size, store } of accesses)
        {
            // Off the values registers held as the turn found them, moved by
            // known amounts -- each by the register that held it then.
            const roots = rootsOf(base, index, scale);
            if (roots !== null && (base < 0 || roots.base >= 0)
                && (index < 0 && (base < 0 || (isym[base] ?? -1) < 0) || roots.index >= 0))
            {
                const off = disp + (base >= 0 ? delta[base] : 0)
                    + (index >= 0 ? delta[index] * scale : 0);
                found.push({ i, base: roots.base, index: roots.index, scale: roots.scale, off,
                    size, store });
            }
        }
        if (!long || !longWrite(ins, values))
        {
            effect(ins, values, forward, word);
        }
    });
    /** A register holding its own value of the turn's start, moved by `delta`. @param {number} r */
    const fixed = r=>r < 0 || values.sym[r] === initial[r] && (isym[r] ?? -1) < 0;
    /** @param {{ base: number, index: number, scale: number }} a */
    const keyOf = a=>`${a.base}.${a.index}.${a.scale}`;
    /** @type {Map<string, Stream>} */
    const streams = new Map();
    /** @type {Map<number, Planned>} */
    const plan = new Map();
    for (const access of found)
    {
        if (!fixed(access.base) || !fixed(access.index))
        {
            continue;
        }
        const stride = (access.base >= 0 ? delta[access.base] : 0)
            + (access.index >= 0 ? delta[access.index] * access.scale : 0);
        let stream = streams.get(keyOf(access));
        if (stream === undefined)
        {
            stream = { base: access.base, index: access.index, scale: access.scale,
                lo: access.off, hi: access.off + access.size, stride, store: false };
            streams.set(keyOf(access), stream);
        }
        stream.lo = Math.min(stream.lo, access.off);
        stream.hi = Math.max(stream.hi, access.off + access.size);
        stream.store ||= access.store;
        stream.tested ||= !readsOnly(instructions[access.i])
            || STRING_ACCESSES.has(instructions[access.i].op);
        const entry = plan.get(access.i);
        plan.set(access.i, { checks: [], access: entry?.access ?? { block: 0, i: access.i,
            off: access.off, size: access.size, store: access.store }, size: access.size,
        store: access.store || entry?.store === true, used: false });
    }
    const kept = [...streams.values()].filter(stream=>stream.hi - stream.lo <= 4096
        && Math.abs(stream.stride) <= 4096);
    if (kept.length === 0)
    {
        return null;
    }
    const keptKeys = new Set(kept.map(keyOf));
    for (const i of [...plan.keys()])
    {
        // Every access of the instruction in a kept stream: the plan cannot
        // tell the two of a movs or a cmps apart, so it takes both or neither.
        const mine = found.filter(a=>a.i === i);
        if (mine.length !== made[i] || !mine.every(a=>fixed(a.base) && fixed(a.index)
            && keptKeys.has(keyOf(a))))
        {
            plan.delete(i);
        }
    }
    const widest = Math.max(...kept.map(stream=>Math.abs(stream.stride)));
    const turns = widest === 0 ? 1 << 16 : 1 + Math.floor(4096 / widest);
    const strings = forward && instructions.some(ins=>STRING_POINTERS.has(ins.op));
    return { plan, streams: kept, turns, forward: strings,
        ranges: rangesOf(values.cuts ?? [], initial, fixed, delta) };
}

/**
 * A loop's cuts (`longWrite`) by the registers their values go off as the
 * turn found them: the span of the values each pair of registers takes in a
 * turn, and how far they move a turn. A cut off a register the turn does not
 * move by a stride is on no stream's way, and left out.
 *
 * @param {Cut[]} cuts @param {number[]} initial
 * @param {(r: number)=>boolean} fixed @param {number[]} delta
 * @returns {Range[]}
 */
function rangesOf(cuts, initial, fixed, delta){
    /** @type {Map<string, Range>} */
    const ranges = new Map();
    for (const { sym, isym, iscale, d } of cuts)
    {
        const base = initial.indexOf(sym);
        const index = isym < 0 ? -1 : initial.indexOf(isym);
        if (base < 0 || isym >= 0 && index < 0 || !fixed(base) || !fixed(index))
        {
            continue;
        }
        const scale = index < 0 ? 1 : iscale;
        const key = `${base}.${index}.${scale}`;
        const range = ranges.get(key);
        if (range === undefined)
        {
            ranges.set(key, { base, index, scale, lo: d, hi: d,
                stride: delta[base] + (index < 0 ? 0 : delta[index] * scale) });
        }
        else
        {
            range.lo = Math.min(range.lo, d);
            range.hi = Math.max(range.hi, d);
        }
    }
    return [...ranges.values()];
}

/**
 * The accesses of an instruction a loop's streams can take: those a group
 * takes (`groupAccessesOf`), or with DF known clear the element accesses of
 * a string instruction with no repeat, off esi and edi.
 *
 * @param {import('../decode/decoder.js').Instruction} ins
 * @param {boolean} forward @param {4 | 8} [word]  (`accessOf`)
 * @returns {Place[]}
 */
function loopAccessesOf(ins, forward, word = 4){
    const strings = STRING_ACCESSES.get(ins.op);
    if (strings !== undefined)
    {
        const { prefixes } = ins;
        if (!forward || prefixes.rep || prefixes.repne || prefixes.lock || prefixes.address
            || ins.operands.some(o=>o.kind === 'mem' && (o.segment === 4 || o.segment === 5)))
        {
            return [];
        }
        return strings.map(([base, store])=>({ base, index: -1, scale: 1, disp: 0,
            size: ins.size, store }));
    }
    return groupAccessesOf(ins, word);
}

/**
 * Leaves 1 on the stack when every page the streams reach in the next
 * `turns` turns is accessible, and holds no code where a stream stores; 0
 * otherwise. Each stream's reach is at most 8192 bytes, so its first page,
 * the one 4096 bytes on and its last cover it. A watched page a stream
 * stores to is marked written then (`codeHit`), before any of its stores.
 *
 * @param {E} e @param {Stream[]} streams @param {number} turns
 * @param {boolean} [forward]  the streams move as they do with DF clear: 0
 *     when it is set
 * @param {Range[]} [ranges]  values the turns cut to 32 bits: 0 unless each
 *     lies in [0, 2^32) through the turns
 */
export function emitStreamWindow(e, streams, turns, forward = false, ranges = []){
    const { b } = e;
    const table = pageFlagsAt(e.layout);
    if (forward)
    {
        b.localGet(Local.flags).i32const(DF).op(I32.and);
    }
    else
    {
        b.i32const(0);
    }
    const long = e.width.bits === 64;
    for (const stream of streams)
    {
        const span = (turns - 1) * stream.stride;
        const from = stream.lo + Math.min(0, span);
        const width = stream.hi - stream.lo + Math.abs(span);
        if (long)
        {
            // Long mode's registers are quadwords: the reach lies inside the
            // 4 GiB window, or the window is not clean.
            if (stream.base >= 0)
            {
                b.localGet(registerLocal(e, stream.base));
            }
            else
            {
                b.i64const(0n);
            }
            if (stream.index >= 0)
            {
                b.localGet(registerLocal(e, stream.index)).i64const(BigInt(stream.scale))
                    .op(I64.mul).op(I64.add);
            }
            b.i64const(BigInt(from)).op(I64.add).localTee(Local.t64)
                .localGet(Local.t64).i64const(BigInt(width - 1)).op(I64.add).op(I64.or)
                .i64const(32n).op(I64.shrU).op(I64.wrap).op(I32.or);
            b.localGet(Local.t64).op(I64.wrap).localSet(Local.addr);
        }
        else
        {
            if (stream.base >= 0)
            {
                b.localGet(registerLocal(e, stream.base));
            }
            else
            {
                b.i32const(0);
            }
            if (stream.index >= 0)
            {
                b.localGet(registerLocal(e, stream.index)).i32const(stream.scale).op(I32.mul)
                    .op(I32.add);
            }
            b.i32const(from | 0).op(I32.add).localSet(Local.addr);
            if (!stream.store && stream.tested !== true && readsWrapped(e.context)
                && width <= e.layout.ramSize)
            {
                // A stream that only reads, where reads go untested: its reach
                // inside RAM is all the unchecked copy needs, a read there being
                // the one its address wrapped into RAM makes -- one compare, where
                // the pages' flags were three loads.
                b.localGet(Local.addr).i32const(e.layout.ramSize - width + 1 | 0).op(I32.geU)
                    .op(I32.or);
                continue;
            }
        }
        if (width - 1 > 8192)
        {
            // Three pages' flags cover no more.
            throw new Error(`emit: a stream window of ${width} bytes`);
        }
        const bits = PageFlag.INACCESSIBLE | (stream.store ? PageFlag.HAS_CODE : 0);
        const reach = [0, Math.min(4096, width - 1), width - 1];
        reach.forEach((at, k)=>{
            b.localGet(Local.addr);
            if (at !== 0)
            {
                b.i32const(at).op(I32.add);
            }
            b.i32const(12).op(I32.shrU);
            loadFlags(e, table, 'i32_8u');
            if (k > 0)
            {
                b.op(I32.or);
            }
        });
        if (stream.store)
        {
            // A watched page is marked written here, every page the turns may
            // reach, and the turns run untested as on pages written already:
            // left to the checked copy, a loop filling a watched buffer ran
            // every store tested to its end, three times as slow. Out of the
            // way: few pages are watched, and its calls inline had the host's
            // compiler spill the loop's registers on the way every window
            // test takes (a Crysis loop's head stored eleven to its frame).
            b.localTee(Local.pflags).i32const(PageFlag.WATCH).op(I32.and);
            b.unlikely().if(EMPTY);
            for (const at of reach)
            {
                b.localGet(Local.addr);
                if (at !== 0)
                {
                    b.i32const(at).op(I32.add);
                }
                b.call(e.context.codeHit).drop();
            }
            b.end();
            b.localGet(Local.pflags);
        }
        // This stream's flagged pages, into the word under it.
        b.i32const(bits).op(I32.and).op(I32.or);
    }
    for (const range of ranges)
    {
        const span = (turns - 1) * range.stride;
        b.localGet(registerLocal(e, range.base));
        if (range.index >= 0)
        {
            b.localGet(registerLocal(e, range.index)).i64const(BigInt(range.scale))
                .op(I64.mul).op(I64.add);
        }
        b.localTee(Local.t64).i64const(BigInt(range.lo + Math.min(0, span))).op(I64.add)
            .localGet(Local.t64).i64const(BigInt(range.hi + Math.max(0, span))).op(I64.add)
            .op(I64.or).i64const(32n).op(I64.shrU).op(I64.wrap).op(I32.or);
    }
    b.op(I32.eqz);
}

/**
 * An access the block's plan took into a group: nothing to emit, the group's
 * check having covered it. Answers false for an access outside the plan.
 *
 * @param {E} e @param {number} size @param {boolean} store
 */
function planned(e, size, store){
    const plan = e.memPlan;
    if (plan === null || plan.access === null)
    {
        return false;
    }
    // The one memory operand may be read twice (comiss reads it for each
    // flag); any access of another size is not the one planned.
    if (size !== plan.size || (store && !plan.store))
    {
        throw new Error(`memory plan: ${e.current.op} at ${e.current.eip.toString(16)}`
            + ` accesses ${size}${store ? ' (store)' : ''}, not as planned`);
    }
    plan.used = true;
    return true;
}

/**
 * Sets `addr` to the stack pointer and checks a `size`-byte access there.
 *
 * @param {E} e @param {number} size
 */
export function stackAccess(e, size){
    if (e.width.bits === 64 && (e.memPlan?.access != null || e.context.looseStacks === true))
    {
        // A stream's window test covered it, the window included; or the
        // stack is loose, its accesses tested no more than esp's are at 32
        // bits: rsp's low half addresses it, and an rsp a program moved past
        // the 4 GiB window reads there rather than faulting.
        e.b.localGet(registerLocal(e, 4)).op(I64.wrap).localSet(Local.addr);
    }
    else if (e.width.bits === 64)
    {
        windowAddress(e, ()=>e.b.localGet(registerLocal(e, 4)));
    }
    else
    {
        e.b.localGet(registerLocal(e, 4)).localSet(Local.addr);
    }
    if (e.context.looseStacks === true)
    {
        planned(e, size, false);
        return;
    }
    checkAccess(e, size, { window: e.width.bits === 64 });
}

/**
 * Long mode's address of an access, the i64 `pushAddress` pushes, into `addr`
 * as the window's 32 bits, the whole of it kept in `t64` for the access's
 * `checkAccess` (`window`) to fault (#GP) where any of its bytes lies past the
 * 4 GiB window, as the processor faults on an address no page maps there.
 *
 * @param {E} e @param {() => void} pushAddress
 */
export function windowAddress(e, pushAddress){
    pushAddress();
    e.b.localTee(Local.t64).op(I64.wrap).localSet(Local.addr);
}

/**
 * Leaves with #GP where the `size`-byte access whose whole address is in
 * `t64` reaches past the 4 GiB window: a test of its own, for an access the
 * page flags do not test.
 *
 * @param {E} e @param {number} size @param {boolean} counted
 */
function windowTest(e, size, counted){
    const { b } = e;
    b.localGet(Local.t64).localGet(Local.t64).i64const(BigInt(Math.max(size, 1) - 1))
        .op(I64.add).op(I64.or)
        .i64const(32n).op(I64.shrU).i64const(0n).op(I64.ne);
    e.openGuard('window', EMPTY);
    faultHere(e, counted);
    e.close();
}

/**
 * Leaves with #GP at the current instruction, `counted` as `checkAccess` has it.
 *
 * @param {E} e @param {boolean} counted
 */
function faultHere(e, counted){
    if (counted)
    {
        e.exitBefore(e.current.eip, Exit.FAULT, 13);
    }
    else
    {
        e.exitAt(e.current.eip, Exit.FAULT, 13);
    }
}

/**
 * Whether a store at `addr`, the stack pointer moved down by a push, goes
 * untested (`looseStacks`): an instruction whose other access the plan
 * could not take -- `push [m]`, `call [m]` -- has its push left out of the
 * plan too, and would otherwise test it on its own.
 *
 * @param {E} e @param {number} size
 */
export function looseStackStore(e, size){
    if (e.context.looseStacks !== true)
    {
        return false;
    }
    planned(e, size, true);
    return true;
}

/**
 * After an instruction that stored: leaves `stale` with EIP at the next
 * instruction when the store went into a code page.
 *
 * @param {E} e @param {number} next
 */
export function emitStaleExit(e, next){
    e.b.localGet(Local.stale);
    e.openGuard('stale', EMPTY);
    e.exitAt(next, Exit.STALE);
    e.close();
}

/**
 * The undo helper a differential module carries: `(address, size)` appends
 * an entry of the address, the size and the sixteen bytes at the address to
 * the ring at `layout.tables + Tables.UNDO_RING`, counting in `UNDO_HEAD`.
 * Sixteen bytes are read whatever the size: the ring's reader uses `size`,
 * and the bytes past a store at the very end of RAM are the tables.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {number} the function index
 */
export function addUndoHelper(m, layout){
    if (layout.shared === true)
    {
        // A differential build's, on one executor: its ring is that one's tables.
        throw new Error('emit: the undo log is under one executor\'s layout, not the shared one');
    }
    const type = m.type({ params: [ValType.i32, ValType.i32], results: [] });
    const head = layout.tables + Tables.UNDO_HEAD;
    const ring = layout.tables + Tables.UNDO_RING;
    // locals: 0 address, 1 size, 2 slot
    const body = new Body();
    body.i32const(0).load('i32', { offset: head })
        .i32const(Tables.UNDO_ENTRIES - 1).op(I32.and)
        .i32const(Tables.UNDO_ENTRY).op(0x6c).localSet(2);
    body.localGet(2).localGet(0).store('i32', { offset: ring });
    body.localGet(2).localGet(1).store('i32', { offset: ring + 4 });
    body.localGet(2).localGet(0).load('i64', { offset: layout.ramBase })
        .store('i64', { offset: ring + 8 });
    body.localGet(2).localGet(0).load('i64', { offset: layout.ramBase + 8 })
        .store('i64', { offset: ring + 16 });
    body.i32const(0).i32const(0).load('i32', { offset: head }).i32const(1).op(I32.add)
        .store('i32', { offset: head });
    return m.function(type, [ValType.i32], body.toBytes());
}

/**
 * The entries a run left in the undo ring, oldest first, and whether the
 * ring wrapped (in which case the oldest entries are gone and the reader
 * must fall back to whole-memory comparison).
 *
 * @param {WebAssembly.Memory} memory
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {{ entries: { address: number, size: number, old: Uint8Array }[], wrapped: boolean }}
 */
export function readUndoLog(memory, layout){
    const view = new DataView(memory.buffer);
    const head = view.getUint32(layout.tables + Tables.UNDO_HEAD, true);
    const wrapped = head > Tables.UNDO_ENTRIES;
    const count = Math.min(head, Tables.UNDO_ENTRIES);
    const first = wrapped ? head - Tables.UNDO_ENTRIES : 0;
    const entries = [];
    for (let i = 0; i < count; i++)
    {
        const slot = layout.tables + Tables.UNDO_RING + ((first + i) & (Tables.UNDO_ENTRIES - 1))
            * Tables.UNDO_ENTRY;
        const size = view.getUint32(slot + 4, true);
        entries.push({
            address: view.getUint32(slot, true),
            size,
            old: new Uint8Array(memory.buffer.slice(slot + 8, slot + 8 + size)),
        });
    }
    return { entries, wrapped };
}

/**
 * Clears the undo ring's count.
 *
 * @param {WebAssembly.Memory} memory
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 */
export function resetUndoLog(memory, layout){
    new DataView(memory.buffer).setUint32(layout.tables + Tables.UNDO_HEAD, 0, true);
}

/**
 * The spans the entries cover, merged and sorted: what a differential run
 * compares and restores.
 *
 * @param {{ address: number, size: number }[]} entries
 * @returns {{ start: number, end: number }[]}
 */
export function spansOf(entries){
    const sorted = entries.map(({ address, size })=>({ start: address, end: address + size }))
        .sort((a, b)=>a.start - b.start);
    /** @type {{ start: number, end: number }[]} */
    const out = [];
    for (const span of sorted)
    {
        const last = out[out.length - 1];
        if (last && span.start <= last.end)
        {
            last.end = Math.max(last.end, span.end);
        }
        else
        {
            out.push({ ...span });
        }
    }
    return out;
}
