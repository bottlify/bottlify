/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter's fast path: a decoded instruction of the common integer
 * kinds turned once into a function of the state, its operands resolved to
 * register indices, constants and address arithmetic, and kept with the
 * decoded instruction. `evaluate` builds its operand closures on every step
 * and classifies the instruction by a regular expression each time, which put
 * the interpreter at three hundred nanoseconds an instruction; a compiled one
 * runs the same arithmetic and flags (the same `addFlags`, `subFlags`,
 * `logicFlags` and `condition`) with none of that. Anything not compiled here
 * -- x87, SSE, strings, the rest -- answers null and runs through `evaluate`.
 */

import { AF, CF, OF, PF, SF, ZF } from './decode/table.js';
import { MASK, addFlags, condition, logicFlags, subFlags } from './ir.js';

const ARITH = CF | PF | AF | ZF | SF | OF;

/** @typedef {import('./ir.js').EvalState} EvalState */
/** @typedef {import('./decode/decoder.js').Instruction} Instruction */
/** @typedef {import('./decode/decoder.js').Operand} Operand */
/** @typedef {(state: EvalState) => void} Step */

/**
 * The address of a memory operand, as a function of the state.
 *
 * @param {Operand} operand
 * @returns {((state: EvalState) => number) | null}
 */
function addressOf(operand){
    if (operand.addressSize === 16 || operand.segment === 4)
    {
        // The rare forms keep `evaluate`: a 16-bit address, an fs: operand.
        return null;
    }
    const disp = operand.disp ?? 0;
    const base = operand.base ?? -1;
    const index = operand.index ?? -1;
    const scale = operand.scale ?? 1;
    if (base >= 0 && index >= 0)
    {
        return state=>(disp + state.reg[base] + state.reg[index] * scale) >>> 0;
    }
    if (base >= 0)
    {
        return state=>(disp + state.reg[base]) >>> 0;
    }
    if (index >= 0)
    {
        return state=>(disp + state.reg[index] * scale) >>> 0;
    }
    const at = disp >>> 0;
    return ()=>at;
}

/**
 * Reads an operand, as a function of the state.
 *
 * @param {Operand} operand
 * @returns {((state: EvalState) => number) | null}
 */
function reader(operand){
    switch (operand.kind)
    {
        case 'reg':
        {
            const r = /** @type {number} */ (operand.reg);
            if (operand.size === 4)
            {
                return state=>state.reg[r];
            }
            if (operand.size === 2)
            {
                return state=>state.reg[r] & 0xffff;
            }
            return operand.high ? state=>state.reg[r] >>> 8 & 0xff : state=>state.reg[r] & 0xff;
        }
        case 'imm':
        {
            const value = /** @type {number} */ (operand.value) >>> 0;
            return ()=>value;
        }
        case 'mem':
        {
            const address = addressOf(operand);
            if (address === null)
            {
                return null;
            }
            const size = operand.size;
            return state=>state.memory.read(address(state), size);
        }
        default:
            return null;
    }
}

/**
 * Writes an operand, as a function of the state and the value.
 *
 * @param {Operand} operand
 * @returns {((state: EvalState, value: number) => void) | null}
 */
function writer(operand){
    switch (operand.kind)
    {
        case 'reg':
        {
            const r = /** @type {number} */ (operand.reg);
            if (operand.size === 4)
            {
                return (state, value)=>{
                    state.reg[r] = value >>> 0;
                };
            }
            if (operand.size === 2)
            {
                return (state, value)=>{
                    state.reg[r] = (state.reg[r] & 0xffff0000 | value & 0xffff) >>> 0;
                };
            }
            return operand.high
                ? (state, value)=>{
                    state.reg[r] = (state.reg[r] & 0xffff00ff | (value & 0xff) << 8) >>> 0;
                }
                : (state, value)=>{
                    state.reg[r] = (state.reg[r] & 0xffffff00 | value & 0xff) >>> 0;
                };
        }
        case 'mem':
        {
            const address = addressOf(operand);
            if (address === null)
            {
                return null;
            }
            const size = operand.size;
            const mask = MASK[size];
            return (state, value)=>state.memory.write(address(state), size, value & mask);
        }
        default:
            return null;
    }
}

/**
 * The compiled step of an instruction, or null to leave it to `evaluate`.
 *
 * @param {Instruction} instruction
 * @returns {Step | null}
 */
export function compileFast(instruction){
    const body = compileBody(instruction);
    if (body === null)
    {
        return null;
    }
    const next = (instruction.eip + instruction.length) >>> 0;
    return state=>{
        state.eip = next;
        state.retired++;
        body(state);
    };
}

/**
 * The instruction's own work, after EIP and the count have moved.
 *
 * @param {Instruction} instruction
 * @returns {Step | null}
 */
