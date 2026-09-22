/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A region becomes one wasm function.
 *
 * The function takes the label of the block to enter and the slice's
 * instruction budget, and answers how it left. Its shape:
 *
 *     prologue      the eight registers and the flags word loaded into locals
 *     block $out
 *       loop $dispatch
 *         block … block   one nested block per basic block, innermost first
 *           br_table label
 *         end  block 0's code: instructions, then its exit
 *         end  block 1's code …
 *       end
 *     end
 *     epilogue      locals written back to the state block; the exit kind returned
 *
 * A jump to another block of the region sets the label and branches back to
 * the dispatch loop, charging the instructions retired since the last
 * charge against the budget and leaving with `budget` when it is spent. A
 * block that falls through to the block emitted right after it does nothing
 * at all. Anything the region cannot continue -- a return, an indirect
 * jump, a call, an instruction the emitter does not translate -- writes the
 * next address into the state and leaves with `untranslated`, for the host
 * to run on the other executor or to dispatch to another region.
 *
 * Arithmetic flags are lazy (`flags.js`): an instruction records its
 * operation and operands, a reader in the same block computes the flag it
 * needs from the record, and the record is folded into the flags word only
 * where a whole word is needed. A dead-flag pass per block skips the record
 * for an instruction whose flags nothing reads before the next writer.
 */

import { CF, DF, OF, ARITH_FLAGS } from '../decode/table.js';
import { Body, EMPTY, ValType } from '../wasm/encoder.js';
import {
    ARITH, I32, Kind, addMaterialiseHelper, emitCondition, emitFlag, kindOf, widthCode,
} from './flags.js';
import { emitInstruction } from './integer.js';
import { addCodeHitHelper, addUndoHelper, emitStaleExit } from './memory.js';
import { Tables } from '../runtime/layout.js';
import { ANY_TOP } from '../runtime/entries.js';
import {
    addF80Helpers, addRoundHelper, isX87, prepareX87, regionHasMmx, sameState, x87BlockStart,
    x87Edge, x87Epilogue, x87Normalise,
    x87Prologue,
} from './x87.js';

/**
 * The host functions a module imports for the transcendentals, by name; an
 * instantiation supplies each from `Math` (`mathImports()`).
 */
export const MATH_IMPORTS = Object.freeze([
    'sin', 'cos', 'tan', 'atan2', 'exp2m1', 'log2', 'log1p',
]);

/** The import object entries for `MATH_IMPORTS`. */
export function mathImports(){
    return {
        sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2,
        /** @param {number} x */
        exp2m1: x=>Math.expm1(x * Math.LN2),
        log2: Math.log2, log1p: Math.log1p,
    };
}

/** How a run of translated code came back, as the low byte of the result. */
export const Exit = Object.freeze({
    UNTRANSLATED: 0, BUDGET: 1, TRAP: 2, HALT: 3, FAULT: 4, STALE: 5,
});

/**
 * The bits of a run's MMX mark (`Local.mmxTouched`). The first MMX
 * instruction of a run sets both; an `emms` clears the hold and leaves
 * the top, so the region's exit writes the one and not the other.
 */
export const MMX_HELD = 1;
export const MMX_TOP = 2;

/** Local indices every region function shares. */
export const Local = Object.freeze({
    label: 0, budget: 1,
    // 2..9: eax ecx edx ebx esp ebp esi edi
    reg: 2,
    kind: 10, res: 11, op1: 12, op2: 13, cin: 14, flags: 15,
    retired: 16, eip: 17, t0: 18, t1: 19, t2: 20, addr: 21, t64: 22, t64b: 23,
    count: 24, f0: 25, f1: 26, d0: 27, d1: 28, mmxTouched: 29,
    // the page flags of the current access, and whether a store hit a code page
    pflags: 30, stale: 31,
    // the x87 top, empty mask, status and control words, and the dirty mask
    x87Top: 32, x87Empty: 33, x87Status: 34, x87Control: 35, x87Dirty: 36,
    // 37, 38, 39: three v128 scratch locals when SIMD is available; the xmm
    // and mm locals a region uses follow, then the x87 locals, per region.
    vec: 37,
});
const LOCAL_TYPES = [
    // the eight registers
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32,
    ValType.i32,
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, // kind..flags
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, // retired..addr
    ValType.i64, ValType.i64,
    ValType.i32, // count
    ValType.f32, ValType.f32, ValType.f64, ValType.f64, // f0 f1 d0 d1
    ValType.i32, // mmxTouched
    ValType.i32, ValType.i32, // pflags stale
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, // x87Top..x87Dirty
];

/**
 * What a module carries that every region function in it uses.
 *
 * @typedef {Object} ModuleContext
 * @property {import('../wasm/encoder.js').ModuleBuilder} m
 * @property {number} regionType       the function type (i32, i32) → i32
 * @property {number} materialise      the flag helper's function index
 * @property {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @property {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @property {number} [undo]           the undo helper's function index, in a differential build
 * @property {number} codeHit          the helper telling whether a byte lies in translated code
 * @property {number} [getEflags]      the host's flag fold, imported when the layout keeps
 *                                     lazy flags (the emulator's `flags_changed`)
 * @property {number} f80ToF64         the extended-precision readers
 * @property {number} f64ToF80
 * @property {number} round            the rounding-control helper
 * @property {Record<string, number>} math  the transcendentals imported from the host
 * @property {boolean} hash            an untranslated exit probes the entry hash and
 *                                     tail-calls the region found, through the host's table
 * @property {number} [trapPort]       the port a write to which is the host's call channel
 * @property {Set<string>} leaveOut    instruction classes (x87, mmx, sse) a region exits before
 * @property {number} [trap]           the host's trap import, called from inside a region
 */

