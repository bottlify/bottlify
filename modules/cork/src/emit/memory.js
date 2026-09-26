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
 * or per window of accesses (see the groups below); `roadmap/cork-plan.md`
 * 2.9 measures its share.
 */

import { Body, EMPTY, ValType } from '../wasm/encoder.js';
import { DF } from '../decode/table.js';
import { Tables } from '../runtime/layout.js';
import { PageFlag } from '../runtime/pages.js';
import { I32 } from './flags.js';
import { Exit, Local } from './region.js';

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
 * against INACCESSIBLE -- and for `store` against HAS_CODE too, the store's
 * code note being made here rather than in a second test in `noteStore`.
 * Only when a flag is up are the last byte's own flags read, so an access
 * beside an unmapped page or a code page is neither a fault nor a note
 * unless it reaches it.
 *
 * @param {E} e @param {number} size
 * @param {{ counted?: boolean, store?: boolean }} [options]  `counted` false
 *     inside a `rep` loop, where the instruction is not counted and a fault
 *     leaves at it without uncounting; `store` when the access is only
 *     written and its `noteStore` follows with no exit between
 */
export function checkAccess(e, size, { counted = true, store = false } = {}){
    const { b } = e;
    if (planned(e, size, store))
    {
        return;
    }
    const table = e.layout.tables + Tables.PAGE_FLAGS;
    const noting = store && e.layout.codePages < 0 && size <= 16;
    const bits = PageFlag.INACCESSIBLE | (noting ? PageFlag.HAS_CODE : 0);
    b.localGet(Local.addr).i32const(12).op(I32.shrU)
        .load(size > 1 ? 'i32_16u' : 'i32_8u', { offset: table })
        .localTee(Local.pflags).i32const(size > 1 ? bits * 0x101 : bits).op(I32.and);
    e.openGuard('flagged', EMPTY);
    if (size > 1)
    {
        b.localGet(Local.addr).i32const(12).op(I32.shrU).load('i32_8u', { offset: table });
        b.localGet(Local.addr).i32const(size - 1).op(I32.add).i32const(12).op(I32.shrU)
            .load('i32_8u', { offset: table }).op(I32.or).localSet(Local.pflags);
    }
    b.localGet(Local.pflags).i32const(PageFlag.INACCESSIBLE).op(I32.and);
    e.openGuard('inaccessible', EMPTY);
    if (counted)
    {
        e.exitBefore(e.current.eip, Exit.FAULT, 13);
    }
    else
    {
        e.exitAt(e.current.eip, Exit.FAULT, 13);
    }
    e.close();
    if (noting)
    {
        b.localGet(Local.pflags).i32const(PageFlag.HAS_CODE).op(I32.and);
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
                .load('i32_8u', { offset: e.layout.tables + Tables.PAGE_FLAGS }).op(I32.or);
        }
        // The next page's flag too: a wide access's halfword holds it.
        b.i32const(PageFlag.HAS_CODE * 0x101).op(I32.and);
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
    // range, for the store's first byte and its last.
    b.localGet(Local.addr).call(e.context.codeHit);
    if (size > 1)
    {
        b.localGet(Local.addr).i32const(size - 1).op(I32.add).call(e.context.codeHit).op(I32.or);
    }
    if (e.layout.codePages >= 0)
    {
        // The other executor's own table too: its compiled page is as much
        // code as this engine's, and the runtime dirties its cache.
        b.localGet(Local.addr).i32const(12).op(I32.shrU)
            .load('i32_8u', { offset: e.layout.codePages }).op(I32.or);
    }
    e.openGuard('code', EMPTY);
    b.i32const(1).localSet(Local.stale);
    b.i32const(0).localGet(Local.addr)
        .store('i32', { offset: e.layout.tables + Tables.STALE_ADDRESS });
    b.i32const(0).i32const(size).store('i32', { offset: e.layout.tables + Tables.STALE_SIZE });
    e.close();
    e.staleCheck = true;
}

/**
 * Adds the helper `codeHit(address) -> 0|1`: whether the byte lies in
 * translated code -- its page flagged, and its 32-byte granule within the
 * page's code range.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {number} the function index
 */
export function addCodeHitHelper(m, layout){
    const type = m.type({ params: [ValType.i32], results: [ValType.i32] });
    const b = new Body();
    const flags = layout.tables + Tables.PAGE_FLAGS;
    const ranges = layout.tables + Tables.CODE_RANGES;
    // local 1: the page; local 2: the granule
    b.localGet(0).i32const(12).op(I32.shrU).localSet(1);
    b.localGet(1).load('i32_8u', { offset: flags }).i32const(PageFlag.HAS_CODE).op(I32.and);
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
    return m.function(type, [ValType.i32, ValType.i32], b.toBytes());
}

