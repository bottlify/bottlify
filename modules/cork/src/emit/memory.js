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
 * protections. The test is a shift, a byte load and a branch per access
 * (two loads when the access may span a page); `roadmap/cork-plan.md` 2.9
 * measures its share.
 */

import { Body, EMPTY, ValType } from '../wasm/encoder.js';
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
    e.openIf('flagged', EMPTY);
    if (size > 1)
    {
        b.localGet(Local.addr).i32const(12).op(I32.shrU).load('i32_8u', { offset: table });
        b.localGet(Local.addr).i32const(size - 1).op(I32.add).i32const(12).op(I32.shrU)
            .load('i32_8u', { offset: table }).op(I32.or).localSet(Local.pflags);
    }
    b.localGet(Local.pflags).i32const(PageFlag.INACCESSIBLE).op(I32.and);
    e.openIf('inaccessible', EMPTY);
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
        e.openIf('maybeCode', EMPTY);
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
        e.openIf('maybeCode', EMPTY);
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
    e.openIf('code', EMPTY);
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

// --- the block's access groups ---
//
// Most of a block's accesses go off a register the block does not change in
// between -- a frame through esp or ebp, a struct through one pointer, an
// array through a base and an index -- or off an address in the instruction.
// Such a group's accesses lie in a window known from the register values at
// its first access, and a window of at most 4096 bytes spans at most two
// pages, each touched by one of the accesses. So the group is checked once,
// at its first access: both pages' flags against INACCESSIBLE, and the
// stores' own window against code -- to the granule, through `codeHit`,
// only when a page is flagged. A clean window leaves every access of the
// group with no test at all. A window that would fault or note a store into
// code leaves the region before that first access, untranslated, and the
// interpreter runs the block's rest with a check on every access: the fault
// is raised at its instruction and the note made at its store, as they
// would be here. The plan is made from the decoded operands before the block
// is emitted, and the emitter's own calls are held to it -- an access the
// plan did not foresee, or a store it took for a load, is an error rather
// than a check left out.

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

/**
 * @typedef {{ i: number, off: number, size: number, store: boolean }} Access
 * @typedef {{ base: number, index: number, scale: number, db: number, di: number,
 *     first: number, list: Access[], lo: number, width: number }} Group
 * @typedef {{ checks: Group[], access: Access | null, size: number, store: boolean,
 *     used: boolean }} Planned
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
 * The access groups of a block's instructions, by the instruction each
 * group is checked at and the instruction each access belongs to.
 *
 * @param {import('../decode/decoder.js').Instruction[]} instructions
 * @returns {Map<number, Planned>}
 */
export function planBlock(instructions){
    // Each register's version (a write it cannot follow starts a new one)
    // and its offset from the version's value (push, pop, add/sub/inc/dec).
    const version = new Array(8).fill(0);
    const delta = new Array(8).fill(0);
    /** @param {number} r */
    const bump = r=>{
        version[r]++;
        delta[r] = 0;
    };
    /** @type {Map<string, Group>} */
    const groups = new Map();
    instructions.forEach((ins, i)=>{
        const access = accessOf(ins);
        if (access !== null)
        {
            const mem = access.operand;
            const base = mem === null ? 4 : mem.base ?? -1;
            const index = mem === null ? -1 : mem.index ?? -1;
            const scale = mem === null ? 1 : mem.scale ?? 1;
            const db = base >= 0 ? delta[base] : 0;
            const di = index >= 0 ? delta[index] : 0;
            const off = (mem === null ? access.stack : mem.disp ?? 0) + db + di * scale;
            const key = `${base}.${base >= 0 ? version[base] : 0}.${index}.`
                + `${index >= 0 ? version[index] : 0}.${scale}`;
            let group = groups.get(key);
            if (group === undefined)
            {
                group = { base, index, scale, db, di, first: i, list: [], lo: 0, width: 0 };
                groups.set(key, group);
            }
            group.list.push({ i, off, size: access.size, store: access.store });
        }
        effect(ins, delta, bump);
    });
    /** @type {Map<number, Planned>} */
    const plan = new Map();
    /** @param {number} i */
    const at = i=>{
        let entry = plan.get(i);
        if (entry === undefined)
        {
            entry = { checks: [], access: null, size: 0, store: false, used: false };
            plan.set(i, entry);
        }
        return entry;
    };
    for (const group of groups.values())
    {
        // Two loads cost their own checks what the window's costs; a store
        // among them has its code test folded in too.
        if (group.list.length < (group.list.some(access=>access.store) ? 2 : 3))
        {
            continue;
        }
        const lo = Math.min(...group.list.map(a=>a.off));
        const hi = Math.max(...group.list.map(a=>a.off + a.size));
        if (hi - lo > 4096)
        {
            continue;
        }
        group.lo = lo;
        group.width = hi - lo;
        at(group.first).checks.push(group);
        for (const access of group.list)
        {
            const entry = at(access.i);
            entry.access = access;
            entry.size = access.size;
            entry.store = access.store;
        }
    }
    return plan;
}