/**
 * Prepares a module for region functions: the memory import, the flag
 * helper, the region function type.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @param {{ shared?: boolean, maxPages?: number }} [memory]
 * @param {{ undoLog?: boolean, hash?: boolean, trapPort?: number, leaveOut?: Set<string> }}
 *     [options]  undoLog:
 *     record every store's old bytes (differential builds only; part of the cache key);
 *     hash: import the host's function table and transfer through the entry hash (needs
 *     tail calls); trapPort: `out dx, eax` to it leaves with a trap exit
 * @returns {ModuleContext}
 */
export function prepareModule(m, layout, features, memory = {},
    { undoLog = false, hash = false, trapPort, leaveOut = new Set() } = {})
{
    m.importMemory('env', 'memory', {
        min: 1, ...(memory.maxPages === undefined ? {} : { max: memory.maxPages }),
        shared: memory.shared ?? false,
    });
    const hashed = hash && features.tailCalls;
    if (hashed)
    {
        m.importTable('env', 'table', 0);
    }
    // The host's call channel, when the layout has a port for it: called
    // from inside a region with the state block written back, it answers
    // whether the handler moved EIP.
    const trap = trapPort === undefined
        ? undefined
        : m.importFunction('env', 'trap',
            m.type({ params: [ValType.i32], results: [ValType.i32] }));
    // Imports come before the helpers, which are functions.
    const getEflags = layout.flagsChanged >= 0
        ? m.importFunction('env', 'getEflags', m.type({ params: [], results: [ValType.i32] }))
        : undefined;
    // The transcendentals wasm has no operation for, as the host's Math.
    const unary = m.type({ params: [ValType.f64], results: [ValType.f64] });
    const binary = m.type({ params: [ValType.f64, ValType.f64], results: [ValType.f64] });
    /** @type {Record<string, number>} */
    const math = {};
    for (const name of MATH_IMPORTS)
    {
        math[name] = m.importFunction('env', name, name === 'atan2' ? binary : unary);
    }
    const regionType = m.type({ params: [ValType.i32, ValType.i32], results: [ValType.i32] });
    const materialise = addMaterialiseHelper(m);
    const { f80ToF64, f64ToF80 } = addF80Helpers(m);
    const round = addRoundHelper(m);
    const codeHit = addCodeHitHelper(m, layout);
    /** @type {ModuleContext} */
    const context = {
        m, regionType, materialise, layout, features, f80ToF64, f64ToF80, round, math,
        hash: hashed, codeHit, leaveOut,
    };
    if (trapPort !== undefined)
    {
        context.trapPort = trapPort;
        context.trap = trap;
    }
    if (getEflags !== undefined)
    {
        context.getEflags = getEflags;
    }
    if (undoLog)
    {
        context.undo = addUndoHelper(m, layout);
    }
    return context;
}

/**
 * @typedef {Object} Translation
 * @property {number} functionIndex
 * @property {Map<number, number>} labels     block start eip → label
 * @property {Map<string, number>} unsupported  opcode → instructions the emitter left out
 * @property {Map<string, number>} refusals  `opcode (reason; entry kinds; entry x87)` → count
 * @property {number} instructions
 * @property {Set<number>} cut      labels of blocks with no entry of their own: ones that
 *     leave at once (an x87 state conflict, nothing decoded, the first instruction left out)
 *     and ones compiled for the x87 stack in another shape than the entry's
 * @property {number} entryTop      the x87 top the function was compiled for
 * @property {number} loops         blocks emitted as wasm loops onto themselves
 */

/**
 * Adds a region's function to the module.
 *
 * @param {ModuleContext} context
 * @param {import('../region.js').Region} region
 * @param {{ entryTop?: number }} [options]  the x87 top the entry is compiled for
 * @returns {Translation}
 */
export function emitRegion(context, region, options = {}){
    const emitter = new RegionEmitter(context, region, options);
    return emitter.emit();
}