// --- the region's access groups ---
//
// Most accesses go off a register the code does not change in between -- a
// frame through esp or ebp, a struct through one pointer, an array through a
// base and an index -- or off an address in the instruction. Such a group's
// accesses lie in a window known from the register values at its first
// access, and a window of at most 4096 bytes spans at most two pages. So the
// group is checked once, at its first access: the flags of its page and the
// next against INACCESSIBLE and, for a group that stores, HAS_CODE -- then,
// only when one is up, the window's own pages and the stores' granules,
// through `codeHit`. A clean window leaves every access of the group with no
// test at all. A window that would fault or note a store into code leaves
// the region before that first access, untranslated, and the interpreter
// runs on from there with a check on every access: the fault is raised at
// its instruction and the note made at its store, as they would be here.
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

const X87_OPCODE = /^(9b$|d[89a-f] )/;
/** Integer operations whose memory destination is read and written. */
const INT_RW = new Set([
    'add', 'sub', 'adc', 'sbb', 'and', 'or', 'xor', 'inc', 'dec', 'not', 'neg',
    'shl', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr', 'shld', 'shrd',
]);
/** Integer operations whose memory source is read. */
const INT_READ = new Set([
    'mov', 'movzx', 'movsx', 'add', 'sub', 'adc', 'sbb', 'and', 'or', 'xor', 'cmp', 'test',
    'imul', 'bsf', 'bsr', 'cvttss2si', 'cvtss2si', 'cvttsd2si', 'cvtsd2si',
]);
/** Integer operations that write their first operand and no other register. */
const INT_WRITE_DST = new Set([
    ...INT_RW, 'mov', 'movzx', 'movsx', 'imul', 'bsf', 'bsr', 'bswap',
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
 * @typedef {{ sym: number[], delta: number[], next: { n: number } }} Values
 *     what each register holds: a value the planner cannot see into (`sym`),
 *     moved by a known amount (`delta`)
 */

/**
 * The one access an instruction makes that a group can take, or null.
 *
 * @param {import('../decode/decoder.js').Instruction} ins
 * @returns {{ operand: import('../decode/decoder.js').Operand | null, size: number,
 *     store: boolean, stack: number } | null}
 *     `stack`: the access's offset from esp for a push or pop, else 0
 */
function accessOf(ins){
    const { op, operands } = ins;
    const [dst] = operands;
    if (ins.prefixes.operand && (op === 'call' || op === 'ret' || op === 'leave'))
    {
        return null;
    }
    if (op === 'call' && (dst.kind === 'rel' || dst.kind === 'reg'))
    {
        return { operand: null, size: 4, store: true, stack: -4 };
    }
    if (op === 'ret')
    {
        return { operand: null, size: 4, store: false, stack: 0 };
    }
    if (op === 'leave')
    {
        return { operand: SAVED_EBP, size: 4, store: false, stack: 0 };
    }
    if (op === 'push' && ins.size === 4
        && (dst.kind === 'imm' || dst.kind === 'reg' && dst.size === 4))
    {
        return { operand: null, size: 4, store: true, stack: -4 };
    }
    if (op === 'pop' && dst.kind === 'reg' && dst.size === 4)
    {
        return { operand: null, size: 4, store: false, stack: 0 };
    }
    const at = operands.findIndex(o=>o.kind === 'mem');
    if (at < 0 || operands.some((o, k)=>k !== at && o.kind === 'mem'))
    {
        return null;
    }
    const mem = operands[at];
    if (mem.addressSize === 16 || mem.segment === 4 || mem.segment === 5 || ins.prefixes.rep
        || ins.prefixes.repne || ins.prefixes.lock)
    {
        return null;
    }
    /** @param {boolean} store */
    const access = store=>({ operand: mem, size: mem.size, store, stack: 0 });
    if (X87_OPCODE.test(ins.opcode))
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
 * The accesses of an instruction a group can take: `accessOf`'s one, or the
 * two of a `push`, `call` or `jmp` through memory -- the operand read, then
 * the push.
 *
 * @param {import('../decode/decoder.js').Instruction} ins
 * @returns {Place[]}
 */
function groupAccessesOf(ins){
    const { op, operands, prefixes } = ins;
    if (!ins.memory && !STACK_OPS.has(op))
    {
        return NO_PLACES;
    }
    const [dst] = operands;
    if ((op === 'push' || op === 'call' || op === 'jmp') && dst?.kind === 'mem' && dst.size === 4
        && !prefixes.operand && dst.addressSize !== 16 && dst.segment !== 4 && dst.segment !== 5)
    {
        const read = placeOf({ operand: dst, size: 4, store: false, stack: 0 });
        return op === 'jmp' ? [read]
            : [read, placeOf({ operand: null, size: 4, store: true, stack: -4 })];
    }
    const access = accessOf(ins);
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
 *     returns?: Map<number, number[]>, reach?: boolean }} [options]  entry: the
 *     region's entry; backward: a jump back can carry windows (the dispatch
 *     takes an inner label for it); heads: blocks that take none (a
 *     structured region's loop heads); returns: by ret block, the return
 *     addresses it jumps to (`inlineReturns`); reach: false keeps every group
 *     within its block
 * @returns {RegionPlan}
 */
export function planRegion(blocks, options = {}){
    const { entry = blocks[0]?.start ?? 0, backward = false, heads = new Set(),
        returns = new Map(), reach = true } = options;
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
        for (let r = 1; r < 8; r++)
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
        for (let i = 0; i < instructions.length; i++)
        {
            const ins = instructions[i];
            const places = groupAccessesOf(ins);
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
            effect(ins, values);
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
            walk(s, freshValues(next), new Map(), 0);
        }
    });
    // A window's test costs what one access's does.
    const kept = new Set(groups.filter(group=>group.list.length >= 2));
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
            : entryTests({ blocks, children, joined, next }, s, covered, dropped);
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
 *     joined: (Joined | undefined)[], next: { n: number } }} walked
 *     the region's blocks, which take from which, the group of each access
 * @param {number} s @param {Set<Access>} reached @param {Set<Access>} dropped
 * @returns {Group[]}
 */
