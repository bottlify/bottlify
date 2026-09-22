/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter tier (plan step 5.2): cork's decoder of 2.1 and evaluator of
 * 2.2, run over the state block one instruction at a time. It is the tier for
 * the instruction met once -- cold code, a refused instruction, a volatile
 * page -- where translating a whole region would cost more than running it.
 *
 * The evaluator's integer set is here. The x87, MMX and SSE operations the
 * emitter has and `ir.js` lacks are the remaining work of this step; an
 * instruction with no model throws `Unsupported`, which the host answers with
 * `cpu: cork has no tier for …` and hands to the other executor, as a refused
 * instruction is handled under hybrid.
 */

import { decode } from './decode/decoder.js';
import { Unsupported, createState, evaluate } from './ir.js';

export { Unsupported, createState };

/**
 * Runs instructions from `state.eip` until the budget is spent or the machine
 * halts, answering how many were retired.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {number} [maxInstructions]
 * @returns {number}
 */
export function interpret(state, maxInstructions = 1){
    const before = state.retired;
    while (state.retired - before < maxInstructions && !state.halted)
    {
        const decoded = decode(address=>state.memory.read(address, 1), state.eip);
        if ('refused' in decoded)
        {
            throw new Unsupported(decoded.opcode);
        }
        evaluate(decoded, state);
    }
    return state.retired - before;
}

/**
 * An `EvalState` whose registers, flags, eip and fsBase are cork's own state
 * block's, so a program the interpreter runs leaves the same state the
 * translator would. The memory is cork's own RAM.
 *
 * @param {{ memory: WebAssembly.Memory,
 *     layout: import('../../core/src/layers/cpu/engine.js').StateLayout }} what
 * @returns {import('./ir.js').EvalState}
 */
export function blockState({ memory, layout }){
    const view = new DataView(memory.buffer);
    const reg = new Uint32Array(memory.buffer, layout.regs, 8);
    /** @param {number} address @param {number} size */
    const read = (address, size)=>{
        const at = layout.ramBase + address;
        return size === 1 ? view.getUint8(at)
            : size === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
    };
    /** @param {number} address @param {number} size @param {number} value */
    const write = (address, size, value)=>{
        const at = layout.ramBase + address;
        if (size === 1)
        {
            view.setUint8(at, value);
        }
        else if (size === 2)
        {
            view.setUint16(at, value, true);
        }
        else
        {
            view.setUint32(at, value, true);
        }
    };
    return {
        reg,
        memory: { read, write },
        halted: false,
        retired: 0,
        trapped: [],
        get eip(){
            return view.getUint32(layout.eip, true);
        },
        set eip(value){
            view.setUint32(layout.eip, value >>> 0, true);
        },
        get eflags(){
            return view.getUint32(layout.eflags, true);
        },
        set eflags(value){
            view.setUint32(layout.eflags, value >>> 0, true);
        },
        get fsBase(){
            return layout.fsBase >= 0 ? view.getUint32(layout.fsBase, true) : 0;
        },
        set fsBase(value){
            if (layout.fsBase >= 0)
            {
                view.setUint32(layout.fsBase, value >>> 0, true);
            }
        },
    };
}