/** The state the emitter keeps while writing one function. */
export class RegionEmitter {
    /**
     * @param {ModuleContext} context
     * @param {import('../region.js').Region} region
     * @param {{ entryTop?: number }} [options]
     */
    constructor(context, region, { entryTop = 0 } = {}){
        this.context = context;
        this.layout = context.layout;
        this.region = region;
        this.b = new Body();
        /** @type {Map<number, number>} */
        this.labels = new Map(region.blocks.map((block, index)=>[block.start, index]));
        /** @type {string[]} the open control labels, innermost last */
        this.controls = [];
        /**
         * What the flag record holds at this point of the block, when known:
         * the unfolded kind and width code, or null when the block was
         * entered from elsewhere and the record is whatever the last
         * instruction anywhere left in it.
         *
         * @type {{ kind: number, width: number } | null}
         */
        this.pending = null;
        /** @type {Map<string, number>} */
        this.unsupported = new Map();
        /**
         * Why each left-out instruction was left out and the shape of the
         * block it sat in: `opcode (reason; entry kinds; entry x87)`. What
         * `unsupported` counts by opcode, split by cause, for the diagnostics.
         * @type {Map<string, number>}
         */
        this.refusals = new Map();
        /** The x87 emitter's reason for the current instruction being left out.
         * @type {string | null} */
        this.x87RefusalReason = null;
        /**
         * Blocks that leave before retiring anything (nothing decoded, or
         * the first instruction left out): no entry is made for them, since
         * a transfer into one would come straight back to the same address.
         * @type {Set<number>}
         */
        this.leaving = new Set();
        this.blockIndex = 0;
        /** Whether the current block is a wasm loop onto itself (see `emitBlock`). */
        this.selfLoop = false;
        /** Whether the block's port write called the host from here and went on. */
        this.trapped = false;
        /** Blocks emitted as loops onto themselves. */
        this.loops = 0;
        /** Whether the current block's remaining instructions are unreachable. */
        this.dead = false;
        /** Instructions retired in the current block so far, to charge at its end. */
        this.blockRetired = 0;
        this.instructions = 0;
        // The vector registers the region touches, found by a scan, each given
        // a local: loaded in the prologue, and written back when written.
        /** @type {Map<number, number>} xmm index -> local */
        this.xmmLocals = new Map();
        /** @type {Map<number, number>} mm index -> local */
        this.mmLocals = new Map();
        /** @type {Set<number>} */
        this.xmmWritten = new Set();
        /** @type {Set<number>} */
        this.mmWritten = new Set();
        /** The instruction being emitted. @type {import('../decode/decoder.js').Instruction} */
        this.current = region.blocks[0].instructions[0];
        /** A store was emitted for the current instruction: check `stale` after it. */
        this.staleCheck = false;
        /** The control depth at the start of the block being emitted. */
        this.blockDepth = 0;
        /** @type {number[]} */
        this.localTypes = [...LOCAL_TYPES];
        this.entryTop = entryTop;
        // A region that translates both classes keeps the eight registers as one
        // set with two views, so every register needs an mm local (the mantissa)
        // beside its x87 local (the value): an exchange or a write of either
        // class moves the other's, and a register only one class touches is
        // still written back in the form the other left it. Allocate all eight
        // mm locals there; elsewhere only the operands'.
        const mixed = context.features.simd
            && !context.leaveOut.has('x87')
            && region.blocks.some(block=>block.instructions.some(isX87))
            && regionHasMmx(region, context.leaveOut);
        if (context.features.simd)
        {
            this.localTypes.push(ValType.v128, ValType.v128, ValType.v128);
            for (const block of region.blocks)
            {
                for (const instruction of block.instructions)
                {
                    for (const operand of instruction.operands)
                    {
                        if (operand.kind === 'xmm' && !this.xmmLocals.has(/** @type {number} */ (operand.reg)))
                        {
                            this.xmmLocals.set(/** @type {number} */ (operand.reg), this.localTypes.length + 2);
                            this.localTypes.push(ValType.v128);
                        }
                    }
                }
            }
            if (mixed)
            {
                for (let p = 0; p < 8; p++)
                {
                    this.mmLocals.set(p, this.localTypes.length + 2);
                    this.localTypes.push(ValType.i64);
                }
            }
            else
            {
                for (const block of region.blocks)
                {
                    for (const instruction of block.instructions)
                    {
                        for (const operand of instruction.operands)
                        {
                            if (operand.kind === 'mm' && !this.mmLocals.has(/** @type {number} */ (operand.reg)))
                            {
                                this.mmLocals.set(/** @type {number} */ (operand.reg), this.localTypes.length + 2);
                                this.localTypes.push(ValType.i64);
                            }
                        }
                    }
                }
            }
        }
        /** The x87 emission state: the tracker's states per block and the locals. */
        this.x87 = prepareX87(this, entryTop);
    }

    /** The local an xmm register lives in. @param {number} index @param {boolean} [write] */
    xmmLocal(index, write = false){
        if (write)
        {
            this.xmmWritten.add(index);
        }
        return /** @type {number} */ (this.xmmLocals.get(index));
    }

    /** The local an mm register lives in. @param {number} index @param {boolean} [write] */
    mmLocal(index, write = false){
        if (write)
        {
            this.mmWritten.add(index);
        }
        return /** @type {number} */ (this.mmLocals.get(index));
    }

    mmxTouchedLocal(){
        return Local.mmxTouched;
    }

    /** One of the three v128 scratch locals. @param {number} which */
    vecTempLocal(which){
        return Local.vec + which;
    }

    /** The flag locals, in the shape the formulas take. */
    get flagLocals(){
        return {
            kind: Local.kind, res: Local.res, op1: Local.op1, op2: Local.op2, cin: Local.cin,
            flags: Local.flags,
        };
    }

    /** @returns {Translation} */
    emit(){
        const { b } = this;
        this.prologue();
        this.open('out', EMPTY);
        this.openLoop('dispatch');
        const blocks = this.region.blocks;
        for (let i = blocks.length - 1; i >= 0; i--)
        {
            this.open(`b${i}`, EMPTY);
        }
        b.localGet(Local.label);
        b.brTable(blocks.map((block, i)=>i), 0);
        for (let i = 0; i < blocks.length; i++)
        {
            this.close();
            this.emitBlock(blocks[i], i);
        }
        // Falling out of the last block cannot happen: every block ends with
        // explicit control. If it did, the dispatch would loop on the same
        // label forever, so leave instead.
        b.unreachable();
        this.close(); // dispatch
        this.close(); // out
        this.epilogue();
        const functionIndex = this.context.m.function(
            this.context.regionType, this.localTypes, b.toBytes());
        return {
            functionIndex, labels: this.labels, unsupported: this.unsupported,
            refusals: this.refusals,
            instructions: this.instructions,
            cut: new Set([...this.x87.cut, ...this.leaving, ...this.shapedBlocks()]),
            entryTop: this.entryTop, loops: this.loops,
        };
    }