function entryTests({ blocks, children, joined, next }, s, reached, dropped){
    const values = freshValues(next);
    const first = values.sym[0];
    /** The register a value was in at the start, or -1. @param {number} sym */
    const held = sym=>(sym >= first && sym < first + 8 ? sym - first : -1);
    /** One window per group and register: each within its group's 4096 bytes. */
    /** @type {Map<Growing, Map<string, Group & { hi: number }>>} */
    const windows = new Map();
    /** @param {number} t @param {Values} at */
    const visit = (t, at)=>{
        blocks[t].instructions.forEach((ins, i)=>{
            groupAccessesOf(ins).forEach(({ base, index, scale, disp, size, store }, k)=>{
                // The walk joined every access of every block to a group.
                const { group, access } = /** @type {{ group: Growing, access: Access }[]} */ (
                    /** @type {Joined} */ (joined[t]).get(i))[k];
                if (!reached.has(access))
                {
                    return;
                }
                const from = base < 0 ? -1 : held(at.sym[base]);
                const by = index < 0 ? -1 : held(at.sym[index]);
                if ((base >= 0 && from < 0) || (index >= 0 && by < 0))
                {
                    dropped.add(access);
                    return;
                }
                const off = disp + (base < 0 ? 0 : at.delta[base])
                    + (index < 0 ? 0 : at.delta[index] * scale);
                const own = windows.get(group) ?? new Map();
                windows.set(group, own);
                const key = `${from}.${by}.${scale}`;
                const window = own.get(key) ?? { base: from, index: by, scale, db: 0, di: 0,
                    first: 0, list: [], lo: off, hi: off + size, width: 0 };
                own.set(key, window);
                window.list.push({ block: t, i, off, size, store });
                window.lo = Math.min(window.lo, off);
                window.hi = Math.max(window.hi, off + size);
                window.width = window.hi - window.lo;
            });
            effect(ins, at);
        });
        for (const child of children[t] ?? [])
        {
            visit(child, copyValues(at));
        }
    };
    visit(s, values);
    return [...windows.values()].flatMap(own=>[...own.values()]);
}

/**
 * Eight registers holding values of their own.
 *
 * @param {{ n: number }} next  the count the values are numbered from
 * @returns {Values}
 */
