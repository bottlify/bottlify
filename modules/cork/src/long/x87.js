/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x87 in a long-mode region: the instruction is the 32-bit model's
 * (`ir-x87.js`), the one the long-mode interpreter runs, called from the
 * region over the unit in the state block rather than left to the
 * interpreter. A region no longer ends before every x87 instruction: in a
 * 64-bit program's code they are a C library's `pow`, `exp` and `long
 * double` arithmetic in the middle of integer code, and a region ending at
 * each cost a return to the host and a step of the interpreter, some five
 * microseconds an instruction. The region places a memory operand itself,
 * with the page checks every access has, so the model reads and writes RAM
 * where the region already found it may; it folds the flags into FL before
 * an instruction that reads or writes them.
 *
 * A run of x87 instructions in a row is one call (`x87Run` in `emit.js`):
 * the unit loaded from the state block and stored back once for all of them,
 * their memory operands' addresses its parameters in order. In a C library's
 * `long double` routine forty instructions stood between two integer ones,
 * each a call and a load and store of the whole unit.
 *
 * The call answers what the run's last instruction leaves outside the unit:
 * the flags word `fcomi` and its kin write, or the status word `fnstsw ax`
 * puts in AX -- the one instruction that does, a run ends at it.
 */

import { evaluateX87, isX87Op } from '../ir-x87.js';

/**
 * The x87 forms a region leaves to the interpreter: the environment and
 * state images, many-byte blocks across pages, and BCD, rare all of them.
 */
const LEFT = new Set(['fnstenv', 'fldenv', 'fnsave', 'frstor', 'fxsave', 'fxrstor', 'fbld',
    'fbstp']);

/** The x87 forms whose memory operand is written. */
const STORES = new Set(['fst', 'fstp', 'fist', 'fistp', 'fisttp', 'fnstcw', 'fnstsw']);

/**
 * Whether a region calls the model for this instruction.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
export function regionX87(instruction){
    return isX87Op(instruction) && !LEFT.has(instruction.op);
}

/** Whether the instruction's memory operand is written. @param {string} op */
export const x87Stores = op=>STORES.has(op);

/**
 * The model behind the regions' `x87` import: runs of instructions registered
 * as the regions are emitted, by number, and the call that runs one.
 *
 * @param {{ memory: WebAssembly.Memory,
 *     layout: import('../../../core/src/layers/cpu/engine.js').StateLayout }} machine
 */
export function createX87Calls({ memory, layout }){
    /** @type {import('../decode/decoder.js').Instruction[][]} */
    const runs = [];
    const words = new Uint32Array(16);
    /** By register, its shadow at the last instruction of a run it was exact after. */
    const lastShadow = new BigInt64Array(8);
    let view = new DataView(memory.buffer);
    const ram = layout.ramBase;
    const unit = layout.x87;
    const exactAt = /** @type {number} */ (layout.x87Exact);
    // A region cannot grow the memory, so the view is made again once a run,
    // where the runner says (`fresh`), and not at every instruction: a shared
    // memory's `buffer` is a new object each time it is asked for.
    const fresh = ()=>{
        if (view.buffer !== memory.buffer || view.byteLength === 0)
        {
            view = new DataView(memory.buffer);
        }
    };
    // The model's view of the unit, made once: the registers as the bits the
    // block holds, the rest copied in and out around each instruction.
    const state = /** @type {import('../ir.js').EvalState} */ (/** @type {unknown} */ ({
        f80: new Float64Array(words.buffer),
        f80bits: new BigInt64Array(words.buffer),
        x87Shadow: new BigInt64Array(8),
        top: 0, empty: 0, status: 0, control: 0, x87Exact: 0, eflags: 0,
        reg: new Uint32Array(8),
        memory: {
            read: (/** @type {number} */ at, /** @type {number} */ size)=>(size === 4
                ? view.getUint32(ram + at, true) : size === 2 ? view.getUint16(ram + at, true)
                    : view.getUint8(ram + at)),
            write: (/** @type {number} */ at, /** @type {number} */ size,
                /** @type {number} */ value)=>
            {
                if (size === 4)
                {
                    view.setUint32(ram + at, value >>> 0, true);
                }
                else if (size === 2)
                {
                    view.setUint16(ram + at, value & 0xffff, true);
                }
                else
                {
                    view.setUint8(ram + at, value & 0xff);
                }
            },
        },
    }));

    return {
        /** The view of the memory made again, at a run's start. */
        fresh,

        /**
         * A number for the run, which the region passes back.
         *
         * @param {import('../decode/decoder.js').Instruction[]} run
         */
        add(run){
            runs.push(run);
            return runs.length - 1;
        },

        /**
         * Runs run `id` over the unit in the state block.
         *
         * @param {number} id @param {number} flags  the flags word, whole
         * @param {...number} addresses  its memory operands', placed, in order
         * @returns {number}  the flags word after it, or with `fnstsw ax` the status word
         */
        call(id, flags, ...addresses){
            const run = runs[id];
            for (let i = 0; i < 8; i++)
            {
                words[i * 2] = view.getUint32(unit + i * 16, true);
                words[i * 2 + 1] = view.getUint32(unit + i * 16 + 4, true);
            }
            state.top = view.getUint8(layout.x87Top) & 7;
            state.empty = view.getUint8(layout.x87Empty);
            state.control = view.getUint16(layout.x87Control, true);
            state.status = view.getUint16(layout.x87Status, true);
            const exactIn = view.getUint8(exactAt);
            state.x87Exact = exactIn;
            for (let i = 0; exactIn >>> i !== 0; i++)
            {
                if ((exactIn >>> i & 1) !== 0)
                {
                    state.x87Shadow[i] = view.getBigInt64(unit + i * 16 + 8, true);
                }
            }
            state.eflags = flags;
            let placed = 0;
            // The registers exact after any instruction of the run, and each
            // one's shadow then: what goes back, as a call an instruction would
            // have left it -- not a shadow an exchange put beside a double since.
            let shadowed = 0;
            for (const instruction of run)
            {
                const address = instruction.operands.some(operand=>operand.kind === 'mem')
                    ? addresses[placed++] : 0;
                if (!evaluateX87(instruction, state, ()=>address))
                {
                    throw new Error(`long x87: no case for ${instruction.op}`);
                }
                const exact = state.x87Exact & 0xff;
                shadowed |= exact;
                for (let i = 0; exact >>> i !== 0; i++)
                {
                    if ((exact >>> i & 1) !== 0)
                    {
                        lastShadow[i] = state.x87Shadow[i];
                    }
                }
            }
            for (let i = 0; i < 8; i++)
            {
                view.setUint32(unit + i * 16, words[i * 2], true);
                view.setUint32(unit + i * 16 + 4, words[i * 2 + 1], true);
            }
            view.setUint8(layout.x87Top, state.top & 7);
            view.setUint8(layout.x87Empty, state.empty & 0xff);
            view.setUint16(layout.x87Control, state.control & 0xffff, true);
            view.setUint16(layout.x87Status, state.status & 0xffff, true);
            view.setUint8(exactAt, state.x87Exact & 0xff);
            for (let i = 0; shadowed >>> i !== 0; i++)
            {
                if ((shadowed >>> i & 1) !== 0)
                {
                    view.setBigInt64(unit + i * 16 + 8, lastShadow[i], true);
                }
            }
            return run[run.length - 1].operands[0]?.kind === 'reg' ? state.reg[0] & 0xffff
                : state.eflags | 0;
        },
    };
}