    // --- control structure bookkeeping ---

    /** @param {string} name @param {number} type */
    open(name, type){
        this.controls.push(name);
        this.b.block(type);
    }

    /** @param {string} name */
    openLoop(name){
        this.controls.push(name);
        this.b.loop(EMPTY);
    }

    /** @param {string} name @param {number} type */
    openIf(name, type = EMPTY){
        this.controls.push(name);
        this.b.if(type);
    }

    close(){
        this.controls.pop();
        this.b.end();
    }

    /** The branch depth of an open control by name. @param {string} name */
    depthOf(name){
        const index = this.controls.lastIndexOf(name);
        if (index < 0)
        {
            throw new Error(`emit: no open control "${name}"`);
        }
        return this.controls.length - 1 - index;
    }

    // --- state block access ---

    /** Pushes the guest address of a layout field. @param {number} offset */
    stateAddress(offset){
        this.b.i32const(offset);
    }

    prologue(){
        this.loadState();
        this.resetRun();
    }

    /** The registers, the flags, the vector registers and the x87 block into the locals. */
    loadState(){
        const { b, layout } = this;
        for (let r = 0; r < 8; r++)
        {
            b.i32const(0).load('i32', { offset: layout.regs + r * 4 }).localSet(Local.reg + r);
        }
        b.i32const(0).load('i32', { offset: layout.eflags }).localSet(Local.flags);
        if (layout.flagsChanged >= 0 && this.context.getEflags !== undefined)
        {
            // The other executor keeps some flags lazy: when its record says
            // so, its own fold gives the whole word.
            b.i32const(0).load('i32', { offset: layout.flagsChanged });
            this.openIf('lazy', EMPTY);
            b.call(this.context.getEflags).localSet(Local.flags);
            this.close();
        }
        for (const [index, local] of this.xmmLocals)
        {
            b.i32const(0).loadV128({ offset: layout.xmm + index * 16 }).localSet(local);
        }
        for (const [index, local] of this.mmLocals)
        {
            b.i32const(0).load('i64', { offset: layout.x87 + index * 16 }).localSet(local);
        }
        if (this.x87.active)
        {
            x87Prologue(this);
        }
    }

    /** The run's own locals at their start: no record, nothing retired, nothing touched. */
    resetRun(){
        const { b } = this;
        b.i32const(0).localSet(Local.kind);
        b.i32const(0).localSet(Local.retired);
        b.i32const(0).localSet(Local.mmxTouched);
        b.i32const(0).localSet(Local.stale);
    }

    /** Writes every local back and returns the kind in `t0`. */
    epilogue(){
        this.storeState();
        if (this.context.hash)
        {
            this.transfer();
        }
        this.b.localGet(Local.t0);
    }

    /**
     * Every local back into the state block: the registers, the flags made
     * whole, EIP, the count added to the counter word, the vector registers
     * written, the x87 block. The state block is then the truth, as the
     * host reads it and as `loadState` takes it back.
     */
    storeState(){
        const { b, layout } = this;
        this.materialise();
        for (let r = 0; r < 8; r++)
        {
            b.i32const(0).localGet(Local.reg + r).store('i32', { offset: layout.regs + r * 4 });
        }
        b.i32const(0).localGet(Local.flags).store('i32', { offset: layout.eflags });
        if (layout.flagsChanged >= 0)
        {
            b.i32const(0).i32const(0).store('i32', { offset: layout.flagsChanged });
        }
        b.i32const(0).localGet(Local.eip).store('i32', { offset: layout.eip });
        if (layout.previousIp >= 0)
        {
            b.i32const(0).localGet(Local.eip).store('i32', { offset: layout.previousIp });
        }
        b.i32const(0);
        b.i32const(0).load('i32', { offset: layout.counter }).localGet(Local.retired).op(I32.add);
        b.store('i32', { offset: layout.counter });
        for (const index of this.xmmWritten)
        {
            b.i32const(0).localGet(this.xmmLocal(index))
                .storeV128({ offset: layout.xmm + index * 16 });
        }
        if (this.x87.active && this.x87.hasMmx)
        {
            // A region of both classes: the eight registers are one set with two
            // views, reconciled at every write. `x87Epilogue` writes the words
            // (the top, the masks, the status and control); the registers go
            // back from the mantissas the mm locals hold, each in the form --
            // MMX or relaxed double -- its last write left it, which the form
            // mask names. The run's MMX mark is not consulted: the locals the
            // instructions kept are the truth, an `emms` among them.
            x87Epilogue(this);
            this.storeMixedRegisters();
            return;
        }
        for (const index of this.mmWritten)
        {
            b.i32const(0).localGet(this.mmLocal(index))
                .store('i64', { offset: layout.x87 + index * 16 });
            if (layout.x87Format === 'tagged80')
            {
                // An MMX write leaves the register's exponent all ones, as the
                // processor does, so the emulator sees it as it would its own.
                b.i32const(0).i32const(0xffff)
                    .store('i32_16', { offset: layout.x87 + index * 16 + 8 });
            }
        }
        if (this.x87.active)
        {
            x87Epilogue(this);
        }
        if (this.mmLocals.size > 0)
        {
            // An MMX instruction ran: the x87 stack's top is zero and every
            // register is held, as on the processor. The two are written
            // apart, because an `emms` after them releases the hold -- it
            // wrote the empty mask itself -- and leaves the top at the zero
            // the first of them set.
            b.localGet(Local.mmxTouched).i32const(MMX_TOP).op(I32.and);
            b.if(EMPTY);
            b.i32const(0).i32const(0).store('i32_8', { offset: layout.x87Top });
            b.end();
            b.localGet(Local.mmxTouched).i32const(MMX_HELD).op(I32.and);
            b.if(EMPTY);
            b.i32const(0).i32const(0).store('i32_8', { offset: layout.x87Empty });
            b.end();
        }
    }

