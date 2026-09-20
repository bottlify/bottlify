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

/** How a run of translated code came back, as the low byte of the result. */
export const Exit = Object.freeze({
    UNTRANSLATED: 0, BUDGET: 1, TRAP: 2, HALT: 3, FAULT: 4, STALE: 5,
});

/** Local indices every region function shares. */
export const Local = Object.freeze({
    label: 0, budget: 1,
    // 2..9: eax ecx edx ebx esp ebp esi edi
    reg: 2,
    kind: 10, res: 11, op1: 12, op2: 13, cin: 14, flags: 15,
    retired: 16, eip: 17, t0: 18, t1: 19, t2: 20, addr: 21, t64: 22, t64b: 23,
    count: 24,
});
const LOCAL_TYPES = [
    // the eight registers
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32,
    ValType.i32,
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, // kind..flags
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, // retired..addr
    ValType.i64, ValType.i64,
    ValType.i32, // count
];

/**
 * What a module carries that every region function in it uses.
 *
 * @typedef {Object} ModuleContext
 * @property {import('../wasm/encoder.js').ModuleBuilder} m
 * @property {number} regionType       the function type (i32, i32) → i32
 * @property {number} materialise      the flag helper's function index
 * @property {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @property {{ simd: boolean, tailCalls: boolean }} features
 */

/**
 * Prepares a module for region functions: the memory import, the flag
 * helper, the region function type.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ simd: boolean, tailCalls: boolean }} features
 * @param {{ shared?: boolean, maxPages?: number }} [memory]
 * @returns {ModuleContext}
 */
export function prepareModule(m, layout, features, memory = {}){
    m.importMemory('env', 'memory', {
        min: 1, ...(memory.maxPages === undefined ? {} : { max: memory.maxPages }),
        shared: memory.shared ?? false,
    });
    const regionType = m.type({ params: [ValType.i32, ValType.i32], results: [ValType.i32] });
    const materialise = addMaterialiseHelper(m);
    return { m, regionType, materialise, layout, features };
}

/**
 * @typedef {Object} Translation
 * @property {number} functionIndex
 * @property {Map<number, number>} labels     block start eip → label
 * @property {Map<string, number>} unsupported  opcode → instructions the emitter left out
 * @property {number} instructions
 */

/**
 * Adds a region's function to the module.
 *
 * @param {ModuleContext} context
 * @param {import('../region.js').Region} region
 * @returns {Translation}
 */
export function emitRegion(context, region){
    const emitter = new RegionEmitter(context, region);
    return emitter.emit();
}

/** The state the emitter keeps while writing one function. */
export class RegionEmitter {
    /**
     * @param {ModuleContext} context
     * @param {import('../region.js').Region} region
     */
    constructor(context, region){
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
        /** Whether the current block's remaining instructions are unreachable. */
        this.dead = false;
        /** Instructions retired in the current block so far, to charge at its end. */
        this.blockRetired = 0;
        this.instructions = 0;
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
            this.context.regionType, LOCAL_TYPES, b.toBytes());
        return {
            functionIndex, labels: this.labels, unsupported: this.unsupported,
            instructions: this.instructions,
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
        const { b, layout } = this;
        for (let r = 0; r < 8; r++)
        {
            b.i32const(0).load('i32', { offset: layout.regs + r * 4 }).localSet(Local.reg + r);
        }
        b.i32const(0).load('i32', { offset: layout.eflags }).localSet(Local.flags);
        b.i32const(0).localSet(Local.kind);
        b.i32const(0).localSet(Local.retired);
    }

    /** Writes every local back and returns the kind in `t0`. */
    epilogue(){
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
        b.localGet(Local.t0);
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
     * @param {import('../region.js').Block} block
     * @param {number} index
     */
    emitBlock(block, index){
        this.pending = null;
        this.dead = false;
        this.blockRetired = 0;
        const live = deadFlagPass(block);
        for (let i = 0; i < block.instructions.length; i++)
        {
            const instruction = block.instructions[i];
            const flagsLive = live[i];
            // Counted before it is emitted, so an exit *after* it (a halt, a
            // call) has it charged; an exit *before* it uncounts it.
            this.blockRetired++;
            this.instructions++;
            const done = emitInstruction(this, instruction, flagsLive);
            if (!done)
            {
                this.unsupported.set(instruction.opcode,
                    (this.unsupported.get(instruction.opcode) ?? 0) + 1);
                this.instructions--;
                this.exitBefore(instruction.eip, Exit.UNTRANSLATED);
                this.dead = true;
                return;
            }
            if (this.dead)
            {
                return;
            }
        }
        this.emitExit(block, index);
    }

    /** Charges the block's instructions to the budget and the count. */
    charge(){
        if (this.blockRetired === 0)
        {
            return;
        }
        const { b } = this;
        b.localGet(Local.retired).i32const(this.blockRetired).op(I32.add).localSet(Local.retired);
        b.localGet(Local.budget).i32const(this.blockRetired).op(I32.sub).localSet(Local.budget);
        this.blockRetired = 0;
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
            default:
                // ret, indirect, call, trap, hlt, fault: the instruction's own
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
        this.b.i32const(kind | vector << 8).localSet(Local.t0);
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
        // Only a defined write kills a flag: an instruction leaves its undefined
        // flags as they were (the model and the emitter agree on that), so an
        // earlier record may still be what a later reader sees.
        const written = instruction.flagsWritten & ~instruction.flagsUndefined;
        live[i] = ((instruction.flagsWritten | instruction.flagsUndefined) & liveAfter) !== 0;
        liveAfter = (liveAfter & ~written) | instruction.flagsRead;
    }
    return live;
}

export { CF, OF, ARITH, EMPTY };