/**
 * What an instruction does to the registers the groups follow: a push, a
 * pop and an add, sub, inc or dec of a register by a constant move it by a
 * known amount; a write they cannot follow starts the register afresh; an
 * operation not known here starts every register afresh.
 *
 * @param {import('../decode/decoder.js').Instruction} ins
 * @param {number[]} delta @param {(r: number) => void} bump
 */
function effect(ins, delta, bump){
    const { op, operands } = ins;
    const [dst, src] = operands;
    const reg32 = dst?.kind === 'reg' && dst.size === 4 ? /** @type {number} */ (dst.reg) : -1;
    if (op === 'push' && (ins.size === 4 || ins.size === 2) && dst.kind !== 'seg')
    {
        delta[4] -= ins.size;
        return;
    }
    if (op === 'pop' && reg32 >= 0)
    {
        delta[4] += 4;
        bump(reg32);
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
    if (op === 'lea' && reg32 >= 0)
    {
        if (src.base === reg32 && (src.index ?? -1) < 0 && src.addressSize !== 16)
        {
            delta[reg32] += src.disp ?? 0;
        }
        else
        {
            bump(reg32);
        }
        return;
    }
    if (op === 'cdq' || op === 'cwde')
    {
        bump(op === 'cdq' ? 2 : 0);
        return;
    }
    if (op === 'imul' && operands.length === 1)
    {
        // The widening form: edx:eax.
        bump(0);
        bump(2);
        return;
    }
    const known = X87_OPCODE.test(ins.opcode) || operands.some(o=>o.kind === 'xmm')
        || INT_WRITE_DST.has(op) || INT_PURE.has(op) || op.startsWith('set')
        || op.startsWith('cmov') || op.startsWith('j');
    if (!known || op === 'push' || op === 'pop')
    {
        for (let r = 0; r < 8; r++)
        {
            bump(r);
        }
        return;
    }
    if (dst?.kind === 'reg' && !INT_PURE.has(op))
    {
        bump(/** @type {number} */ (dst.reg));
    }
}

/**
 * The groups checked at the instruction about to be emitted: each window's
 * pages tested once, and the instruction left untranslated when one would
 * fault or a store would land in code.
 *
 * @param {E} e @param {Group[]} checks
 */
export function emitGroupChecks(e, checks){
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
    const leave = ()=>{
        e.blockRetired--;
        e.exitAt(e.current.eip, Exit.UNTRANSLATED, HELD);
        e.blockRetired++;
    };
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
        flagsOf(0);
        flagsOf(group.width - 1);
        b.op(I32.or).i32const(PageFlag.INACCESSIBLE).op(I32.and);
        e.openIf('window', EMPTY);
        leave();
        e.close();
        const stores = group.list.filter(access=>access.store);
        if (stores.length === 0)
        {
            continue;
        }
        const first = Math.min(...stores.map(a=>a.off)) - group.lo;
        const last = Math.max(...stores.map(a=>a.off + a.size)) - 1 - group.lo;
        flagsOf(first);
        flagsOf(last);
        b.op(I32.or).i32const(PageFlag.HAS_CODE).op(I32.and);
        e.openIf('windowCode', EMPTY);
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
        e.openIf('storeCode', EMPTY);
        leave();
        e.close();
        e.close();
    }
}