    /**
     * The eight registers of a region that translated both classes, back into
     * the state block from the mantissas the mm locals hold. A register written
     * by either class is stored; the form mask says which tag it takes, the all
     * ones an MMX write left or the relaxed double an x87 write left, so the
     * emulator reads each back as the view that wrote it last. The mantissa is
     * the mm local's whichever class wrote it: an x87 write kept the mm local
     * equal to the double's bits, an MMX write to the value it stored.
     */
    storeMixedRegisters(){
        const { b, layout } = this;
        const x = this.x87;
        for (let p = 0; p < 8; p++)
        {
            const at = layout.x87 + p * 16;
            const mm = /** @type {number} */ (this.mmLocals.get(p));
            // An MMX write is unconditional (its local is the mantissa); an x87
            // one is under the dirty mask, which the register's own writes set.
            const unconditional = this.mmWritten.has(p);
            if (!unconditional)
            {
                b.localGet(Local.x87Dirty).i32const(1 << p).op(I32.and);
                this.openIf(`mixed${p}`, EMPTY);
            }
            b.i32const(0).localGet(mm).store('i64', { offset: at });
            if (layout.x87Format === 'tagged80')
            {
                b.i32const(0);
                b.i32const(0xffff);
                b.i32const(0x7ffe);
                b.localGet(x.form).i32const(1 << p).op(I32.and);
                b.select();
                b.store('i32_16', { offset: at + 8 });
            }
            if (!unconditional)
            {
                this.close();
            }
        }
    }


    /**
     * An untranslated exit with budget left probes the entry hash for the
     * address it leaves at and, on a slot compiled for this x87 top or for
     * any, tail-calls that region's function with the label and the budget
     * that remains: a return, an indirect jump or a call into translated
     * code costs no crossing. The state block is complete at this point,
     * so the callee's prologue reads what this epilogue wrote. A miss
     * (an empty slot met) leaves as before.
     */
    transfer(){
        const { b, layout } = this;
        const base = layout.tables + Tables.HASH;
        b.localGet(Local.t0).i32const(Exit.UNTRANSLATED).op(I32.eq)
            .localGet(Local.budget).i32const(0).op(I32.gtS).op(I32.and);
        this.openIf('lookup');
        b.localGet(Local.eip).i32const(0x9e3779b1 | 0).op(I32.mul).i32const(16).op(I32.shrU)
            .localSet(Local.t1);
        this.openLoop('probe');
        b.localGet(Local.t1).i32const(Tables.HASH_SLOT).op(I32.mul).i32const(base).op(I32.add)
            .localSet(Local.t2);
        b.localGet(Local.t2).load('i32').localTee(Local.addr).localGet(Local.eip).op(I32.eq);
        this.openIf('hit');
        b.localGet(Local.t2).load('i32_8u', { offset: 10 }).localTee(Local.addr)
            .i32const(ANY_TOP).op(I32.eq);
        b.localGet(Local.addr).i32const(0).load('i32_8u', { offset: layout.x87Top }).op(I32.eq);
        b.op(I32.or);
        this.openIf('top');
        b.localGet(Local.t2).load('i32_16u', { offset: 8 });
        b.localGet(Local.budget);
        b.localGet(Local.t2).load('i32', { offset: 4 });
        b.returnCallIndirect(this.context.regionType, 0);
        this.close();
        b.localGet(Local.t2).load('i32').localSet(Local.addr);
        this.close();
        b.localGet(Local.addr).op(I32.eqz);
        b.brIf(this.depthOf('lookup'));
        b.localGet(Local.t1).i32const(1).op(I32.add).i32const(Tables.HASH_SLOTS - 1).op(I32.and)
            .localSet(Local.t1);
        b.br(this.depthOf('probe'));
        this.close();
        this.close();
    }

    // --- flags ---

    /**
     * Folds the record into the flags word, unless the word is known to be
     * whole already. Afterwards the record is EAGER.
     */
    materialise(){
        if (this.pending && this.pending.kind === Kind.EAGER)
        {
            return;
        }
        const { b } = this;
        b.localGet(Local.kind).localGet(Local.res).localGet(Local.op1).localGet(Local.op2)
            .localGet(Local.cin).localGet(Local.flags);
        b.call(this.context.materialise);
        b.localSet(Local.flags);
        b.i32const(0).localSet(Local.kind);
        this.pending = { kind: Kind.EAGER, width: 2 };
    }

    /**
     * Pushes 0/1 for a flag, from the record when its kind is known here and
     * from the word otherwise.
     *
     * @param {number} flag
     */
    pushFlag(flag){
        if (this.pending === null)
        {
            this.materialise();
        }
        const { kind, width } = /** @type {{ kind: number, width: number }} */ (this.pending);
        emitFlag(this.b, this.flagLocals, kind, width, flag);
    }