function compileBody(instruction){
    const { op, operands, size } = instruction;
    const mask = MASK[size] ?? 0xffffffff;
    const written = (instruction.flagsWritten & ~instruction.flagsUndefined) >>> 0;
    /** @param {EvalState} state @param {number} flags @param {number} bits */
    const setFlags = (state, flags, bits)=>{
        state.eflags = (state.eflags & ~bits | flags & bits) >>> 0;
    };
    const [dst, src] = operands;
    switch (op)
    {
        case 'nop':
            return ()=>{};
        case 'mov':
        case 'movzx':
        {
            if (op === 'mov' && (dst.kind === 'seg' || src.kind === 'seg'))
            {
                return null;
            }
            const read = reader(src);
            const write = writer(dst);
            return read && write && (state=>write(state, read(state)));
        }
        case 'movsx':
        {
            const read = reader(src);
            const write = writer(dst);
            const shift = 32 - src.size * 8;
            return read && write && (state=>write(state, (read(state) << shift >> shift) >>> 0));
        }
        case 'lea':
        {
            const address = src.kind === 'mem' ? addressOf(src) : null;
            const write = writer(dst);
            return address && write && (state=>write(state, address(state) & mask));
        }
        case 'add': case 'sub': case 'cmp': case 'adc': case 'sbb':
        {
            const readA = reader(dst);
            const readB = reader(src);
            const write = op === 'cmp' ? null : writer(dst);
            if (!readA || !readB || (op !== 'cmp' && !write))
            {
                return null;
            }
            const carrying = op === 'adc' || op === 'sbb';
            const adding = op === 'add' || op === 'adc';
            return state=>{
                const carry = carrying ? state.eflags & CF : 0;
                const { result, flags } = adding
                    ? addFlags(readA(state), readB(state), carry, size)
                    : subFlags(readA(state), readB(state), carry, size);
                if (write)
                {
                    write(state, result);
                }
                setFlags(state, flags, written);
            };
        }
        case 'and': case 'or': case 'xor': case 'test':
        {
            const readA = reader(dst);
            const readB = reader(src);
            const write = op === 'test' ? null : writer(dst);
            if (!readA || !readB || (op !== 'test' && !write))
            {
                return null;
            }
            return state=>{
                const a = readA(state);
                const b = readB(state);
                const mixed = op === 'and' || op === 'test' ? a & b : op === 'or' ? a | b : a ^ b;
                const result = (mixed & mask) >>> 0;
                if (write)
                {
                    write(state, result);
                }
                setFlags(state, logicFlags(result, size), ARITH);
            };
        }
        case 'inc': case 'dec':
        {
            const read = reader(dst);
            const write = writer(dst);
            if (!read || !write)
            {
                return null;
            }
            const adding = op === 'inc';
            return state=>{
                const { result, flags } = adding
                    ? addFlags(read(state), 1, 0, size)
                    : subFlags(read(state), 1, 0, size);
                write(state, result);
                setFlags(state, flags, written);
            };
        }
        case 'not':
        {
            const read = reader(dst);
            const write = writer(dst);
            return read && write && (state=>write(state, (~read(state) & mask) >>> 0));
        }
        case 'neg':
        {
            const read = reader(dst);
            const write = writer(dst);
            if (!read || !write)
            {
                return null;
            }
            return state=>{
                const { result, flags } = subFlags(0, read(state), 0, size);
                write(state, result);
                setFlags(state, flags, written);
            };
        }
        case 'push':
        {
            // Four-byte pushes; `push esp` pushes the value before the decrement.
            if (dst.kind === 'seg' || (dst.kind !== 'imm' && dst.size !== 4) || size !== 4)
            {
                return null;
            }
            const read = reader(dst);
            return read && (state=>{
                const value = read(state);
                state.reg[4] = (state.reg[4] - 4) >>> 0;
                state.memory.write(state.reg[4], 4, value >>> 0);
            });
        }
        case 'pop':
        {
            if (dst.kind !== 'reg' || dst.size !== 4)
            {
                return null;
            }
            const r = /** @type {number} */ (dst.reg);
            return state=>{
                const value = state.memory.read(state.reg[4], 4);
                state.reg[4] = (state.reg[4] + 4) >>> 0;
                state.reg[r] = value >>> 0;
            };
        }
        case 'jmp':
        {
            if (dst.kind === 'rel')
            {
                const target = /** @type {number} */ (dst.target);
                return state=>{
                    state.eip = target;
                };
            }
            const read = reader(dst);
            return read && (state=>{
                state.eip = read(state);
            });
        }
        case 'call':
        {
            const next = (instruction.eip + instruction.length) >>> 0;
            // The target is read before the return address is pushed (a
            // memory operand relative to ESP names the caller's slot).
            const read = dst.kind === 'rel' ? null : reader(dst);
            if (dst.kind !== 'rel' && !read)
            {
                return null;
            }
            const fixed = dst.kind === 'rel' ? /** @type {number} */ (dst.target) : 0;
            return state=>{
                const target = read ? read(state) : fixed;
                state.reg[4] = (state.reg[4] - 4) >>> 0;
                state.memory.write(state.reg[4], 4, next);
                state.eip = target;
            };
        }
        case 'ret':
        {
            const extra = operands.length === 1 ? /** @type {number} */ (dst.value) : 0;
            return state=>{
                state.eip = state.memory.read(state.reg[4], 4);
                state.reg[4] = (state.reg[4] + 4 + extra) >>> 0;
            };
        }
        case 'leave':
            if (size !== 4)
            {
                return null;
            }
            return state=>{
                state.reg[4] = state.reg[5];
                const value = state.memory.read(state.reg[4], 4);
                state.reg[4] = (state.reg[4] + 4) >>> 0;
                state.reg[5] = value >>> 0;
            };
        default:
        {
            const cc = instruction.cc;
            if (cc === undefined)
            {
                return null;
            }
            if (op.startsWith('j') && dst.kind === 'rel')
            {
                const target = /** @type {number} */ (dst.target);
                return state=>{
                    if (condition(cc, state.eflags))
                    {
                        state.eip = target;
                    }
                };
            }
            if (op.startsWith('set'))
            {
                const write = writer(dst);
                return write && (state=>write(state, condition(cc, state.eflags) ? 1 : 0));
            }
            if (op.startsWith('cmov'))
            {
                const read = reader(src);
                const write = writer(dst);
                return read && write && (state=>{
                    // The source is read even when the move is not made.
                    const value = read(state);
                    if (condition(cc, state.eflags))
                    {
                        write(state, value);
                    }
                });
            }
            return null;
        }
    }
}