function freshValues(next){
    const n = next.n;
    next.n += 8;
    return { sym: [n, n + 1, n + 2, n + 3, n + 4, n + 5, n + 6, n + 7],
        delta: [0, 0, 0, 0, 0, 0, 0, 0], next };
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
 */
function effect(ins, values, forward = false){
    const { op, operands, prefixes } = ins;
    const [dst, src] = operands;
    const { sym, delta } = values;
    const reg32 = dst?.kind === 'reg' && dst.size === 4 ? /** @type {number} */ (dst.reg) : -1;
    const from = src?.kind === 'reg' && src.size === 4 ? /** @type {number} */ (src.reg) : -1;
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
    if (op === 'push' && (ins.size === 4 || ins.size === 2) && dst.kind !== 'seg')
    {
        delta[4] -= ins.size;
        return;
    }
    if (op === 'pop' && reg32 >= 0)
    {
        delta[4] += 4;
        bumpReg(values, reg32);
        return;
    }
    if ((op === 'pushf' || op === 'popf' || op === 'call' || op === 'ret') && !prefixes.operand)
    {
        // A call pushes its return address; a return pops it, and imm16 more.
        delta[4] += op === 'pushf' || op === 'call' ? -4
            : 4 + (op === 'ret' && dst?.kind === 'imm' ? /** @type {number} */ (dst.value) : 0);
        return;
    }
    if (op === 'leave' && !prefixes.operand)
    {
        copyReg(values, 4, 5, 4);
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
        copyReg(values, reg32, from, 0);
        sym[from] = held;
        delta[from] = by;
        return;
    }
    if (op === 'lea' && reg32 >= 0)
    {
        if ((src.base ?? -1) >= 0 && (src.index ?? -1) < 0 && src.addressSize !== 16)
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
    const known = byOp || X87_OPCODE.test(ins.opcode) || operands.some(o=>o.kind === 'xmm');
    if (!known || op === 'push' || op === 'pop')
    {
        for (let r = 0; r < 8; r++)
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
 * A register given a value of its own.
 *
 * @param {Values} values @param {number} r
 */
function bumpReg(values, r){
    values.sym[r] = values.next.n++;
    values.delta[r] = 0;
}

/**
 * A register given another's value, moved by `by`.
 *
 * @param {Values} values @param {number} r @param {number} from @param {number} by
 */
function copyReg(values, r, from, by){
    values.sym[r] = values.sym[from];
    values.delta[r] = values.delta[from] + by;
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
    const { b } = e;
    const table = e.layout.tables + Tables.PAGE_FLAGS;
    const flagsOf = (/** @type {number} */ offset)=>{
        b.localGet(Local.addr);
        if (offset !== 0)
        {
            b.i32const(offset).op(I32.add);
        }
        b.i32const(12).op(I32.shrU).load('i32_8u', { offset: table });
    };
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
        if (group.base >= 0)
        {
            b.localGet(Local.reg + group.base);
        }
        else
        {
            b.i32const(0);
        }
        if (group.index >= 0)
        {
            b.localGet(Local.reg + group.index).i32const(group.scale).op(I32.mul).op(I32.add);
        }
        b.i32const((group.lo - group.db - group.di * group.scale) | 0).op(I32.add)
            .localSet(Local.addr);
        // The common case is one test, as for a single access: the flags of
        // the window's page and the next, read as a halfword (the window lies
        // in the two), against INACCESSIBLE -- and against HAS_CODE for a
        // group that stores. Only when a flag is up are the window's own
        // pages and the stores' granules looked at.
        const stores = group.list.filter(access=>access.store);
        const bits = PageFlag.INACCESSIBLE | (stores.length > 0 ? PageFlag.HAS_CODE : 0);
        b.localGet(Local.addr).i32const(12).op(I32.shrU).load('i32_16u', { offset: table })
            .i32const(bits * 0x101).op(I32.and);
        e.openGuard('window', EMPTY);
        flagsOf(0);
        flagsOf(group.width - 1);
        b.op(I32.or).i32const(PageFlag.INACCESSIBLE).op(I32.and);
        leaveIf('windowFaults');
        if (stores.length > 0)
        {
            const first = Math.min(...stores.map(a=>a.off)) - group.lo;
            const last = Math.max(...stores.map(a=>a.off + a.size)) - 1 - group.lo;
            flagsOf(first);
            flagsOf(last);
            b.op(I32.or).i32const(PageFlag.HAS_CODE).op(I32.and);
            e.openGuard('windowCode', EMPTY);
            stores.forEach((access, k)=>{
                for (const end of access.size > 1 ? [0, access.size - 1] : [0])
                {
                    b.localGet(Local.addr).i32const(access.off - group.lo + end).op(I32.add)
                        .call(e.context.codeHit);
                    if (k > 0 || end > 0)
                    {
                        b.op(I32.or);
                    }
                }
            });
            leaveIf('storeCode');
            e.close();
        }
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
 *     stride: number, store: boolean }} Stream
 */

/**
 * The accesses of a self-looping block that go off registers moved by a
 * fixed stride a turn, as streams, with the plan the unchecked copy is
 * emitted under and how many turns one test of the streams covers; null
 * when no access qualifies.
 *
 * @param {import('../decode/decoder.js').Instruction[]} instructions
 * @returns {{ plan: Map<number, Planned>, streams: Stream[], turns: number,
 *     forward: boolean } | null}  `forward`: planned for DF clear
 */
export function planLoop(instructions){
    // A string instruction moves its pointers by its size a turn while DF is
    // clear, and a loop that writes no DF keeps it as it was found: such a
    // loop is planned for DF clear, and its window test takes DF too.
    const forward = instructions.every(ins=>(ins.flagsWritten & DF) === 0);
    const values = freshValues({ n: 0 });
    const { sym: initial } = copyValues(values);
    const { delta } = values;
    /** @type {{ i: number, base: number, index: number, scale: number, off: number,
     *     size: number, store: boolean }[]} */
    const found = [];
    /** How many accesses each instruction makes that a stream could take. */
    const made = instructions.map(()=>0);
    instructions.forEach((ins, i)=>{
        const accesses = loopAccessesOf(ins, forward);
        made[i] = accesses.length;
        for (const { base, index, scale, disp, size, store } of accesses)
        {
            // Off the values registers held as the turn found them, moved by
            // known amounts -- each by the register that held it then.
            const from = base < 0 ? -1 : initial.indexOf(values.sym[base]);
            const by = index < 0 ? -1 : initial.indexOf(values.sym[index]);
            if ((base < 0 || from >= 0) && (index < 0 || by >= 0))
            {
                const off = disp + (base >= 0 ? delta[base] : 0)
                    + (index >= 0 ? delta[index] * scale : 0);
                found.push({ i, base: from, index: by, scale, off, size, store });
            }
        }
        effect(ins, values, forward);
    });
    /** A register holding its own value of the turn's start, moved by `delta`. @param {number} r */
    const fixed = r=>r < 0 || values.sym[r] === initial[r];
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
    return { plan, streams: kept, turns, forward: strings };
}

/**
 * The accesses of an instruction a loop's streams can take: those a group
 * takes (`groupAccessesOf`), or with DF known clear the element accesses of
 * a string instruction with no repeat, off esi and edi.
 *
 * @param {import('../decode/decoder.js').Instruction} ins
 * @param {boolean} forward
 * @returns {Place[]}
 */
function loopAccessesOf(ins, forward){
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
    return groupAccessesOf(ins);
}

/**
 * Leaves 1 on the stack when every page the streams reach in the next
 * `turns` turns is accessible, and holds no code where a stream stores; 0
 * otherwise. Each stream's reach is at most 8192 bytes, so its first page,
 * the one 4096 bytes on and its last cover it.
 *
 * @param {E} e @param {Stream[]} streams @param {number} turns
 * @param {boolean} [forward]  the streams move as they do with DF clear: 0
 *     when it is set
 */
export function emitStreamWindow(e, streams, turns, forward = false){
    const { b } = e;
    const table = e.layout.tables + Tables.PAGE_FLAGS;
    if (forward)
    {
        b.localGet(Local.flags).i32const(DF).op(I32.and);
    }
    else
    {
        b.i32const(0);
    }
    for (const stream of streams)
    {
        const span = (turns - 1) * stream.stride;
        const from = stream.lo + Math.min(0, span);
        const width = stream.hi - stream.lo + Math.abs(span);
        if (stream.base >= 0)
        {
            b.localGet(Local.reg + stream.base);
        }
        else
        {
            b.i32const(0);
        }
        if (stream.index >= 0)
        {
            b.localGet(Local.reg + stream.index).i32const(stream.scale).op(I32.mul).op(I32.add);
        }
        b.i32const(from | 0).op(I32.add).localSet(Local.addr);
        const bits = PageFlag.INACCESSIBLE | (stream.store ? PageFlag.HAS_CODE : 0);
        [0, Math.min(4096, width - 1), width - 1].forEach((at, k)=>{
            b.localGet(Local.addr);
            if (at !== 0)
            {
                b.i32const(at).op(I32.add);
            }
            b.i32const(12).op(I32.shrU).load('i32_8u', { offset: table });
            if (k > 0)
            {
                b.op(I32.or);
            }
        });
        // This stream's flagged pages, into the word under it.
        b.i32const(bits).op(I32.and).op(I32.or);
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
    e.b.localGet(Local.reg + 4).localSet(Local.addr);
    checkAccess(e, size);
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