    /** Pushes 0/1 for a condition code. @param {number} cc */
    pushCondition(cc){
        if (this.pending === null)
        {
            this.materialise();
        }
        const { kind, width } = /** @type {{ kind: number, width: number }} */ (this.pending);
        emitCondition(this.b, this.flagLocals, kind, width, cc);
    }

    /**
     * Records a lazy write: the result is on the stack and is left there,
     * op1 and op2 were set by the caller.
     *
     * @param {number} kind  an unfolded Kind
     * @param {number} size
     */
    record(kind, size){
        this.b.localTee(Local.res);
        this.b.i32const(kindOf(kind, size)).localSet(Local.kind);
        this.pending = { kind, width: widthCode(size) };
    }

    /**
     * Prepares for an eager write of some flags: the word is made whole and
     * the bits named are cleared, so the caller ors its values in.
     *
     * @param {number} mask
     */
    eagerWrite(mask){
        this.materialise();
        this.b.localGet(Local.flags).i32const(~mask).op(I32.and).localSet(Local.flags);
    }

    /** Ors a 0/1 on the stack into the word as `flag`. @param {number} flag */
    orFlag(flag){
        this.b.i32const(flag).op(0x6c).localGet(Local.flags).op(I32.or).localSet(Local.flags);
    }

    // --- blocks and exits ---

    /**
     * The ways control arrives at a block, for the refusal diagnostics: the
     * entry of the region, the fall-through of a preceding block, a branch's
     * target, a call's return address, or (no in-region edge at all) an
     * address only the runtime enters -- an indirect target.
     *
     * @param {number} index
     */
    entryKinds(index){
        const { region } = this;
        const block = region.blocks[index];
        const kinds = [];
        if (block.start === region.entry)
        {
            kinds.push('region-entry');
        }
        let returns = false;
        let falls = false;
        let branch = false;
        for (let i = 0; i < region.blocks.length; i++)
        {
            if (i === index)
            {
                continue;
            }
            const exit = region.blocks[i].exit;
            if (exit.next === block.start && (exit.kind === 'call' || exit.kind === 'trap'))
            {
                returns = true;
            }
            else if (exit.next === block.start
                && (exit.kind === 'fallthrough' || exit.kind === 'jcc' || exit.kind === 'loop'))
            {
                falls = true;
            }
            if (exit.targets.includes(block.start))
            {
                branch = true;
            }
        }
        if (returns)
        {
            kinds.push('call-return');
        }
        if (falls)
        {
            kinds.push('fall-through');
        }
        if (branch)
        {
            kinds.push('branch-target');
        }
        if (kinds.length === 0)
        {
            kinds.push('indirect-target');
        }
        return kinds.join('+');
    }

    /** Whether the region's entry block had a known x87 state. */
    entryBlockKnown(){
        if (!this.x87.active)
        {
            return true;
        }
        const at = this.region.blocks.findIndex(block=>block.start === this.region.entry);
        return at >= 0 && this.x87.states[at] !== null;
    }