// --- a loop's access streams ---
//
// A block that loops onto itself moves the registers its accesses go off by
// the same amount every turn when it changes them only by push, pop and a
// constant add, sub, inc or dec. Each such group of accesses (one base, one
// index, one scale) is then a stream: its window moves by a fixed stride a
// turn. The turns a stride of at most 4096 bytes takes span at most three
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
 * @returns {{ plan: Map<number, Planned>, streams: Stream[], turns: number } | null}
 */
export function planLoop(instructions){
    const version = new Array(8).fill(0);
    const delta = new Array(8).fill(0);
    /** @param {number} r */
    const bump = r=>{
        version[r]++;
        delta[r] = 0;
    };
    /** @type {{ i: number, base: number, index: number, scale: number, off: number,
     *     size: number, store: boolean }[]} */
    const found = [];
    instructions.forEach((ins, i)=>{
        const access = accessOf(ins);
        if (access !== null)
        {
            const mem = access.operand;
            const base = mem === null ? 4 : mem.base ?? -1;
            const index = mem === null ? -1 : mem.index ?? -1;
            const scale = mem === null ? 1 : mem.scale ?? 1;
            // Off the registers as the turn found them, moved by known amounts.
            if ((base < 0 || version[base] === 0) && (index < 0 || version[index] === 0))
            {
                const off = (mem === null ? access.stack : mem.disp ?? 0)
                    + (base >= 0 ? delta[base] : 0) + (index >= 0 ? delta[index] * scale : 0);
                found.push({ i, base, index, scale, off, size: access.size, store: access.store });
            }
        }
        effect(ins, delta, bump);
    });
    /** @param {number} r */
    const fixed = r=>r < 0 || version[r] === 0;
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
        const key = `${access.base}.${access.index}.${access.scale}`;
        const stride = (access.base >= 0 ? delta[access.base] : 0)
            + (access.index >= 0 ? delta[access.index] * access.scale : 0);
        let stream = streams.get(key);
        if (stream === undefined)
        {
            stream = { base: access.base, index: access.index, scale: access.scale,
                lo: access.off, hi: access.off + access.size, stride, store: false };
            streams.set(key, stream);
        }
        stream.lo = Math.min(stream.lo, access.off);
        stream.hi = Math.max(stream.hi, access.off + access.size);
        stream.store ||= access.store;
        plan.set(access.i, { checks: [], access: { i: access.i, off: access.off,
            size: access.size, store: access.store }, size: access.size, store: access.store,
        used: false });
    }
    const kept = [...streams.values()].filter(stream=>stream.hi - stream.lo <= 4096
        && Math.abs(stream.stride) <= 4096);
    if (kept.length === 0)
    {
        return null;
    }
    for (const i of [...plan.keys()])
    {
        const access = found.find(a=>a.i === i);
        if (!kept.some(s=>s.base === access?.base && s.index === access.index
            && s.scale === access.scale))
        {
            plan.delete(i);
        }
    }
    const widest = Math.max(...kept.map(stream=>Math.abs(stream.stride)));
    const turns = widest === 0 ? 1 << 16 : 1 + Math.floor(4096 / widest);
    return { plan, streams: kept, turns };
}

/**
 * Leaves 1 on the stack when every page the streams reach in the next
 * `turns` turns is accessible, and holds no code where a stream stores; 0
 * otherwise. Each stream's reach is at most 8192 bytes, so its first page,
 * the one 4096 bytes on and its last cover it.
 *
 * @param {E} e @param {Stream[]} streams @param {number} turns
 */
export function emitStreamWindow(e, streams, turns){
    const { b } = e;
    const table = e.layout.tables + Tables.PAGE_FLAGS;
    b.i32const(0);
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
    e.openIf('stale', EMPTY);
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