    /**
     * Records one left-out instruction, why and the shape of its block.
     *
     * @param {import('../decode/decoder.js').Instruction} instruction
     * @param {string} reason
     * @param {number} index
     */
    noteRefusal(instruction, reason, index){
        const key = `${instruction.opcode} (${reason}; ${this.entryKinds(index)}; `
            + `entry-${this.entryBlockKnown() ? 'known' : 'unknown'})`;
        this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1);
    }

    /**
     * @param {import('../region.js').Block} block
     * @param {number} index
     */
    emitBlock(block, index){
        this.pending = null;
        this.dead = false;
        this.blockRetired = 0;
        this.blockDepth = this.controls.length;
        this.blockIndex = index;
        if (block.instructions.length === 0)
        {
            this.leaving.add(index);
        }
        if (this.x87.active && !x87BlockStart(this, index))
        {
            // Reached with two different x87 tops: the other executor runs it.
            const first = block.instructions.find(instruction=>isX87(instruction))
                ?? block.instructions[0];
            if (first)
            {
                this.noteRefusal(first, 'cut-second-top', index);
            }
            this.exitAt(block.start, Exit.UNTRANSLATED);
            return;
        }
        // A block whose conditional branch comes back to its own start -- the
        // shape of most inner loops -- is a wasm loop with a direct branch
        // on the back edge, sparing the dispatcher's round trip each time.
        // With x87 in play, only when the block ends in the state it starts
        // in, so the edge needs no moves.
        const x = this.x87;
        this.selfLoop = (block.exit.kind === 'jcc' || block.exit.kind === 'loop')
            && block.exit.targets[0] === block.start && block.instructions.length > 0
            && (!x.active || (x.states[index] !== null && x.ends[index] !== null
                && sameState(x.states[index], x.ends[index])));
        if (this.selfLoop)
        {
            this.openLoop(`self${index}`);
            this.loops++;
            // The loop is the block's own level: a charge at it settles the
            // block's count, so the budget exit inside it charges nothing twice.
            this.blockDepth = this.controls.length;
        }
        const live = deadFlagPass(block);
        for (let i = 0; i < block.instructions.length; i++)
        {
            const instruction = block.instructions[i];
            const flagsLive = live[i];
            this.current = instruction;
            this.staleCheck = false;
            this.x87RefusalReason = null;
            // Counted before it is emitted, so an exit *after* it (a halt, a
            // call) has it charged; an exit *before* it uncounts it.
            this.blockRetired++;
            this.instructions++;
            const done = emitInstruction(this, instruction, flagsLive);
            if (!done)
            {
                this.unsupported.set(instruction.opcode,
                    (this.unsupported.get(instruction.opcode) ?? 0) + 1);
                this.noteRefusal(instruction, this.x87RefusalReason ?? 'no-lowering', index);
                this.instructions--;
                this.exitBefore(instruction.eip, Exit.UNTRANSLATED);
                this.dead = true;
                this.closeSelfLoop();
                return;
            }
            if (this.dead)
            {
                this.closeSelfLoop();
                return;
            }
            if (this.staleCheck)
            {
                // A store into a code page: leave now, before running what it
                // may have changed, with EIP at the next instruction.
                this.staleCheck = false;
                emitStaleExit(this, instruction.eip + instruction.length);
            }
        }
        this.emitExit(block, index);
        this.closeSelfLoop();
    }

    /**
     * Blocks compiled for the x87 stack in another shape than the region's
     * entry: another top, or registers exchanged. Reached from inside the
     * region the edge brings the stack into that shape; entered from outside
     * the machine's stack is the entry's, and the block would push, pop and
     * write the top back for a stack it does not have. No entry for them.
     */
    shapedBlocks(){
        const x = this.x87;
        if (!x.active)
        {
            return [];
        }
        // The entry's block by its address: it is the first in address order
        // only when nothing the region reaches lies below it.
        const at = this.region.blocks.findIndex(block=>block.start === this.region.entry);
        const entry = x.states[at];
        if (entry === undefined)
        {
            return [];
        }
        return x.states.flatMap((state, index)=>
            index !== at && state !== null
                && (entry === null || !sameState(state, entry)) ? [index] : []);
    }

    /** Closes the block's loop onto itself, when it is one. */
    closeSelfLoop(){
        if (this.selfLoop)
        {
            this.close();
            this.selfLoop = false;
        }
    }

    /**
     * Charges the block's instructions so far to the budget and the count.
     * On a conditional path (inside an `if` the block opened) the count stays
     * owed: the path that falls through charges it at its own exit.
     */
    charge(){
        if (this.blockRetired === 0)
        {
            return;
        }
        const { b } = this;
        b.localGet(Local.retired).i32const(this.blockRetired).op(I32.add).localSet(Local.retired);
        b.localGet(Local.budget).i32const(this.blockRetired).op(I32.sub).localSet(Local.budget);
        if (this.controls.length === this.blockDepth)
        {
            this.blockRetired = 0;
        }
    }

    /**
     * @param {import('../region.js').Block} block
     * @param {number} index
     */
    emitExit(block, index){
        const { exit } = block;
        const next = this.region.blocks[index + 1];
        switch (exit.kind)
        {
            case 'fallthrough':
                this.charge();
                if (next && next.start === exit.targets[0])
                {
                    return;
                }
                this.jumpTo(exit.targets[0]);
                return;
            case 'jump':
                this.charge();
                this.jumpTo(exit.targets[0]);
                return;
            case 'jcc':
            case 'loop':
            {
                const [taken, notTaken] = exit.targets;
                const last = block.instructions[block.instructions.length - 1];
                this.charge();
                if (this.selfLoop)
                {
                    // The back edge directly: on the taken edge, and only
                    // there, the budget looked at as any jump does -- a
                    // leave before the decision would have the next run
                    // repeat the body past a fall-through it never took.
                    this.pushBranchCondition(last);
                    this.openIf('taken');
                    this.b.localGet(Local.budget).i32const(0).op(I32.leS);
                    this.openIf('spent');
                    this.exitAt(block.start, Exit.BUDGET);
                    this.close();
                    this.b.br(this.depthOf(`self${index}`));
                    this.close();
                    this.closeSelfLoop();
                    if (next && next.start === notTaken)
                    {
                        return;
                    }
                    this.jumpTo(notTaken);
                    return;
                }
                this.pushBranchCondition(last);
                this.openIf('taken');
                this.jumpTo(taken);
                this.close();
                if (next && next.start === notTaken)
                {
                    return;
                }
                this.jumpTo(notTaken);
                return;
            }
            case 'cut':
            case 'refused':
                this.charge();
                this.exitAt(exit.next, Exit.UNTRANSLATED);
                return;
            case 'trap':
                if (this.trapped)
                {
                    // The call channel was called from here and the program
                    // went on: the block after the port write follows.
                    this.trapped = false;
                    this.charge();
                    this.jumpTo(exit.next);
                    return;
                }
                if (!this.dead)
                {
                    this.charge();
                    this.exitAt(exit.next, Exit.UNTRANSLATED);
                }
                return;
            default:
                // ret, indirect, call, hlt, fault: the instruction's own
                // emission already left the function.
                if (!this.dead)
                {
                    this.charge();
                    this.exitAt(exit.next, Exit.UNTRANSLATED);
                }
        }
    }

    /**
     * Pushes 0/1: whether the block's last instruction branches.
     *
     * @param {import('../decode/decoder.js').Instruction} instruction
     */
    pushBranchCondition(instruction){
        const { b } = this;
        const { op } = instruction;
        if (instruction.cc !== undefined)
        {
            this.pushCondition(instruction.cc);
            return;
        }
        // loop / loope / loopne / jecxz on ecx (cx under an address-size prefix)
        const wide = !instruction.prefixes.address;
        const pushCount = ()=>{
            b.localGet(Local.reg + 1);
            if (!wide)
            {
                b.i32const(0xffff).op(I32.and);
            }
        };
        if (op === 'jecxz')
        {
            pushCount();
            b.op(I32.eqz);
            return;
        }
        // The decrement happened in the instruction's own emission.
        pushCount();
        b.i32const(0).op(I32.ne);
        if (op === 'loope' || op === 'loopne')
        {
            this.pushFlag(0x40);
            if (op === 'loopne')
            {
                b.op(I32.eqz);
            }
            b.op(I32.and);
        }
    }

    /**
     * Continues at another address: through the dispatch loop when the
     * address starts a block of this region, out of the function otherwise.
     *
     * @param {number} target
     */
    jumpTo(target){
        const { b } = this;
        const label = this.labels.get(target);
        if (label === undefined)
        {
            this.exitAt(target, Exit.UNTRANSLATED);
            return;
        }
        if (this.x87.active)
        {
            x87Edge(this, label);
        }
        // The budget is checked on every jump through the dispatch: only a
        // backward edge can make a loop, but a forward one costs the same
        // three operations and needs no analysis to tell apart.
        b.localGet(Local.budget).i32const(0).op(I32.leS);
        this.openIf('spent');
        this.exitAt(target, Exit.BUDGET);
        this.close();
        b.i32const(label).localSet(Local.label);
        b.br(this.depthOf('dispatch'));
    }

    /**
     * Leaves the function with the state block complete: EIP as given, the
     * kind as given. The epilogue after `$out` does the writing back.
     *
     * @param {number} eip
     * @param {number} kind
     * @param {number} [vector]
     */
    exitAt(eip, kind, vector = 0){
        this.charge();
        this.b.i32const(eip).localSet(Local.eip);
        this.exitWithKind(kind, vector);
    }

    /**
     * Leaves before the current instruction runs: it is uncounted, EIP is
     * its own address, the state is as it was before it.
     *
     * @param {number} eip @param {number} kind @param {number} [vector]
     */
    exitBefore(eip, kind, vector = 0){
        if (kind === Exit.UNTRANSLATED && this.blockRetired === 1)
        {
            // The block's first instruction is the other executor's: the
            // block retires nothing, so it must not be an entry (see
            // `leaving`). Every untranslated exit before an instruction is
            // unconditional; a fault's is not, and a block that may fault
            // first still runs when it does not.
            this.leaving.add(this.blockIndex);
        }
        this.blockRetired--;
        this.exitAt(eip, kind, vector);
        this.blockRetired++;
    }

    /**
     * As `exitAt`, with EIP already in the `eip` local.
     * @param {number} kind @param {number} [vector]
     */
    exitDynamic(kind, vector = 0){
        this.charge();
        this.exitWithKind(kind, vector);
    }

    /** @param {number} kind @param {number} vector */
    exitWithKind(kind, vector){
        if (this.x87.active)
        {
            x87Normalise(this);
        }
        if (this.staleCheck)
        {
            // The instruction stored and leaves in the same breath (a call):
            // a store into a code page turns the exit into `stale`, the EIP
            // being the one the exit set.
            this.b.i32const(Exit.STALE).i32const(kind | vector << 8).localGet(Local.stale)
                .op(0x1b).localSet(Local.t0);
        }
        else
        {
            this.b.i32const(kind | vector << 8).localSet(Local.t0);
        }
        this.b.br(this.depthOf('out'));
    }
}

/**
 * Which instructions of a block need their flag record: an instruction's
 * flags are needed when some flag it writes is read before the next
 * instruction that writes it -- or by whatever follows the block, which is
 * assumed to read everything.
 *
 * @param {import('../region.js').Block} block
 * @returns {boolean[]}  per instruction: whether its written flags are live
 */
export function deadFlagPass(block){
    const live = new Array(block.instructions.length).fill(true);
    let liveAfter = ARITH_FLAGS | DF;
    for (let i = block.instructions.length - 1; i >= 0; i--)
    {
        const instruction = block.instructions[i];
        // A shift or rotate by a count of zero writes no flag at all; by a
        // count in cl it may or may not, so it kills nothing an earlier
        // record holds, though its own writes are live when read later.
        const count = shiftCount(instruction);
        if (count === 0)
        {
            live[i] = false;
            continue;
        }
        // Only a defined write kills a flag: an instruction leaves its undefined
        // flags as they were (the model and the emitter agree on that), so an
        // earlier record may still be what a later reader sees.
        const written = count === -1 ? 0 : instruction.flagsWritten & ~instruction.flagsUndefined;
        live[i] = ((instruction.flagsWritten | instruction.flagsUndefined) & liveAfter) !== 0;
        liveAfter = (liveAfter & ~written) | instruction.flagsRead;
    }
    return live;
}

const SHIFT_OPS = new Set(['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar', 'shld', 'shrd']);

/**
 * The count of a shift or rotate masked to five bits, -1 when it is in cl,
 * null for any other instruction.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
function shiftCount(instruction){
    if (!SHIFT_OPS.has(instruction.op))
    {
        return null;
    }
    const count = instruction.operands[instruction.operands.length - 1];
    return count.kind === 'imm' ? (/** @type {number} */ (count.value) & 31) : -1;
}

export { CF, OF, ARITH, EMPTY };
